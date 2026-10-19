# Arquitetura do Sistema de Integridade de Dados e Ancoragem de Merkle (MADIS)

MADIS — Merkle-Anchored Data Integrity System

A arquitetura proposta busca mitigar a vulnerabilidade de adulterações silenciosas de dados em SGBDs relacionais. A solução descentraliza o domínio de confiança ao utilizar uma blockchain pública como âncora imutável de provas criptográficas do estado dos dados via Árvores de Merkle.

O escopo da solução não reside na prevenção de acessos de baixo nível (como um DBA privilegiado ou um invasor com acesso root), mas sim na **garantia de detectabilidade**: caso qualquer alteração arbitrária ocorra diretamente no banco de dados, a fraude é exposta e comprovável criptograficamente.

---

## 1. Princípios Fundamentais e Modelo de Confiança

- **A Blockchain como Âncora da Verdade:** A âncora de confiança do sistema é a blockchain pública, nunca o banco de dados relacional.
- **Modelo Adversarial Estrito:** Se um atacante possui privilégios para adulterar registros na tabela `records`, ele também teria poder para adulterar colunas auxiliares ou hashes pré-calculados persistidos no banco. Por essa razão, o serviço de auditoria (**Monitor**) nunca confia em hashes derivados salvos no SGBD; ele sempre recalcula as folhas e a Árvore de Merkle a partir dos dados brutos e compara o resultado diretamente com a blockchain.
- **Objetivo de Segurança:** Detectar manipulação não autorizada de dados por um insider ou atacante com acesso direto ao banco (DBA malicioso), ancorando as Raízes de Merkle em uma rede pública imutável com carimbo temporal (_timestamping_).

---

## 2. Divisão de Domínios e Estrutura do Monorepo

O sistema é estruturado em um monorepo orientado a domínios de responsabilidade única:

```text
madis/
├── apps/
│   ├── data-domain/          # API REST para ingestão e persistência de dados (PostgreSQL)
│   ├── integrity-domain/     # Contratos Inteligentes Hardhat / Solidity (EVM)
│   ├── anchor-service/       # Daemon de Ancoragem periódica (Escrita na Blockchain + DB)
│   └── monitor-service/      # Daemon de Auditoria contínua (Leitura na Blockchain + DB)
├── packages/
│   ├── contracts-shared/     # ABIs compiladas, endereços e tipagens TypeScript do contrato
│   └── crypto-utils/         # Biblioteca única de hashing, canonicalização, ABI encoding e Merkle Tree
└── db/
    ├── schema.sql            # Schema DDL do PostgreSQL (4 tabelas)
    └── setup-users.sql       # Configuração de permissões RBAC no PostgreSQL
```

### Descrição dos Domínios:

1. **Domínio do Cliente:**
   - Ponto de interação do usuário final ou sistema de origem.
   - Responsável pela entrada dos dados de negócio e geração de assinaturas digitais locais via carteira criptográfica (chaves privadas sob custódia do cliente, compatíveis com EVM / ECDSA).
2. **Domínio de Dados ([`apps/data-domain`](../../apps/data-domain)):**
   - API de backend que centraliza as operações no SGBD relacional sob o modelo _append-only_.
   - Valida a autenticidade da assinatura digital e a permissão do endereço do cliente antes de persistir os dados.
3. **Serviços em Segundo Plano ([`apps/anchor-service`](../../apps/anchor-service) e [`apps/monitor-service`](../../apps/monitor-service)):**
   - Processos desacoplados que executam tarefas agendadas e autônomas:
     - **Anchor Service:** Coleta registros pendentes, valida assinaturas, gera a Árvore de Merkle e ancora a raiz na blockchain.
     - **Monitor Service:** Reconstrói periodicamente as árvores dos lotes já ancorados, consulta a blockchain e dispara alertas e _drill-down_ em caso de anomalia.
   - Detalhes adicionais de arquitetura dos jobs encontram-se em [`docs/overview/jobs/JOBS_ARCHITECTURE.md`](../overview/jobs/JOBS_ARCHITECTURE.md).
4. **Domínio de Prova de Integridade ([`apps/integrity-domain`](../../apps/integrity-domain)):**
   - Camada descentralizada em redes públicas EVM (Polygon / Ethereum).
   - Hospeda o contrato inteligente [`MerkleAnchorRegistry.sol`](../../apps/integrity-domain/contracts/MerkleAnchorRegistry.sol), responsável pelo registro imutável com carimbo temporal (_timestamping_) das raízes de Merkle.
