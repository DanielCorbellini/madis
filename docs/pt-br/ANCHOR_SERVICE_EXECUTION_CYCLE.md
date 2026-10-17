# `anchor-service` — Ciclo de Execução

O `anchor-service` ([`apps/anchor-service`](../../apps/anchor-service)) é o daemon de longa duração responsável pelo Fluxo 1 da arquitetura (ver [`ARCHITECTURE.md`](ARCHITECTURE.md) §3): periodicamente, ele coleta registros de negócio ainda não ancorados, os revalida, constrói uma Árvore de Merkle, escreve a raiz resultante no contrato inteligente [`MerkleAnchorRegistry`](../../apps/integrity-domain/contracts/MerkleAnchorRegistry.sol) e persiste o lote junto com a prova individual de cada registro. É o **único** componente do sistema que possui uma carteira financiada e escreve na blockchain — o `monitor-service` apenas lê.

Este documento descreve, passo a passo, tudo o que o daemon faz desde a inicialização do processo até seu encerramento: como ele sobe, como agenda seu próprio trabalho, o que exatamente acontece dentro de um único ciclo de execução, e como ele encerra sem perder nem duplicar trabalho.

---

## 1. Ciclo de Vida do Daemon

O `anchor-service` não é um script executado uma única vez — é um processo Node.js de longa duração (`apps/anchor-service/src/index.ts`) com três estágios de ciclo de vida: verificações iniciais de sanidade (_self-checks_), um laço agendado de ciclos de execução, e um encerramento gracioso (_graceful shutdown_).

### 1.1. Verificações Iniciais de Sanidade (_Fail-Fast_)

Antes de agendar qualquer coisa, o processo valida seu próprio ambiente e sua capacidade de se comunicar tanto com o Postgres quanto com a blockchain. Toda verificação é _fail-fast_: se qualquer uma delas falhar, o processo registra o erro e encerra imediatamente, em vez de subir um agendador que nunca conseguiria de fato realizar trabalho útil.

1. **Parsing da configuração** (`src/config.ts`) — toda variável de ambiente obrigatória (`DATABASE_URL`, `RPC_URL`, `ANCHOR_CHAIN_ID`, `ANCHOR_PRIVATE_KEY`) deve estar presente e bem formada; `ANCHOR_PRIVATE_KEY` precisa ser uma string hexadecimal de 32 bytes sintaticamente válida. `CONTRACT_ADDRESS` é opcional — se ausente, o endereço do contrato-alvo é resolvido a partir do registro de deployments por rede já commitado em `packages/contracts-shared`, indexado por `ANCHOR_CHAIN_ID`. Todas as variáveis opcionais de ajuste estão listadas no §6.
2. **Aviso de whitelist vazia** — se `WHITELIST_ADDRESSES` estiver vazia, o processo registra um aviso proeminente (não um erro fatal), pois essa é uma condição _fail-closed_: sem nenhum endereço na whitelist, todo e qualquer registro falhará na validação da Fase 2 e nada jamais será ancorado.
3. **Conectividade com o banco** — um `SELECT 1` contra o pool do Postgres configurado.
4. **Identidade da rede** — o `chainId` do endpoint RPC conectado (via `provider.getNetwork()`) precisa corresponder ao `ANCHOR_CHAIN_ID` configurado, de modo que o daemon nunca possa submeter acidentalmente para a rede errada.
5. **Deployment do contrato** — o endereço de contrato resolvido precisa de fato possuir bytecode naquela rede (`provider.getCode()` não pode retornar `"0x"`).
6. **Propriedade (_ownership_) da carteira** — a carteira derivada de `ANCHOR_PRIVATE_KEY` precisa ser o `owner()` do contrato, já que `addMerkleRoot` é `onlyOwner`. Caso não seja, toda submissão reverteria com `OwnableUnauthorizedAccount` — por isso essa verificação é feita aqui, em vez de ser descoberta apenas no primeiro ciclo real.

Se qualquer uma das etapas 3-6 lançar um erro, tanto o pool do banco quanto o provider da chain são fechados antes do processo encerrar, de modo que uma inicialização falha nunca deixa conexões penduradas. Se todas forem bem-sucedidas, o pool e o provider deliberadamente **não** são fechados — eles permanecem abertos durante todo o ciclo de vida do agendador.

### 1.2. Agendamento