5. **Bibliotecas Compartilhadas ([`packages/`](../../packages)):**
   - Garante **Fonte Única da Verdade (Single Source of Truth)** para algoritmos criptográficos ([`packages/crypto-utils`](../../packages/crypto-utils)) e artefatos de contrato ([`packages/contracts-shared`](../../packages/contracts-shared)), evitando discrepâncias de implementação entre a API, o Anchor e o Monitor.

---

## 3. Diagrama e Fluxos de Operação

![Arquitetura Geral](../ArchitectureV6.png)

O sistema opera por meio de dois fluxos principais e complementares:

### Fluxo 1: Ingestão e Ancoragem

1. O cliente assina os dados de negócio com sua chave privada (ECDSA) e submete o pacote à API ([`apps/data-domain`](../../apps/data-domain)).
2. A API valida criptograficamente a assinatura e a permissão do signatário, persistindo o registro na tabela `records`.
3. Periodicamente, o **Anchor Service** ([`apps/anchor-service`](../../apps/anchor-service)) varre registros ainda não ancorados, revalida cada um deles (a assinatura sobre todo o conteúdo assinável do registro e a presença do signatário na whitelist), computa as folhas e constrói a Árvore de Merkle.
4. Caso algum registro falhe nessa revalidação, o Anchor emite um alerta do tipo `signature_mismatch` na tabela `integrity_alerts` e exclui o registro do lote.
5. Se a Raiz de Merkle resultante já existir na blockchain (os mesmos registros parecendo "não ancorados" de novo depois que alguém deletou seus vínculos ou seu lote), o Anchor não persiste nada e emite um alerta `duplicate_root`, em vez de criar um lote fantasma.
6. Caso contrário, o lote (status `pending`) e a prova individual (_Merkle Proof_) de cada registro são persistidos em `batches` / `anchor_records` em uma única transação, e só então a Raiz de Merkle é enviada ao contrato inteligente [`MerkleAnchorRegistry.sol`](../../apps/integrity-domain/contracts/MerkleAnchorRegistry.sol) via transação de escrita assinada pela carteira do Anchor.
7. Após a confirmação do bloco na blockchain, o status do lote em `batches` é atualizado para `confirmed`. Um lote deixado em andamento por um crash ou por uma chain lenta é reconciliado no início do ciclo seguinte.

### Fluxo 2: Auditoria Contínua e Detecção de Fraudes

1. O **Monitor Service** ([`apps/monitor-service`](../../apps/monitor-service)) executa ciclicamente de forma independente ao Anchor.
2. O Monitor lê a lista de todos os lotes que o contrato já aceitou (id do lote e raiz, direto do estado armazenado do contrato) e a compara com o que o Postgres diz sobre os mesmos ids. Um lote que a chain aceitou mas que o Postgres perdeu de vista (linha deletada, ou status alterado para um que não pode ser verdadeiro) dispara um alerta `root_divergence`.
3. Para cada lote que audita (toda linha `confirmed` mais todo lote on-chain que ainda tenha linha, qualquer que seja o status que essa linha alegue), o Monitor obtém a raiz e o tamanho do lote na chain (`getBatchInfo`) — nunca no Postgres — e verifica se a quantidade de registros vinculados em `anchor_records` é igual ao tamanho on-chain. Em seguida, recupera os dados originais no banco relacional, recalcula cada folha com a mesma lógica criptográfica, reconstrói a Raiz de Merkle e a compara com a raiz on-chain (lotes acima de um tamanho configurável são verificados registro a registro, em _streaming_, para limitar a memória).
4. Uma divergência de contagem emite um alerta `root_divergence` para o lote. Se a raiz reconstruída não corresponder à raiz on-chain, ao menos um registro foi adulterado pós-ancoragem, e o Monitor aciona o procedimento de **Drill-Down**.
5. No Drill-Down, o Monitor utiliza o `merkle_proof` individual de cada registro salvo em `anchor_records` para testar cada registro isoladamente contra a raiz legítima na blockchain, emitindo alertas do tipo `record_tampered` e identificando com exatidão o registro violado.
6. Por fim, verifica se todo lote que o Postgres afirma estar `submitted` de fato chega à chain dentro de um tempo configurável, usando seu próprio relógio, para expor linhas de preenchimento forjadas.

---

## 4. Modelagem de Dados e Controle Append-Only

A modelagem de dados combina o mecanismo _append-only_ com a separação entre o domínio de negócio e a infraestrutura criptográfica em 4 tabelas relacionais ([`db/schema.sql`](../../db/schema.sql)):

{ Uma nova imagem atualizada para o diagrama será feita }

### 4.1. Tabela `records` (Negócio e Autoria — Append-Only)

Armazena os registros sensíveis protegidos pelo sistema. Nenhuma linha é alterada ou removida via `UPDATE` ou `DELETE`. Atualizações e deleções lógicas geram novos registros.

- `id` (`BIGSERIAL PK`): Identificador único da linha.
- `entity_id` (`BIGINT NOT NULL`): Identificador estável da entidade de negócio. Agrupa todas as versões de uma mesma entidade (versão 1, 2, 3...) facilitando a recuperação da linhagem histórica via `WHERE entity_id = X`. Escopado por `record_type` (`UNIQUE(record_type, entity_id, version)`), não globalmente único.
- `record_type` (`VARCHAR(20) NOT NULL`): Discriminador do tipo de registro de negócio: `'prescription'` (prescrição eletrônica) ou `'emr_encounter'` (atendimento/prontuário eletrônico). Domínio escolhido: Prontuário Médico e Prescrições Eletrônicas (Saúde) — ver `docs/DOMINIOS_PROPOSTOS.md`.
- `payload` (`JSONB NOT NULL`): Dados de negócio brutos assinados pelo cliente — é exatamente o `data` usado por `hashPayloadData`/`computeLeafHash` (`packages/crypto-utils`). O Monitor sempre recalcula as folhas a partir desta coluna, nunca de um hash pré-computado, preservando o modelo de confiança da blockchain como âncora única. A tabela permanece agnóstica de domínio: o formato de `payload` varia por `record_type` e é validado na borda da API (`data-domain`), não pelo SGBD.
- `version` (`INTEGER NOT NULL DEFAULT 1`): Número sequencial da versão da entidade.
- `is_deleted` (`BOOLEAN NOT NULL DEFAULT FALSE`): Marcador de deleção lógica.
- `replaces` (`BIGINT NULL FK -> records.id`): Ponteiro autorreferencial para a versão anterior que está sendo substituída.
- `client_address` (`CHAR(42) NOT NULL`): Endereço Ethereum do signatário original.
- `signature` (`TEXT NOT NULL`): Assinatura digital ECDSA dos dados da aplicação.
- `created_at` (`TIMESTAMPTZ NOT NULL DEFAULT NOW()`): Carimbo temporal de criação.

### 4.2. Tabela `batches` (Ciclo de Vida da Ancoragem)

Registra cada ciclo de execução do serviço de ancoragem e o estado da transação na blockchain.

- `id` (`BIGSERIAL PK`): Identificador único do lote.
- `status` (`VARCHAR(20) NOT NULL`): Estado no ciclo de vida: `pending` $\to$ `submitted` $\to$ `confirmed` ou `failed`.
- `merkle_root` (`CHAR(66) NOT NULL`): Raiz de Merkle calculada para o lote (`0x` + 64 hexadecimais).
- `size` (`INTEGER NOT NULL`): Quantidade de registros que compõem o lote.
- `transaction_hash` (`CHAR(66) NULL`): Hash da transação emitida na rede blockchain.
- `block_number` (`BIGINT NULL`): Número do bloco de inclusão na rede descentralizada.
- `block_timestamp` (`TIMESTAMPTZ NULL`): Timestamp oficial do bloco minerado.
- `retry_count` (`INTEGER NOT NULL DEFAULT 0`): Contador de tentativas de reenvio em caso de falhas transitórias.
- `error_message` (`TEXT NULL`): Descrição do erro em caso de falha/reversão.
- `created_at` / `confirmed_at` (`TIMESTAMPTZ`): Timestamps de início e finalização do ciclo.

### 4.3. Tabela `anchor_records` (Ponte Registro–Lote e Provas Individuais)

Vincula de forma unívoca (`UNIQUE(record_id)`) cada registro ao lote que o ancorou.