Uma vez que a inicialização é bem-sucedida, `createCycleScheduler` envolve todo o ciclo de execução (§2 abaixo) em um job do [`croner`](https://github.com/Hexagon/croner), configurado com a expressão cron em `ANCHOR_CRON_SCHEDULE` (padrão: `0 */3 * * *`, a cada 3 horas).

A única responsabilidade real do agendador, além de disparar o ciclo no horário certo, é a **proteção contra sobreposição**: a própria opção `protect: true` do croner garante que, se um ciclo ainda estiver em execução quando o próximo disparo agendado chegar, esse disparo é simplesmente ignorado — no máximo um ciclo roda por vez, dentro de um único processo. Essa é deliberadamente a *única* guarda de concorrência; não existe uma flag `isRunning` construída à mão em paralelo, já que o mecanismo do próprio croner já cobre isso, e o mesmo rastreamento de "há um ciclo em andamento" é também o que a sequência de encerramento (§1.3) precisa saber para decidir o que esperar.

(Uma segunda instância independente do daemon rodando concorrentemente — por exemplo, dois containers apontando para o mesmo banco de dados — não é evitada por `protect: true`, já que esse mecanismo protege apenas um único processo. Esse cenário é, em vez disso, tornado seguro por verificações de idempotência dentro do próprio ciclo; ver §3.)

### 1.3. Encerramento Gracioso (_Graceful Shutdown_)

Ao receber `SIGTERM` ou `SIGINT`, o processo não encerra imediatamente:

1. O job do croner é parado (`cron.stop()`) — nenhum novo ciclo começará a partir deste ponto.
2. Uma flag cooperativa de aborto é ativada. O ciclo *atualmente em execução*, se houver, lê essa flag em exatamente um checkpoint (ver Fase 4/5 abaixo) e, se estiver ativada, para de forma limpa em vez de iniciar uma transação na blockchain.
3. Se houver um ciclo em andamento, a sequência de encerramento espera por ele terminar — mas apenas até `SHUTDOWN_GRACE_MS` (padrão: 600.000 ms / 10 minutos, que precisa exceder confortavelmente a mais longa espera de confirmação realista).
4. Se o ciclo em andamento termina dentro do período de tolerância, o pool do banco é fechado e o provider da chain é destruído, e o processo encerra de forma limpa.
5. Se o período de tolerância se esgota primeiro (o ciclo está genuinamente travado — por exemplo, esperando por uma transação que nunca confirmará), o processo encerra abruptamente (_hard-exit_) com um código de saída diferente de zero, em vez de esperar indefinidamente ou arriscar um encerramento parcial sobre um ciclo travado.

O checkpoint cooperativo de aborto é colocado em exatamente um ponto de todo o ciclo: logo após a Fase 4 (persistência) e antes da Fase 5 (submissão). Interromper qualquer fase anterior seria redundante, pois o `stop()` do croner já garante que nenhum *novo* ciclo comece; e qualquer fase posterior (submissão/confirmação) é deliberadamente deixada para rodar até o fim uma vez iniciada, de modo que uma transação nunca é abandonada no meio do caminho — ver Fase 6 para entender por que uma espera de confirmação interrompida ainda é segura.

**SIGTERM durante um trecho intensivo de CPU.** A imagem inicia o serviço com `node --import tsx src/index.ts` (e não com a CLI do `tsx`, que executa um processo-pai supervisor que envia `SIGKILL` a um filho cujo _event loop_ não consegue confirmar um sinal repassado em cerca de 60 ms — código de saída 143, sem caminho gracioso; descoberto no plano E2E, §8). Com um processo `node` simples, um SIGTERM que chegue durante um longo trecho síncrono (a validação de assinaturas da Fase 1 sobre um backlog grande, a construção da Árvore de Merkle) é tratado assim que o _event loop_ volta a ficar livre: `shutdown requested` é registrado, o ciclo segue até o checkpoint entre as Fases 4 e 5, deixa o lote persistido como `pending` e encerra com código 0 — o encerramento leva o tempo restante do trecho, não zero. O override de desenvolvimento ainda usa `tsx watch`, que limita todo encerramento a 5 s.

---

## 2. O Ciclo de Execução

Cada disparo agendado executa exatamente um ciclo de execução, implementado por `runCycle` (`src/cycle.ts`). Um ciclo é uma sequência estrita de oito fases numeradas, de 0 a 7, mais uma guarda entre as Fases 3 e 4 (Fase 3.5). A Fase 0 é uma fase "antes de tudo o mais", não o primeiro passo de construção de um novo lote.

```mermaid
flowchart TD
    Start(["Disparo agendado (croner)"]) --> P0["Fase 0 — Reconciliar lotes em andamento"]
    P0 --> P1["Fase 1 — Varrer registros não ancorados"]
    P1 --> P2["Fase 2 — Revalidar assinatura + whitelist"]
    P2 --> D1{"Algum registro válido?"}
    D1 -- Não --> S1["Fase 7 — Resumo: nothing-to-anchor"]
    D1 -- Sim --> P3["Fase 3 — Construir Árvore de Merkle"]
    P3 --> D3{"Fase 3.5 — A raiz já existe<br/>on-chain sob algum lote?"}
    D3 -- Sim --> S4["Fase 7 — Resumo: duplicate-skipped<br/>(nada persistido, alerta duplicate_root)"]
    D3 -- Não --> P4["Fase 4 — Persistir lote (status: pending)"]
    P4 --> D2{"Encerramento solicitado?"}
    D2 -- Sim --> S2["Fase 7 — Resumo: aborted<br/>(lote permanece pending)"]
    D2 -- Não --> P5["Fase 5 — Submeter raiz on-chain"]
    P5 --> P6["Fase 6 — Aguardar confirmação"]
    P6 --> S3["Fase 7 — Resumo: confirmed / submitted / failed"]
    S1 --> End(["Ciclo termina"])
    S4 --> End
    S2 --> End
    S3 --> End
```

As mesmas fases, em formato de lista de texto simples:

```text
Fase 0    Reconciliar lotes em andamento (deixados por um ciclo/crash anterior)
Fase 1    Varrer registros ainda não ancorados
Fase 2    Revalidar cada registro (assinatura + whitelist)
Fase 3    Construir a Árvore de Merkle
Fase 3.5  Pular o lote se sua raiz já existir on-chain
Fase 4    Persistir o lote (de forma durável, antes de qualquer contato com a chain)
  ── checkpoint cooperativo de encerramento ──
Fase 5    Submeter a raiz on-chain
Fase 6    Aguardar confirmação
Fase 7    Montar e registrar o resumo do ciclo
```

Se, após as Fases 1-2, restarem zero registros válidos para ancorar, o ciclo salta diretamente para a Fase 7 com um resumo do tipo `nothing-to-anchor` — as Fases 3-6 nunca são executadas, e nenhum lote vazio é jamais criado. Se a Fase 3.5 encontrar a raiz já registrada on-chain, o ciclo também termina antecipadamente, com um resumo `duplicate-skipped`, e não persiste nada.

### Fase 0 — Reconciliar Lotes em Andamento

**Responsabilidade:** resolver todo lote deixado em estado não-terminal (`pending`, `submitted` ou `failed`) por um ciclo *anterior* — porque o processo travou, foi encerrado à força, ou a blockchain simplesmente demorou entre ciclos — antes de realizar qualquer trabalho novo. Esta fase nunca cria novos lotes; ela apenas conduz lotes já existentes até um estado terminal (`confirmed` ou `failed`).

Implementada por `reconcileBatches` (`src/reconcile.ts`). Para cada lote em andamento, em ordem:

1. **Caminho rápido de "já está on-chain".** Independentemente do status registrado do lote, a fase primeiro pergunta ao contrato se a `merkle_root` do lote já está registrada (`containsMerkleRoot` e, em seguida, `getBatchIdByRoot` para saber sob qual id de lote ela foi registrada — leituras sem custo de gas do estado armazenado do contrato, nunca de logs de eventos). Uma raiz registrada sob o *id do próprio lote* significa que o lote está concluído: ele é marcado como `confirmed` (o número e o timestamp do bloco registrados vêm do evento `RootAdded` da raiz — o único lugar onde este serviço ainda lê logs, e apenas para o seu próprio lote). Essa única verificação resolve o cenário de crash mais comum (a transação foi de fato minerada antes do processo morrer, mas o banco de dados local nunca soube disso) sem sequer precisar inspecionar o status específico. Uma raiz registrada sob um id de lote *diferente* nunca poderá dar a este lote o seu próprio `BatchInfo`; por isso o lote é marcado como `failed` (uma única vez) e um alerta `duplicate_root` é escrito (a Fase 3.5 explica como essa situação surge).
2. **Lotes `pending`** (persistidos, mas cuja transação nunca foi enviada) são submetidos pela primeira vez aqui, exatamente como a Fase 5 faria.
3. **Lotes `submitted`** (uma transação foi enviada, mas o processo morreu antes dela confirmar) têm seu hash de transação inspecionado via uma consulta de recibo não-bloqueante:
   - **confirmed** → a raiz é consultada on-chain novamente e o lote só é marcado como `confirmed` se estiver registrada sob o *id do próprio lote*. Um recibo confirmado, sozinho, prova apenas que alguma transação foi minerada, não que ela ancorou este lote (`transaction_hash` é tão gravável quanto `merkle_root`); assim, uma transação confirmada cuja raiz não está on-chain é tratada como irreconciliável, e uma cuja raiz pertence a outro lote é tratada como raiz duplicada.
   - **reverted** → marca como `failed`.
   - **pending-confirmations** (minerada, mas ainda não passou da contagem de confirmações exigida) → deixado como está, reverificado no próximo ciclo.
   - **missing** (a transação foi descartada ou nunca se propagou) → os registros do lote são relidos e a raiz é recomputada primeiro; somente se ela ainda corresponder à raiz armazenada é que a transação é reenviada como substituição (mesmo nonce, taxa aumentada). Uma divergência, ou um lote sem nenhum `anchor_records` restante, é tratado como irreconciliável (ver abaixo). Se o nó não conhece mais a transação travada (descartada do mempool, de modo que não há nonce para substituir), o lote é submetido novamente como uma transação nova; se aquela raiz tiver sido minerada afinal, o contrato reporta `RootAlreadyExists` e o lote é resolvido como qualquer raiz já registrada on-chain. Se o próprio reenvio falhar (teto de taxa, erro de RPC, substituição subprecificada), o lote permanece `submitted`, a falha é registrada em nível de erro e o resto do ciclo continua — a Fase 0 tenta de novo no próximo ciclo.
   - Uma linha `submitted` **sem hash de transação** não pode ser inspecionada nem reenviada (este serviço sempre registra o hash), então também é tratada como irreconciliável.
4. **Lotes `failed`** não são simplesmente re-tentados às cegas. Primeiro, o conjunto de registros vinculado ao lote (`anchor_records`) é re-lido do banco de dados e a Raiz de Merkle é *recomputada* do zero. Somente se a raiz recomputada ainda corresponder à raiz originalmente armazenada é que o lote é resubmetido (pelo mesmo caminho `submitRoot` da Fase 5, de modo que uma reversão `RootAlreadyExists` é resolvida por propriedade exatamente como lá) — se ela divergir, isso é tratado como um sinal de possível adulteração dos próprios dados do lote persistido, registrado de forma bem visível, e **não** resolvido automaticamente; requer intervenção humana. Se a contagem de tentativas de um lote `failed` ultrapassar `ANCHOR_RETRY_ALERT_THRESHOLD` (padrão: 5), uma linha de log de alto destaque é emitida independentemente do resultado, já que um lote falhando repetidamente geralmente indica que algo estrutural está errado (a carteira perdeu a propriedade do contrato, ficou sem fundos para gas, ou algum valor de configuração está travado).

**Lotes irreconciliáveis.** Quando um lote não pode ser reconciliado com segurança — seus registros vinculados não reconstroem mais a raiz armazenada, ele não tem registros vinculados dos quais reconstruí-la, ou seu estado registrado é impossível (`submitted` sem hash de transação) — a fase nunca o reenvia nem o confirma. Ela marca o lote como `failed` (uma única vez: um lote já `failed` não é remarcado, de modo que `retry_count` não cresce a cada ciclo), escreve um alerta `root_divergence` com `source = 'anchor'` (`expected_root` = a raiz armazenada, `actual_root` = a raiz reconstruída, ou nulo quando não havia do que reconstruí-la; deduplicado por lote, de modo que um lote reavaliado a cada ciclo gera um único alerta) e **segue com o resto do ciclo**. Isso é uma falha por lote de propósito: uma única linha de `batches` forjada ou danificada — que qualquer detentor de `INSERT` em `batches` pode criar — não pode ser capaz de paralisar toda a ancoragem (cenários 8 e 13c do plano E2E).

Esse design implica que o sistema **não possui abandono automático de lotes**: um lote que pode ser re-tentado com segurança continua sendo re-tentado a cada ciclo, indefinidamente, até que ou tenha sucesso ou receba intervenção manual; um que não pode ser reconciliado com segurança permanece `failed` e é reexaminado a cada ciclo, com seu único alerta já escrito, até que um humano intervenha.

### Fase 1 — Varrer Registros Ainda Não Ancorados

**Responsabilidade:** encontrar todo registro que ainda não foi ancorado.

Implementada por `streamUnanchoredRecords` (`src/records-source.ts`): uma única consulta SQL seleciona toda linha em `records` que não possui uma linha correspondente em `anchor_records` (`NOT EXISTS`), ordenada por `id`. A consulta é executada como um **stream** (`pg-query-stream`), buscando linhas em lotes de 10.000 por padrão, de modo que o consumo de memória do daemon fica limitado pelo tamanho de um único lote de busca, e não pelo número total de registros não ancorados — isso importa porque a varredura pode precisar lidar com um volume acumulado potencialmente muito grande.

### Fase 2 — Revalidar Cada Registro

**Responsabilidade:** reverificar, de forma independente de qualquer verificação já feita pelo `data-domain` no momento da escrita, que cada registro ainda está legitimamente assinado e ainda tem permissão para ser ancorado.

Implementada por `validateRecord` (`src/validation.ts`), aplicada a cada registro entregue pela Fase 1. Duas verificações, ambas precisam passar, avaliadas nesta ordem:

1. **Validade da assinatura.** O signatário é recuperado da assinatura ECDSA sobre o JSON canônico de todo o *conteúdo assinável* do registro — `recordType`, `data` (o payload), `version`, `isDeleted`, `replaces` e `entityId` (`null` para uma linha original/criação, o id real da entidade para uma atualização ou exclusão) — e precisa ser igual ao endereço armazenado em `client_address`. Como esses campos estão dentro da mensagem assinada, editar qualquer um deles diretamente no Postgres antes de o registro ser ancorado quebra a assinatura. `id`, `created_at` e o `entity_id` de uma criação são gerados pelo banco *depois* de o cliente já ter assinado, então nenhuma assinatura consegue cobri-los (ver `docs/overview/signature/signature-verification.md` para saber exatamente o que essa verificação consegue e não consegue detectar). Uma string de assinatura malformada é simplesmente uma assinatura inválida; ela não lança exceção.
2. **Pertencimento à whitelist.** Esse mesmo endereço precisa estar atualmente presente em `WHITELIST_ADDRESSES`.

Essas são duas verificações genuinamente independentes: um registro pode ter uma assinatura perfeitamente válida (quem assinou realmente é quem `client_address` afirma) e ainda assim falhar na validação, porque a whitelist é reverificada no momento da ancoragem, não apenas no momento da ingestão — um endereço que estava autorizado quando o registro foi escrito pode ter sido removido da whitelist desde então, e um falsificador que assina com a própria chave produz uma assinatura válida que não está na whitelist. Um registro só avança para a Fase 3 se **ambas** as verificações passarem.

Todo registro que falha em qualquer uma delas é:
- excluído do lote por completo (ele *não* é ancorado neste ciclo, e permanece "não ancorado" — será revarrido pela Fase 1 no próximo ciclo, já que não possui linha em `anchor_records`);
- registrado como um alerta `signature_mismatch` em `integrity_alerts`, deduplicado por `record_id` — um registro permanentemente ruim é revarrido e rerejeitado a cada ciclo, mas gera apenas **um** alerta, nunca um por ciclo. O campo `details` do alerta traz o motivo: `signature does not match payload or client_address` ou `signer 0x… is not whitelisted`.

### Fase 3 — Construir a Árvore de Merkle

**Responsabilidade:** transformar o conjunto de registros que passaram pela Fase 2 em uma única Raiz de Merkle e uma prova de inclusão por registro.

Implementada por `buildAnchorTree` (`src/tree.ts`), um wrapper fino sobre o `buildMerkleTree` de `packages/crypto-utils` — a fonte única da verdade para essa lógica em todo o sistema, mantida byte-a-byte compatível com a própria verificação de provas baseada em OpenZeppelin do contrato `MerkleAnchorRegistry.sol` (ver [`ARCHITECTURE.md`](ARCHITECTURE.md) §5). A ordem de entrada é irrelevante: a biblioteca ordena as folhas por hash, e é por isso que o schema não tem uma coluna `leaf_index`. Se a Fase 2 rejeitou todos os registros e nenhum restou, a Fase 3 nunca chega a executar — o ciclo salta diretamente para um resumo `nothing-to-anchor` (Fase 7) em vez de chamar o construtor da árvore com uma entrada vazia.

**Memória.** A árvore e todas as provas são materializadas de uma só vez, o que custa cerca de 2,5 KB por folha (medido: aproximadamente +257 MB e 29 s para 100.000 folhas, +756 MB e 96 s para 300.000), de modo que um backlog muito grande é a principal forma de este daemon ficar sem memória. `ANCHOR_MAX_BATCH_SIZE` é lida e validada por `loadConfig`, mas esta versão ainda não divide um backlog em lotes limitados (esse trabalho está na branch `anchor-max-batch-size`); por enquanto, a variável é lida apenas pelo `monitor-service`, como o tamanho até o qual ele reconstrói a raiz de um lote em memória.

### Fase 3.5 — Pular uma Raiz que Já Existe On-Chain

**Responsabilidade:** garantir que um lote nunca seja persistido para uma raiz que o contrato rejeitaria.

Implementada diretamente em `runCycle`, via `findRootOnChain` (`src/chain-confirm.ts`: `containsMerkleRoot` e, em seguida, `getBatchIdByRoot` para obter o dono). O contrato aceita cada raiz exatamente uma vez, sob um único id de lote. Uma raiz recém-calculada que já existe só pode, portanto, significar que o mesmo conjunto de folhas já foi ancorado antes — tipicamente porque alguém deletou os vínculos em `anchor_records` de um lote já ancorado, ou a linha inteira do lote, o que faz os mesmos registros parecerem "não ancorados" de novo e reconstruírem exatamente a mesma raiz (cenários 4 e 5 do plano E2E). Persistir um novo lote para ela criaria um lote `confirmed` sem `BatchInfo` próprio — um lote fantasma que nada poderia reconciliar. Então, quando a raiz já existe, o ciclo:

- não persiste nada (nem linha de lote, nem vínculos) e não envia nenhuma transação;
- escreve um alerta `duplicate_root` (`source = 'anchor'`, `batch_id` nulo, `actual_root` = a raiz, deduplicado por essa raiz). A mensagem nomeia o lote dono e informa se a linha dele ainda existe no Postgres (seus vínculos provavelmente foram deletados) ou não (a linha e os vínculos provavelmente foram deletados);
- termina com um resumo `duplicate-skipped`.

Os mesmos registros geram a mesma raiz no ciclo seguinte, então a situação é redetectada a cada ciclo — registrada em nível de erro na primeira vez e como aviso nas seguintes — até que um novo registro altere o conjunto.

### Fase 4 — Persistir o Lote

**Responsabilidade:** tornar a composição do lote durável no Postgres *antes* de qualquer coisa ser enviada à blockchain.

Implementada por `persistBatch` (`src/batch-repository.ts`), como uma única transação de banco de dados:

1. Insere uma linha em `batches`, com `status = 'pending'`, a `merkle_root` calculada, e a contagem de registros.
2. Insere em massa uma linha por registro em `anchor_records` (`record_id`, `batch_id`, `merkle_proof`) via o protocolo `COPY … FROM STDIN` do Postgres, por velocidade em escala, em vez de um `INSERT` por registro.

Ambas as etapas acontecem dentro da mesma transação, de modo que a composição de um lote é atômica: ou todos os seus registros ficam durativamente vinculados a ele, ou nenhum fica. Essa ordem — persistir primeiro, submeter depois — é deliberada: uma vez que essa fase é concluída, o lote existe de forma durável no banco de dados com status `pending`, então, mesmo que o processo trave logo em seguida, a Fase 0 do *próximo* ciclo o encontrará e o submeterá. A composição de nenhum lote é jamais decidida por, ou depende de, algo que acontece on-chain.

Este é também o checkpoint cooperativo de encerramento descrito em §1.3: imediatamente após esta fase, e antes da Fase 5, `runCycle` verifica a flag de encerramento solicitado. Se estiver ativada, o ciclo para aqui — o lote é deixado como `pending` no banco de dados (seguro, já que a Fase 0 o pegará na próxima inicialização do processo) e as Fases 5-6 nunca são executadas, de modo que um encerramento nunca interrompe uma transação em andamento na blockchain.

### Fase 5 — Submeter a Raiz On-Chain

**Responsabilidade:** fazer com que a Raiz de Merkle do lote seja registrada no contrato inteligente, exatamente uma vez, lidando com falhas transitórias sem nunca perder o lote nem gastar gas em duplicidade.

Implementada por `submitAndConfirmBatch` (`src/cycle.ts`), que chama `submitRoot` (`src/chain-submit.ts`):

1. **Verificação prévia de idempotência.** Antes de sequer enviar uma transação, a fase consulta `findRootOnChain` de novo sobre esta raiz (as mesmas leituras sem custo de gas usadas pela Fase 0). Duplicatas causadas por vínculos deletados já são barradas na Fase 3.5; esta verificação é a rede de segurança restrita para o caso de o *mesmo lote* já ter sido submetido por uma reconciliação da Fase 0 concorrente (deste mesmo ciclo ou de outra instância) competindo exatamente com esta Fase 5. Uma raiz pertencente ao id do próprio lote faz o lote ser marcado imediatamente como `confirmed`, sem enviar transação; uma raiz pertencente a outro id de lote marca este lote como `failed` e escreve um alerta `duplicate_root`.
2. **Envio da transação.** Se a raiz genuinamente ainda não está on-chain, `addMerkleRoot(root, size, batchId)` é invocado — o id da linha do próprio lote é o `batchId`, e o contrato rejeita tanto uma raiz quanto um id de lote que já tenha visto. O envio usa o [`p-retry`](https://github.com/sindresorhus/p-retry) com até `ANCHOR_TX_RETRIES` tentativas (padrão: 4). A primeiríssima tentativa usa a taxa que a rede reporta no momento; toda tentativa seguinte — independentemente do que causou a falha da anterior — carrega um aumento de taxa progressivo (os dados de taxa atuais × (1 + 0,25 × número da tentativa): ×1,25, ×1,5, ×1,75, …), limitado por `ANCHOR_MAX_FEE_GWEI` (padrão: 100 gwei), de modo que uma sequência de tentativas subprecificadas converge, em vez de re-tentar para sempre no mesmo preço perdedor.
3. **Classificação de reversões (_reverts_).** Nem toda reversão é tratada da mesma forma, pois re-tentar uma reversão determinística falharia de forma idêntica sempre:
   - `RootAlreadyExists` — a raiz (ou o id do lote) já está registrada. Ela não é tratada às cegas como sucesso: a fase consulta quem é o dono da raiz. Dono é este lote → marcado como `confirmed` a partir de uma nova consulta on-chain (outra instância ou uma reconciliação da Fase 0 chegou primeiro); dono é outro lote → `failed` mais um alerta `duplicate_root`.
   - `OwnableUnauthorizedAccount` — a carteira não é mais a proprietária do contrato. Isso aborta imediatamente, sem re-tentar, e é tratado como uma falha estrutural, de "lote envenenado" (_poison batch_) — nenhuma quantidade de re-tentativas conserta uma carteira errada.
   - Qualquer outra reversão nomeada — também abortada imediatamente como uma falha não re-tentável, já que uma rejeição determinística em nível de contrato não muda numa nova tentativa.
   - Qualquer outra coisa (instabilidades de rede, timeouts de RPC, _rate limiting_) — genuinamente transitório, e re-tentado conforme o esquema de aumento de taxa acima.

### Fase 6 — Aguardar Confirmação

**Responsabilidade:** esperar, dentro do mesmo ciclo, que a transação submetida alcance a profundidade de confirmação exigida, e registrar seu resultado final e terminal.

Implementada por `awaitConfirmation` (`src/chain-confirm.ts`), bloqueando até que `ANCHOR_CONFIRMATIONS` (padrão: 3; 2 é a configuração típica para a Polygon Amoy) confirmações sejam alcançadas, ou até que `ANCHOR_CONFIRMATION_TIMEOUT_MS` (padrão: 300.000 ms / 5 minutos) se esgote. Três resultados distintos:

1. **Confirmada com sucesso** — o lote é marcado como `confirmed`, com o número e o timestamp do bloco em que foi incluída e, quando o recibo está disponível, o gas usado e o preço do gas.
2. **Minerada, mas revertida** — o único caso em que essa espera pode concluir, de forma definitiva, uma má notícia: o lote é marcado como `failed`.
3. **Timeout, ou qualquer outro erro durante a espera** (queda de rede, indisponibilidade de RPC) — o lote **não** é marcado como `failed`. Ele é deliberadamente deixado no estado `submitted`, porque, neste ponto, seu destino real on-chain é genuinamente desconhecido — a transação ainda pode confirmar mais tarde. Esse estado não resolvido é exatamente o que a Fase 0 do *próximo* ciclo existe para limpar: ela consultará novamente o mesmo hash de transação e o resolverá para o que ele de fato se tornou.

É por isso que a Fase 6 nunca precisa de seu próprio laço de re-tentativa: uma espera inconclusiva simplesmente adia a resolução para a Fase 0 do próximo ciclo, em vez de o ciclo atual bloquear indefinidamente ou arriscar um palpite sobre um resultado que ainda não pode conhecer.

### Fase 7 — Resumo do Ciclo

**Responsabilidade:** montar um único registro estruturado de tudo o que este ciclo fez, para fins de log e análise futura.

Implementada por `buildCycleSummary` (`src/metrics.ts`). Todo ciclo — tenha ele ancorado um lote, não encontrado nada para ancorar, sido abortado por encerramento, ou falhado — termina emitindo exatamente um resumo estruturado, contendo:

- o número do ciclo e seu `status` final (`confirmed` | `submitted` | `failed` | `nothing-to-anchor` | `duplicate-skipped` | `aborted`);
- as contagens de reconciliação da Fase 0 (lotes `confirmed`/`resent`/`failed` resolvidos naquele ciclo);
- quantos registros foram varridos e quantos foram rejeitados na Fase 2;
- quantos registros acabaram no lote, sua raiz, o hash de sua transação, o número de seu bloco, e o gas usado e o preço do gas (o que se aplicar ao resultado daquele ciclo — a maioria é `null` em um ciclo `nothing-to-anchor`);
- uma decomposição do tempo em milissegundos por estágio (`reconcile`, `scanAndValidate`, `tree`, `duplicateCheck`, `persist`, `submit`, `confirm` — os que tiverem sido executados), de modo que um ciclo lento possa ser diagnosticado identificando qual estágio específico consumiu o tempo, e a duração total do ciclo;
- uma captura de memória de pico (RSS), para detectar crescimento de memória proveniente de varreduras muito grandes antes que isso se torne um problema operacional.

Esse resumo é a única saída estruturada e processável por máquina que o daemon produz sobre seu próprio comportamento — é o que um operador (ou o conjunto de benchmarks em `apps/anchor-service/bench/`) leria para entender o que um determinado ciclo de fato fez.

---

## 3. Idempotência e Segurança de Concorrência (Recapitulação)

Várias das fases acima protegem, de forma independente, contra o mesmo risco subjacente — que o mesmo lote possa ser submetido à chain mais de uma vez, que o mesmo conjunto de registros possa ser ancorado sob duas identidades de lote, ou que duas execuções sobrepostas (entre ciclos, entre um crash e um reinício, ou entre duas instâncias do daemon) possam competir entre si:

- **Dentro de um único processo:** o `protect: true` do croner (§1.2) garante que no máximo um ciclo roda por vez.
- **Entre um crash e um reinício, ou uma chain lenta entre ciclos:** a Fase 0 (acima) reconcilia o que quer que o ciclo anterior tenha deixado em estado não-terminal antes de qualquer trabalho novo acontecer.
- **Entre submissões concorrentes da exata mesma raiz** (seja da própria Fase 0 deste ciclo competindo com sua própria Fase 5, seja, em princípio, uma segunda instância do daemon apontando para o mesmo banco de dados e a mesma chain): a verificação prévia de idempotência da Fase 5, e o tratamento de `RootAlreadyExists` por propriedade, ambos garantem que uma tentativa de submissão duplicada se resolve para o estado correto `confirmed`, em vez de falhar ou gastar gas em duplicidade.
- **Os mesmos registros ancorados sob uma segunda identidade de lote** (os vínculos de um lote ancorado, ou o lote inteiro, deletados do Postgres de modo que os registros pareçam não ancorados de novo): o contrato aceita uma raiz uma única vez, então a Fase 3.5 detecta a repetição *antes* de persistir qualquer coisa, a partir do estado armazenado do próprio contrato (nunca do Postgres), e levanta `duplicate_root` em vez de criar um lote fantasma.
- **A composição duplicada de um lote** (o mesmo registro acabando vinculado a dois lotes diferentes) é prevenida uma camada abaixo de tudo isso, pela própria constraint `UNIQUE(record_id)` do Postgres em `anchor_records` — a verdadeira primeira linha de defesa, não a lógica da aplicação.

---

## 4. Ciclo de Vida do Lote (Máquina de Estados)

Todo lote criado pela Fase 4 percorre uma pequena máquina de estados, inteiramente conduzida pelas fases descritas acima:

```text
pending ──(Fase 5, ou Fase 0 em um ciclo posterior, envia a transação)──> submitted
pending ──(o envio falha)──> failed
submitted ──(Fase 6 ou Fase 0: a raiz está on-chain sob o id do próprio lote)──> confirmed
submitted ──(Fase 6 ou Fase 0 detecta uma reversão)──> failed
submitted ──(Fase 0: sem recibo; substituída ou resubmetida)──> submitted
failed ──(Fase 0 recomputa a mesma raiz e resubmete)──> submitted
pending | submitted | failed ──(raiz pertencente a outro lote, ou irreconciliável)──> failed, com um alerta
```

`confirmed` é o único estado em que um lote deixa esta máquina de forma definitiva. `failed` não é verdadeiramente terminal: como descrito na Fase 0, um lote `failed` cujos registros ainda reconstroem a raiz armazenada continua sendo re-tentado por todo ciclo subsequente, para sempre, a menos que haja intervenção humana. Um lote que está `failed` porque sua raiz pertence a outro lote, ou porque é irreconciliável (seus vínculos não reconstroem mais a raiz, ele não tem nenhum, ou seu estado registrado é impossível), deliberadamente *não* é re-tentado: ele permanece `failed` e continua sendo reexaminado a cada ciclo em nível de aviso, com seu único alerta já escrito. Não existe abandono automático de lote em nenhum ponto deste sistema.

---

## 5. Alertas Escritos pelo `anchor-service`

Todas as linhas são escritas em `integrity_alerts` com `source = 'anchor'`; os alertas do próprio `monitor-service` estão listados no documento dele.

| `alert_type` | Escrito por | `batch_id` | `record_id` | `expected_root` | `actual_root` | Deduplicado por |
|---|---|---|---|---|---|---|
| `signature_mismatch` | Fase 2 — um registro falhou na verificação de assinatura ou de whitelist | `null` | o registro | `null` | `null` | `record_id` |
| `duplicate_root` | Fase 3.5 — a raiz reconstruída já existe on-chain (`batch_id` `null`); Fase 0 / Fase 5 — a raiz deste lote pertence a outro lote (`batch_id` = o lote que falhou) | `null` ou o lote que falhou | `null` | `null` | a raiz | `actual_root` |
| `root_divergence` | Fase 0 — um lote irreconciliável (as linhas não reconstroem mais a raiz armazenada, nenhum vínculo restante, `submitted` sem hash de transação, ou uma transação confirmada cuja raiz não está on-chain) | o lote | `null` | a raiz armazenada do lote | a raiz reconstruída, ou `null` quando não havia do que reconstruí-la | `batch_id` |
| `record_tampered` | Fase 0 — um registro de um lote em andamento não consegue sequer ser hasheado (por exemplo, um `client_address` malformado) | o lote | o registro | `null` | `null` | `record_id` |

---

## 6. Referência de Configuração

Obrigatórias: `DATABASE_URL`, `RPC_URL`, `ANCHOR_CHAIN_ID`, `ANCHOR_PRIVATE_KEY` (`loadConfig`, `src/config.ts`). Todo o resto é opcional:

| Variável | Padrão no código | Efeito |
|---|---|---|
| `CONTRACT_ADDRESS` | resolvido do registro de deployments commitado para `ANCHOR_CHAIN_ID` | Endereço do `MerkleAnchorRegistry`. |
| `WHITELIST_ADDRESSES` | vazio (todo registro é rejeitado, com um aviso na inicialização) | Endereços, separados por vírgula, autorizados a assinar registros (Fase 2). |
| `ANCHOR_CRON_SCHEDULE` | `0 */3 * * *` | Quando os ciclos começam (§1.2). |
| `ANCHOR_CONFIRMATIONS` | `3` | Confirmações a aguardar na Fase 6 e na Fase 0. (O `docker-compose.yml` define `1` para o nó local do Hardhat.) |
| `ANCHOR_CONFIRMATION_TIMEOUT_MS` | `300000` | Por quanto tempo a Fase 6 espera antes de deixar o lote `submitted`. |
| `ANCHOR_MAX_FEE_GWEI` | `100` | Teto do aumento progressivo de taxa (Fase 5, e a substituição da Fase 0). |
| `ANCHOR_TX_RETRIES` | `4` | Tentativas do `p-retry` ao enviar uma transação. |
| `ANCHOR_RETRY_ALERT_THRESHOLD` | `5` | Contagem de tentativas em que um lote `failed` registra um erro de alto destaque de "lote envenenado" (Fase 0). |
| `ANCHOR_MAX_BATCH_SIZE` | não definido | Lida e validada, **ainda não aplicada** por este daemon (ver Fase 3). O `monitor-service` a reutiliza como seu limite de reconstrução da raiz. |
| `SHUTDOWN_GRACE_MS` | `600000` | Período de tolerância para um ciclo em andamento no encerramento (§1.3). |
| `LOG_LEVEL` | `info` | Nível de log do pino. |