- `id` (`BIGSERIAL PK`): Identificador único.
- `record_id` (`BIGINT NOT NULL FK -> records.id`): Registro ancorado.
- `batch_id` (`BIGINT NOT NULL FK -> batches.id`): Lote de ancoragem.
- `merkle_proof` (`JSONB NOT NULL`): Array ordenado de hashes irmãos (_sibling hashes_) necessários para validar a inclusão da folha na raiz. Graças ao uso do padrão OpenZeppelin (_Sorted Pairs_), a verificação dispensa índices posicionais (`leaf_index`).
- `anchored_at` (`TIMESTAMPTZ NOT NULL DEFAULT NOW()`): Timestamp de vinculação.

### 4.4. Tabela `integrity_alerts` (Log de Incidentes e Auditoria)

Log imutável para persistência de divergências e fraudes detectadas.

- `id` (`BIGSERIAL PK`): Identificador do alerta.
- `alert_type` (`VARCHAR(30) NOT NULL`): Tipo de incidente: `'signature_mismatch'` | `'root_divergence'` | `'record_tampered'` | `'duplicate_root'`.
- `source` (`VARCHAR(20) NOT NULL`): Origem da detecção: `'anchor'` | `'monitor'`.
- `batch_id` (`BIGINT NULL FK -> batches.id`): Lote afetado (se aplicável).
- `record_id` (`BIGINT NULL FK -> records.id`): Registro adulterado identificado (no caso de _drill-down_).
- `expected_root` (`TEXT NULL`): Raiz legítima registrada na blockchain (ou, para um `root_divergence` do lado do Anchor, a raiz armazenada para o lote).
- `actual_root` (`TEXT NULL`): A raiz que diverge dela: a raiz reconstruída localmente ou, para `duplicate_root`, a raiz que já existe on-chain.
- `details` (`TEXT NULL`): Contexto técnico complementar da ocorrência.
- `detected_at` (`TIMESTAMPTZ NOT NULL DEFAULT NOW()`): Timestamp da detecção.

### 4.5. Modelo de Permissões no PostgreSQL ([`db/setup-users.sql`](../../db/setup-users.sql))

Para assegurar a propriedade _append-only_ na camada de infraestrutura, o banco opera com dois perfis de usuário:

- **`app_user` (Princípio do Menor Privilégio):** Utilizado em produção pela API, pelo Anchor e pelo Monitor. Possui apenas permissão de `SELECT` e `INSERT` na tabela `records`, garantindo que qualquer tentativa de `UPDATE` ou `DELETE` seja bloqueada pelo próprio SGBD.
- **`admin_user` (Cenário Adversarial):** Usuário com privilégios administrativos irrestritos, utilizado exclusivamente para fins de testes empíricos de adulteração (simulando um atacante ou DBA malicioso com acesso direto ao banco).

---

## 5. Especificação Criptográfica e Construção da Árvore

Toda a lógica de hashing e manipulação da Árvore de Merkle é centralizada na biblioteca compartilhada [`packages/crypto-utils`](../../packages/crypto-utils).

### 5.1. Canonicalização de Dados (RFC 8785)

Para garantir determinismo estrito na serialização JSON dos atributos de negócio antes do hashing, é empregado o padrão RFC 8785 (JSON Canonicalization Scheme), garantindo ordenação estável de chaves e formatação uniforme:

$$\text{dataHash} = \text{Keccak256}(\text{toUtf8Bytes}(\text{canonicalize}(\text{dados})))$$

### 5.2. Cálculo da Folha Merkle ($L_i$)

Para garantir resistência a ataques de colisão e interoperabilidade com Solidity e o padrão EVM ABI, a folha da árvore vincula todas as colunas da linha `records` — não apenas o payload e a assinatura — via `AbiCoder.defaultAbiCoder().encode(["uint256", "uint256", "string", "bytes32", "uint256", "bool", "uint256", "address", "string", "uint256"], [id, entityId, recordType, dataHash, version, isDeleted, replaces, clientAddress, signature, createdAt])`:

$$L_i = \text{Keccak256}\Big(\text{abi.encode}\big([\text{"uint256"}, \text{"uint256"}, \text{"string"}, \text{"bytes32"}, \text{"uint256"}, \text{"bool"}, \text{"uint256"}, \text{"address"}, \text{"string"}, \text{"uint256"}], [id_i, \text{entityId}_i, \text{recordType}_i, \text{dataHash}_i, \text{version}_i, \text{isDeleted}_i, \text{replaces}_i, \text{clientAddress}_i, \text{signature}_i, \text{createdAt}_i]\big)\Big)$$

Vincular os dez campos — e não apenas `id`/`dataHash`/`signature` — significa que adulterar qualquer coluna isolada após o registro ser ancorado (por exemplo, reescrever `version` ou `replaces` para esconder uma versão, ou `client_address` para forjar autoria) altera $L_i$ e, portanto, é detectado pela comparação de raiz do Monitor, da mesma forma que a adulteração do próprio payload. `replaces` é codificado como `0` quando `NULL` (uma linha original não tem versão anterior), e `clientAddress` é normalizado no formato checksum EIP-55 via `getAddress()` antes de ser codificado como `"address"`. Essa ordem de campos é permanente — corresponde à ordem de declaração das colunas de `records` em `db/schema.sql` — e não deve mudar depois que registros forem ancorados com base nela.

### 5.3. Árvore de Merkle com Pares Ordenados (_Sorted Pairs_)

A construção da árvore adota a especificação padrão do ecossistema OpenZeppelin (`@openzeppelin/merkle-tree` e `MerkleProof.sol`):

- Ao combinar dois nós filhos $A$ e $B$, os hashes são ordenados lexicograficamente antes da concatenação:
  $$H(A, B) = \text{Keccak256}\big(\min(A, B) \parallel \max(A, B)\big)$$
- **Vantagem:** A verificação de provas torna-se completamente independente da posição original da folha na árvore, dispensando metadados como `leaf_index`.

---

## 6. Serviços em Segundo Plano (Jobs)

### 6.1. Daemon de Ancoragem (`apps/anchor-service`)

Processo em lote executado periodicamente (ex: a cada 1 a 3 horas). Cada ciclo (detalhes completos em [`ANCHOR_SERVICE_EXECUTION_CYCLE.md`](ANCHOR_SERVICE_EXECUTION_CYCLE.md)):

1. **Reconciliação:** Resolve os lotes que um ciclo anterior deixou em andamento (`pending`, `submitted`, `failed`) antes de qualquer trabalho novo.
2. **Varredura:** Busca registros em `records` que ainda não possuem entrada associada em `anchor_records`.
3. **Validação Prévia:** Verifica se a assinatura digital (sobre todo o conteúdo assinável do registro) corresponde ao signatário e se o signatário está na whitelist. Se não, emite alerta `signature_mismatch` e descarta o registro do lote.
4. **Construção da Árvore:** Gera as folhas $L_i$, computa a Raiz de Merkle e extrai o `merkle_proof` de cada folha. Um backlog grande é dividido em lotes de no máximo `ANCHOR_MAX_BATCH_SIZE` registros (padrão 100.000), cada um ancorado como um lote próprio no mesmo ciclo (os passos 5-7 se repetem por lote).
5. **Guarda de Raiz Duplicada:** Se a raiz já existe on-chain, não persiste nada e emite um alerta `duplicate_root`.
6. **Persistência do Lote:** Em uma única transação, insere o lote (status `pending`) na tabela `batches` e persiste as provas individuais em `anchor_records`.
7. **Transação On-Chain:** Invoca `MerkleAnchorRegistry.addMerkleRoot(root, size, batchId)` na rede descentralizada e aguarda a confirmação, após a qual o lote passa a `confirmed`.

### 6.2. Monitor de Integridade (`apps/monitor-service`)

Processo de auditoria contínua executado em alta frequência (ex: a cada 5 a 15 minutos). Cada ciclo (detalhes completos em [`MONITOR_SERVICE_EXECUTION_CYCLE.md`](MONITOR_SERVICE_EXECUTION_CYCLE.md)):

1. **Recuperação Guiada pela Chain:** Lista todos os lotes que o contrato já aceitou (`getBatchIdsPaged` / `getMerkleRootsPaged`) e consulta o Postgres sobre esses mesmos ids. Lotes que o Postgres perdeu de vista (ou rotula com um status impossível) disparam um alerta `root_divergence`; o conjunto auditado é toda linha `confirmed` mais todo lote on-chain que tenha linha, de modo que alterar um `status` não consegue esconder um lote.
2. **Verdade Fundamental Vinda da Chain:** Para cada lote, lê a raiz e o tamanho via `getBatchInfo` e compara o tamanho com o número de registros vinculados em `anchor_records`.
3. **Reconstrução Independente:** Recupera os registros brutos em `records` e reconstrói a Raiz de Merkle a partir dos dados do banco (para lotes acima de `ANCHOR_MAX_BATCH_SIZE`, verifica em vez disso a prova armazenada de cada registro).
4. **Tratamento de Inconsistência:** Se a raiz reconstruída divergir da da blockchain, executa o procedimento de **Drill-Down** individual, emitindo `record_tampered` para cada registro violado.
5. **Verificação de Obsolescência:** Sinaliza lotes `submitted` que nunca chegam à chain dentro de `MONITOR_SUBMITTED_STALE_MS`.

---

## 7. Estratégia de Alertas e Procedimento de Drill-Down

Quando uma divergência é detectada no nível do lote, o Monitor não apenas sinaliza o lote como fraudado, mas identifica individualmente quais registros sofreram adulteração:

```text
[Lote Divergente Detectado]
  (raiz reconstruída ≠ raiz on-chain, ou o lote é grande demais para reconstruir)
         │
         ▼
[1. Executa Drill-Down registro a registro]
   Para cada record vinculado ao lote:
     a. Recalcula a folha Li a partir dos dados atuais de records
     b. Recupera o merkle_proof salvo em anchor_records
     c. Valida: verifyMerkleProof(merkle_proof, blockchainRoot, Li)
     d. Se FALHAR ──> [Emite Alerta: record_tampered (batch_id, record_id)]

(Uma contagem de vínculos diferente do tamanho on-chain é reportada à parte,
 como root_divergence (batch_id), antes deste procedimento.)
```

### Propriedade de Segurança Adversarial do Drill-Down:

Mesmo que o atacante tenha alterado o `merkle_proof` ou os dados do lote no banco de dados relacional, a raiz de referência utilizada no teste de verificação é sempre a raiz imutável obtida da **Blockchain**, tornando computacionalmente inviável para o atacante forjar uma prova falsa que valide dados adulterados.

---

## 8. Contrato Inteligente ([`MerkleAnchorRegistry.sol`](../../apps/integrity-domain/contracts/MerkleAnchorRegistry.sol))

O contrato inteligente atua como a âncora pública de integridade do sistema. Ele é desenvolvido em Solidity (^0.8.28) utilizando as bibliotecas de referência da OpenZeppelin (`Ownable`, `MerkleProof`).

### Métodos Principais:

- `addMerkleRoot(bytes32 _root, uint256 _batchSize, uint256 _batchId) external onlyOwner returns (uint256)`: Registra uma nova Raiz de Merkle sob um id de lote e emite `RootAdded(index, root, batchSize, batchId)`. Garante que uma raiz só possa ser registrada uma vez e um id de lote só possa ser usado uma vez, e impede raízes nulas e lotes vazios.
- `containsMerkleRoot(bytes32 _root) public view returns (bool)`: Verificação de existência $O(1)$ sem custo de gas.
- `getMerkleRootAt(uint256 _index) external view returns (bytes32)`: Consulta histórica por índice sequencial.
- `getBatchInfo(uint256 _batchId) external view returns (bytes32 root, uint256 size)`: A raiz e o tamanho ancorados sob um id de lote — a verdade fundamental contra a qual o Monitor audita cada lote.
- `getBatchIdByRoot(bytes32 _root) external view returns (uint256)`: Consulta reversa — sob qual id de lote uma raiz foi registrada (reverte se nunca foi registrada).
- `getLatestMerkleRoot() external view returns (bytes32)`: Retorna a última raiz registrada.
- `getRootCount() external view returns (uint256)`: Retorna a quantidade total de lotes ancorados.
- `getMerkleRootsPaged(uint256 _offset, uint256 _limit) external view returns (bytes32[] memory)`: Permite paginação eficiente do histórico de raízes para sincronização off-chain.
- `getBatchIdsPaged(uint256 _offset, uint256 _limit) external view returns (uint256[] memory)`: Os ids de lote correspondentes, na mesma ordem, para que o Monitor enumere todo lote ancorado a partir do estado armazenado do contrato, sem varrer logs de eventos.
- `verifyMerkleProof(bytes32 _root, bytes32[] calldata _proof, bytes32 _leaf) external view returns (bool)`: Valida uma prova criptográfica diretamente contra uma raiz registrada no contrato.
