"""Turns a bench results directory into PNG charts (Portuguese labels) for the thesis.

Usage: python plot.py <results-dir> [--out <dir>] [--file <path> ...]

For each known prefix it charts the newest `<prefix>-<timestamp>.json` (or the
file given with --file). Runs are never combined: each run is one experiment.
"""

import argparse
import csv
import json
import math
import re
import statistics
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.ticker import FuncFormatter  # noqa: E402

PREFIXES = ["perf", "cross-chain", "monitor-perf", "monitor-detection", "monitor-sizing",
            "monitor-audit-cost", "cross-chain-cost-24h", "cross-chain-annual", "cross-chain-per-record",
            "cross-chain-summary", "cross-chain-deploy", "cross-chain-gas", "cross-chain-stats",
            "cross-chain-counts"] + [
    f"cross-chain-scanner-{statistic}-{table}" for statistic in ("mean", "median")
    for table in ("summary", "annual", "per-record", "deploy", "cost-24h")]
NAME = re.compile(r"^(?P<prefix>.+)-(?P<ts>\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)\.(json|csv)$")

# Categorical slots (validated: CVD-safe on white; slots 3-4 need labels/markers).
BLUE, ORANGE, AQUA, YELLOW, MAGENTA = "#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4"
INK, INK_2, GRID = "#0b0b0b", "#52514e", "#e4e3df"
DPI = 200
WIDTH_IN = 6.5  # one Google Docs page width

CONFIGS = {
    "full": ("Varredura completa", BLUE, "o"),
    "sampling-k3": ("Amostragem (k = 3)", ORANGE, "s"),
    "sampling-1h": ("Amostragem (garantia de 1 h)", AQUA, "^"),
}
STRATEGIES = {
    "shuffled-pass": ("Passagem embaralhada", BLUE),
    "independent": ("Sorteio independente", ORANGE),
}
CPU_CAVEAT = (
    "O tempo de CPU mede apenas o processo do benchmark; o trabalho do Postgres "
    "e do nó Hardhat aparece no tempo total, não na CPU."
)


def style() -> None:
    plt.rcParams.update({
        "figure.facecolor": "white", "axes.facecolor": "white",
        "axes.edgecolor": GRID, "axes.labelcolor": INK_2, "axes.titlecolor": INK,
        "axes.titlesize": 11, "axes.labelsize": 9, "axes.grid": True,
        "grid.color": GRID, "grid.linewidth": 0.6, "axes.axisbelow": True,
        "axes.spines.top": False, "axes.spines.right": False,
        "xtick.color": INK_2, "ytick.color": INK_2,
        "xtick.labelsize": 8, "ytick.labelsize": 8, "legend.fontsize": 8,
        "legend.frameon": False, "lines.linewidth": 2, "lines.markersize": 6,
    })


# ---------- loading ----------

def load_rows(path: Path) -> list[dict]:
    json_path = path.with_suffix(".json")
    if json_path.exists():
        return json.loads(json_path.read_text())
    # CSV fallback: values come back as strings; empty cells become None.
    with path.with_suffix(".csv").open() as f:
        rows = list(csv.DictReader(f))
    return [{k: (None if v == "" else num(v)) for k, v in row.items()} for row in rows]


def num(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        try:
            return float(value)
        except (TypeError, ValueError):
            return value


def find_runs(results_dir: Path, pinned: list[Path]) -> dict[str, Path]:
    runs: dict[str, tuple[str, Path]] = {}
    for path in results_dir.glob("*"):
        match = NAME.match(path.name)
        if not match or match["prefix"] not in PREFIXES:
            continue
        current = runs.get(match["prefix"])
        if current is None or match["ts"] > current[0]:
            runs[match["prefix"]] = (match["ts"], path.with_suffix(""))
    chosen = {prefix: stem for prefix, (_, stem) in runs.items()}
    for path in pinned:
        match = NAME.match(path.name)
        if not match or match["prefix"] not in PREFIXES:
            sys.exit(f"--file {path}: not a <prefix>-<timestamp>.json/.csv of a known prefix")
        chosen[match["prefix"]] = path.with_suffix("")
    return chosen


def read_meta(stem: Path) -> dict:
    meta_path = Path(f"{stem}.meta.json")
    return json.loads(meta_path.read_text()) if meta_path.exists() else {}


def machine_line(stem: Path) -> str:
    meta = read_meta(stem)
    if not meta:
        return ""
    gib = meta.get("totalMemBytes", 0) / 2**30
    commit = meta.get("gitCommit") or "?"
    dirty = " (com alterações locais)" if meta.get("gitDirty") else ""
    line = (f" Máquina: {meta.get('cpuModel')} ({meta.get('cpuCores')} núcleos), "
            f"{gib:.0f} GiB de RAM, Node {meta.get('nodeVersion')}; commit {commit}{dirty}.")
    if meta.get("incomplete"):
        line += f" ATENÇÃO: execução incompleta (falhou em {json.dumps(meta.get('failedCell'))})."
    return line


# ---------- helpers ----------

def median(values):
    return statistics.median(values)




def save(fig, out_dir: Path, name: str, caption: str, stem: Path) -> None:
    fig.tight_layout()
    path = out_dir / name
    fig.savefig(path, dpi=DPI)
    plt.close(fig)
    print(f"\n{path}\n  Legenda sugerida: {caption} Dados: {stem.name}.csv.{machine_line(stem)}")


def br(value: float) -> str:
    """3 significant digits with a decimal comma, as in Portuguese."""
    return f"{value:.3g}".replace(".", ",")


def decimal_comma(ax, axis: str = "y") -> None:
    """Linear-axis ticks with a decimal comma."""
    def plain(value, _):
        text = f"{value:.12f}".rstrip("0").rstrip(".")  # never scientific notation
        return (text or "0").replace(".", ",")

    formatter = FuncFormatter(plain)
    (ax.yaxis if axis == "y" else ax.xaxis).set_major_formatter(formatter)


def label_ends(ax, ends: list[tuple[float, float]]) -> None:
    """Direct labels at the series' last points, nudged apart when they'd collide."""
    low, high = ax.get_ylim()
    min_gap = (high - low) * 0.06
    placed: list[float] = []
    for x, y in sorted(ends, key=lambda end: end[1]):
        shown = y
        if placed and shown - placed[-1] < min_gap:
            shown = placed[-1] + min_gap
        placed.append(shown)
        # x * 1.08: just right of the last point on the log axis.
        ax.text(x * 1.08, shown, br(y), va="center", fontsize=8, color=INK_2, clip_on=False)


def by_config(rows):
    groups: dict[str, dict[int, list[dict]]] = {}
    for row in rows:
        groups.setdefault(row["config"], {}).setdefault(row["m"], []).append(row)
    return groups


# --linear: size axes drawn linear instead of log (cost-per-cycle and anchor vs audit charts);
# on the cross-chain cost charts, two linear panels (Ethereum | Polygon + Arbitrum) instead of one log axis.
LINEAR = False

THOUSANDS = FuncFormatter(lambda v, _: f"{int(v):,}".replace(",", "."))


def config_lines(ax, rows, value, legend_loc="upper left"):
    ends = []
    for config, (label, color, marker) in CONFIGS.items():
        series = by_config(rows).get(config)
        if not series:
            continue
        ms = sorted(series)
        samples = [[value(r) for r in series[m]] for m in ms]
        means = [statistics.mean(values) for values in samples]
        spreads = [statistics.stdev(values) if len(values) > 1 else 0.0 for values in samples]
        ax.errorbar(ms, means, yerr=spreads, color=color, marker=marker, label=label,
                    capsize=3, elinewidth=1)
        ends.append((ms[-1], means[-1]))
    if LINEAR:
        ax.set_xlim(left=0)
        ax.xaxis.set_major_formatter(THOUSANDS)
    else:
        ax.set_xscale("log")
    # Zero baseline: a cost axis that starts near the data turns noise into gaps.
    ax.set_ylim(bottom=0, top=ax.get_ylim()[1] * 1.15)
    decimal_comma(ax)
    label_ends(ax, ends)
    ax.set_xlabel("Lotes ancorados (M)" if LINEAR else "Lotes ancorados (M, escala log)")
    ax.legend(loc=legend_loc)


# ---------- monitor charts ----------

def monitor_perf(rows, out_dir, stem):
    if len({r["m"] for r in rows}) < 2:
        return note("monitor-perf", "menos de 2 valores de M")
    batch = rows[0].get("batchSize")
    counts = sorted({len(group) for series in by_config(rows).values() for group in series.values()})
    cycles_text = " e ".join(str(c) for c in counts)

    fig, ax = plt.subplots(figsize=(WIDTH_IN, 3.6))
    config_lines(ax, rows, lambda r: r["durationMs"] / 1000)
    ax.set_ylabel("Tempo por ciclo (s, média ± desvio padrão)")
    ax.set_title("Custo por ciclo do monitor: varredura completa vs amostragem")
    save(fig, out_dir, "monitor-custo-tempo.png",
         f"Tempo por ciclo do monitor em função do número de lotes ({batch} registros por lote). "
         f"Média de {cycles_text} ciclos medidos por ponto (após um ciclo de aquecimento "
         "descartado); a barra indica o desvio padrão.", stem)

    fig, ax = plt.subplots(figsize=(WIDTH_IN, 3.4))
    config_lines(ax, rows, lambda r: (r["cpuUserMs"] + r["cpuSystemMs"]) / 1000)
    ax.set_ylabel("Tempo de CPU por ciclo (s, média ± desvio padrão)")
    ax.set_title("CPU por ciclo do monitor")
    save(fig, out_dir, "monitor-custo-cpu.png",
         f"Tempo de CPU (usuário + sistema) por ciclo do monitor. {CPU_CAVEAT}", stem)

    fig, ax = plt.subplots(figsize=(WIDTH_IN, 3.4))
    config_lines(ax, rows, lambda r: r["peakRssBytes"] / 2**20, legend_loc="lower right")
    ax.set_ylabel("Pico de memória (MiB, média ± desvio padrão)")
    ax.set_title("Memória por ciclo do monitor")
    save(fig, out_dir, "monitor-custo-memoria.png",
         "Pico de memória residente (RSS) do processo por ciclo; cada configuração "
         "roda em um processo próprio. A memória é praticamente a mesma nas três "
         "configurações e não cresce com M, porque o monitor audita um lote por vez.", stem)


def monitor_detection(rows, out_dir, stem):
    largest = max(r["m"] for r in rows)
    pass_rows = sorted((r for r in rows if r["m"] == largest and r["strategy"] == "shuffled-pass"
                        and r["j"] == 1), key=lambda r: r["k"])
    if len(pass_rows) >= 2:
        ks = [r["k"] for r in pass_rows]
        fig, ax = plt.subplots(figsize=(WIDTH_IN, 3.6))
        ax.plot(ks, [r["theoryWorst"] for r in pass_rows], color=INK, linestyle="--",
                linewidth=1.2, label="Pior caso teórico (2L − 1)", zorder=5)
        for key, label, color, marker in (("max", "Máximo medido", ORANGE, "s"),
                                          ("p95", "p95 medido", AQUA, "^"),
                                          ("mean", "Média medida", BLUE, "o")):
            ax.plot(ks, [r[key] for r in pass_rows], color=color, marker=marker, label=label)
        ax.set_xscale("log")
        ax.set_yscale("log")
        ax.set_xlabel("Lotes auditados da passagem por ciclo (k, escala log)")
        ax.set_ylabel("Ciclos até a detecção (escala log)")
        ax.set_title(f"Latência de detecção vs k (M = {largest}, j = 1)")
        ax.legend()
        save(fig, out_dir, "monitor-deteccao-vs-k.png",
             f"Ciclos até detectar uma adulteração persistente, por k, com {largest} lotes e "
             "1 verificação pontual por ciclo (simulação com o seletor real).", stem)
    else:
        note("monitor-deteccao-vs-k", f"menos de 2 valores de k para M = {largest}, j = 1")

    detection_vs_m(rows, out_dir, stem)

    k_target = math.ceil(largest / 30)
    available = {r["k"] for r in rows if r["m"] == largest}
    k = k_target if k_target in available else 3
    cells = {(r["strategy"], r["j"]): r for r in rows if r["m"] == largest and r["k"] == k}
    if len(cells) < 2:
        return note("monitor-estrategias", f"sem células para M = {largest}, k = {k}")
    groups = [(j, key) for j in (0, 1) for key in ("mean", "max")]
    labels = [f"{'Média' if key == 'mean' else 'Máximo'}\n(j = {j})" for j, key in groups]
    fig, ax = plt.subplots(figsize=(WIDTH_IN, 3.6))
    width = 0.38
    for i, (strategy, (label, color)) in enumerate(STRATEGIES.items()):
        xs = [g + (i - 0.5) * (width + 0.02) for g in range(len(groups))]
        values = [cells.get((strategy, j), {}).get(key, 0) for j, key in groups]
        bars = ax.bar(xs, values, width=width, color=color, label=label)
        ax.bar_label(bars, fmt="%.0f", fontsize=7, color=INK_2, padding=2)
    decimal_comma(ax)
    ax.set_xticks(range(len(groups)), labels)
    ax.set_ylabel("Ciclos até a detecção")
    ax.set_title(f"Passagem embaralhada vs sorteio independente (M = {largest}, k = {k})")
    ax.grid(axis="x", visible=False)
    ax.legend()
    save(fig, out_dir, "monitor-estrategias.png",
         f"Média e máximo de ciclos até a detecção com {largest} lotes e k = {k}: a passagem "
         "embaralhada limita o pior caso; o sorteio independente não tem limite.", stem)


def detection_vs_m(rows, out_dir, stem):
    """Fixed k = 3 vs each M's 1-hour guarantee k: cost or latency, one has to grow."""
    cells = [r for r in rows if r["strategy"] == "shuffled-pass" and r["j"] == 1]
    fixed = {r["m"]: r for r in cells if r["k"] == 3}
    guarantee = {r["m"]: r for r in cells if r["k"] == math.ceil(r["m"] / 30)}
    ms = sorted(set(fixed) & set(guarantee))
    if len(ms) < 2:
        return note("monitor-deteccao-vs-m", "menos de 2 valores de M com k = 3 e o k da garantia")

    fig, ax = plt.subplots(figsize=(WIDTH_IN, 3.8))
    ax.axhline(60, color=INK, linestyle="--", linewidth=1.2, zorder=5, label="1 hora (60 ciclos)")
    for series, label, color, marker in ((fixed, "k = 3", ORANGE, "s"),
                                         (guarantee, "k da garantia (⌈M/30⌉)", BLUE, "o")):
        ax.plot(ms, [series[m]["max"] for m in ms], color=color, marker=marker,
                label=f"{label}: máximo")
        ax.plot(ms, [series[m]["mean"] for m in ms], color=color, marker=marker,
                linestyle=":", label=f"{label}: média")
    ax.set_xscale("log")
    ax.set_yscale("log")
    ax.set_xlabel("Lotes ancorados (M, escala log)")
    ax.set_ylabel("Ciclos até a detecção (escala log)")
    ax.set_title("Latência de detecção vs lotes: k fixo vs k da garantia de 1 hora")
    ax.legend(loc="upper left", fontsize=7)
    save(fig, out_dir, "monitor-deteccao-vs-m.png",
         "Ciclos até detectar uma adulteração persistente, por número de lotes, com 1 verificação "
         "pontual por ciclo (simulação com o seletor real). Com k fixo, o custo por ciclo fica "
         "constante e a latência cresce com o histórico; com o k da garantia, a latência fica "
         "abaixo de 1 hora (cron de 1 minuto) e o custo cresce devagar.", stem)


def monitor_sizing(rows, out_dir, stem):
    names = {"1h@1min": "1 h, ciclo de 1 min", "1h@5min": "1 h, ciclo de 5 min",
             "1d@5min": "1 dia, ciclo de 5 min"}
    header = ["Lotes (M)", "Política", "Ciclos", "k necessário", "Lotes/ciclo", "% de M"]
    cells = [[f"{r['m']:,}".replace(",", "."), names.get(r["policy"], r["policy"]),
              str(r["cyclesBudget"]), str(r["kRequired"]), str(r["batchesPerCycle"]),
              f"{r['percentOfM']:.1f}".replace(".", ",") + "%"] for r in rows]
    fig, ax = plt.subplots(figsize=(WIDTH_IN, 0.3 * (len(cells) + 2)))
    ax.axis("off")
    table = ax.table(cellText=cells, colLabels=header, loc="center", cellLoc="center",
                     colWidths=[0.13, 0.27, 0.11, 0.17, 0.16, 0.16])
    table.auto_set_font_size(False)
    table.set_fontsize(8)
    table.scale(1, 1.3)
    for (row, _), cell in table.get_celld().items():
        cell.set_edgecolor(GRID)
        if row == 0:
            cell.set_text_props(color=INK, weight="bold")
            cell.set_facecolor("#f3f2ee")
    ax.set_title("Dimensionamento de k para um pior caso de detecção", pad=4)
    save(fig, out_dir, "monitor-dimensionamento.png",
         "k mínimo para garantir a detecção de adulteração persistente dentro da janela, "
         "com 1 verificação pontual por ciclo (lotes/ciclo = k + 1).", stem)


# ---------- anchor charts ----------

def group_by_n(rows):
    groups: dict[int, list[dict]] = {}
    for row in rows:
        groups.setdefault(row["n"], []).append(row)
    return dict(sorted(groups.items()))


def mean_by_n(rows):
    """One row per size: the mean of every numeric column over its repetitions."""
    averaged = []
    for n, group in group_by_n(rows).items():
        row = {"n": n, "repetitions": len(group)}
        for key, value in group[0].items():
            if isinstance(value, (int, float)) and key not in ("n", "repetition"):
                row[key] = statistics.mean(r[key] for r in group)
        averaged.append(row)
    return averaged


def repetitions_text(counts) -> str:
    low, high = min(counts), max(counts)
    if high == 1:
        return "uma execução por tamanho"
    return f"média de {low} repetições por tamanho" if low == high else \
        f"média de {low} a {high} repetições por tamanho"


def anchor_perf(rows, out_dir, stem):
    raw = group_by_n(rows)
    rows = mean_by_n(rows)
    if len(rows) < 2:
        return note("perf", "menos de 2 tamanhos no arquivo (use --file para escolher outra execução)")
    ns = [r["n"] for r in rows]
    labels = [f"{n:,}".replace(",", ".") for n in ns]

    # Per record, so every size shares one scale and the phase mix stays readable.
    fig, ax = plt.subplots(figsize=(WIDTH_IN, 3.6))
    bottom = [0.0] * len(rows)
    phases = anchor_phases(rows)
    for key, label, color in phases:
        values = [r[key] / r["n"] for r in rows]
        ax.bar(labels, values, bottom=bottom, color=color, label=label,
               edgecolor="white", linewidth=1)
        bottom = [b + v for b, v in zip(bottom, values)]
    for x, total in enumerate(bottom):
        ax.annotate(br(total), (x, total), textcoords="offset points", xytext=(0, 3),
                    ha="center", fontsize=7, color=INK_2)
    ax.set_ylim(0, max(bottom) * 1.3)
    decimal_comma(ax)
    ax.set_xlabel("Registros no lote")
    ax.set_ylabel("Tempo por registro (ms)")
    ax.set_title("Tempo por registro em cada fase da ancoragem")
    ax.grid(axis="x", visible=False)
    ax.legend(loc="upper left", ncol=2, fontsize=7)
    save(fig, out_dir, "anchor-perf-fases.png",
         "Tempo médio por registro em cada fase do anchor-service, por tamanho de lote "
         f"({repetitions_text([r['repetitions'] for r in rows])}); o número acima de cada barra "
         "é o total por registro. O tempo total do lote é esse valor vezes o número de registros.",
         stem)

    anchor_total_time(raw, out_dir, stem)
    anchor_phase_table(raw, out_dir, stem)

    has_cpu = all("cpuUserMs" in r for r in rows)
    fig, axes = plt.subplots(1, 2 if has_cpu else 1, figsize=(WIDTH_IN, 3.2), squeeze=False)
    mem_ax = axes[0][-1]
    mem_ax.plot(ns, [r["rssPeakBytes"] / 2**20 for r in rows], color=BLUE, marker="o")
    mem_ax.set_ylabel("Pico de memória (MiB)")
    mem_ax.set_title("Memória")
    if has_cpu:
        cpu_ax = axes[0][0]
        cpu_ax.plot(ns, [(r["cpuUserMs"] + r["cpuSystemMs"]) / 1000 for r in rows],
                    color=BLUE, marker="o")
        cpu_ax.set_ylabel("Tempo de CPU (s)")
        cpu_ax.set_title("CPU")
    for ax in axes[0]:
        decimal_comma(ax)
        ax.set_xscale("log")
        ax.set_xlabel("Registros (escala log)")
    caption = "Pico de memória do anchor-service por volume de registros."
    if has_cpu:
        caption = f"CPU e pico de memória do anchor-service por volume de registros. {CPU_CAVEAT}"
    else:
        print("[aviso] anchor-perf-cpu-memoria: arquivo sem colunas de CPU; só memória")
    save(fig, out_dir, "anchor-perf-cpu-memoria.png", caption, stem)


# ---------- cross-chain charts ----------

NETWORKS = {  # kind -> (label, color, marker), in legend order
    "ethereum": ("Ethereum", BLUE, "o"),
    "arbitrum": ("Arbitrum", AQUA, "^"),
    "polygon": ("Polygon PoS", ORANGE, "s"),
}
MAINNET_NOTE = ("Custo projetado com o gas estimado na mainnet de cada rede e o preço médio "
                "do gas, do token e da PTAX nos 6 meses anteriores à coleta.")


def by_kind(rows):
    groups: dict[str, list[dict]] = {}
    for row in rows:
        groups.setdefault(row["kind"], []).append(row)
    return {kind: groups[kind] for kind in NETWORKS if kind in groups}


def network_label(row) -> str:
    return f"{NETWORKS[row['kind']][0]} ({row['network']})"


def network_axes(height):
    """Log: one axis for every network. --linear: Ethereum alone on the left and the
    cheaper two on the right, each panel with its own y-axis."""
    if not LINEAR:
        fig, ax = plt.subplots(figsize=(WIDTH_IN, height))
        return fig, {kind: ax for kind in NETWORKS}, [ax]
    fig, (left, right) = plt.subplots(1, 2, figsize=(WIDTH_IN, height))
    return fig, {"ethereum": left, "arbitrum": right, "polygon": right}, [left, right]


def money_axis(axes):
    for ax in axes:
        if LINEAR:
            ax.set_ylim(bottom=0)
        else:
            ax.set_yscale("log")
        decimal_comma(ax)


def percentile(values, q):
    ordered = sorted(values)
    rank = (len(ordered) - 1) * q
    low, high = math.floor(rank), math.ceil(rank)
    return ordered[low] + (ordered[high] - ordered[low]) * (rank - low)


def reais(value: float) -> str:
    """R$ with thousands '.' and decimal ',' (two decimals from R$ 1 up, else 3 significant digits)."""
    if value >= 1:
        return "R$ " + f"{value:,.2f}".replace(",", "x").replace(".", ",").replace("x", ".")
    return "R$ " + f"{value:.3g}".replace(".", ",")


def seconds_text(value: float) -> str:
    return f"{value / 60:.1f} min".replace(".", ",") if value >= 120 else f"{value:.1f} s".replace(".", ",")


def cross_chain_times(rows, out_dir, stem):
    anchored = [r for r in rows if r.get("status") in ("finalized", "included")]
    if not anchored:
        return note("cross-chain", "nenhuma ancoragem incluída no arquivo (use --file para outra execução)")
    groups = by_kind(anchored)
    fig, ax = plt.subplots(figsize=(WIDTH_IN, 3.4))
    width = 0.36
    for i, (kind, group) in enumerate(groups.items()):
        for offset, key, label, color in ((-width / 2, "inclusionMs", "Inclusão", BLUE),
                                          (width / 2, "finalityMs", "Finalidade", ORANGE)):
            values = [r[key] / 1000 for r in group if r.get(key) is not None]
            if not values:
                continue
            mid, p95 = percentile(values, 0.5), percentile(values, 0.95)
            ax.bar(i + offset, mid, width, color=color, label=label if i == 0 else None)
            ax.plot([i + offset - width / 3, i + offset + width / 3], [p95, p95], color=INK, linewidth=1.2,
                    label="p95" if i == 0 and key == "finalityMs" else None)
            # The median's label sits above the p95 marker, so the two never collide.
            ax.text(i + offset, max(mid, p95) * 1.15, seconds_text(mid), ha="center", va="bottom",
                    fontsize=7, color=INK_2)
    ax.set_xticks(range(len(groups)), [network_label(g[0]) for g in groups.values()])
    ax.set_yscale("log")
    decimal_comma(ax)
    ax.set_ylim(top=ax.get_ylim()[1] * 2.5)
    ax.set_ylabel("Tempo desde o envio (s, escala log)")
    fig.suptitle("Tempo até a inclusão e até a finalidade por rede", fontsize=11, color=INK)
    ax.grid(axis="x", visible=False)
    ax.legend(loc="lower center", bbox_to_anchor=(0.5, 1.0), ncol=3)
    n = max(len(g) for g in groups.values())
    hours = read_meta(stem).get("options", {}).get("durationH")
    window = f" numa coleta de {br(hours)} h" if hours else ""
    save(fig, out_dir, "entre-redes-tempos.png",
         f"Mediana do tempo entre o envio da transação e sua inclusão em um bloco (1 confirmação) e "
         f"até o bloco ser finalizado, em até {n} ancoragens por rede{window} nas redes "
         "de teste; o traço indica o percentil 95. Tempos medidos por consulta periódica ao nó "
         "(inclusão a cada 1 s na Ethereum e 250 ms nas demais; finalidade a cada 30 s e 500 ms na "
         "Polygon), o que acrescenta em média meio intervalo ao valor real.", stem)


def cross_chain_cost_24h(rows, out_dir, stem):
    points = [r for r in rows if not r.get("warmUp")]
    if not points:
        return note("cross-chain-cost-24h", "sem ancoragens com custo")
    start = min(r["scheduledAt"] for r in points)
    t0 = datetime_ms(start)
    fig, axes_by_kind, axes = network_axes(3.4)
    for kind, group in by_kind(points).items():
        label, color, marker = NETWORKS[kind]
        hours = [(datetime_ms(r["scheduledAt"]) - t0) / 3_600_000 for r in group]
        axes_by_kind[kind].plot(hours, [r["costBrl"] for r in group], color=color, marker=marker,
                                markersize=3, linewidth=1.2, label=network_label(group[0]))
    money_axis(axes)
    for ax in axes:
        ax.set_xlabel("Horas desde o início da coleta")
        decimal_comma(ax, "x")
        ax.legend(loc="lower center", bbox_to_anchor=(0.5, 1.0), ncol=3, fontsize=7)
    axes[0].set_ylabel("Custo por ancoragem (R$" + (")" if LINEAR else ", escala log)"))
    fig.suptitle("Custo projetado de cada ancoragem ao longo das 24 h", fontsize=11, color=INK)
    save(fig, out_dir, "entre-redes-custo-24h.png",
         "Custo de cada ancoragem da coleta se tivesse sido paga na mainnet no mesmo instante: gas "
         "estimado na mainnet × preço do gas consultado na mainnet no momento do envio × cotação "
         "média do token e da PTAX nos 6 meses anteriores (a variação mostrada vem só do preço do "
         "gas). A primeira ancoragem de cada contrato, mais cara por inicializar o armazenamento, "
         "foi excluída.", stem)


def datetime_ms(text: str) -> float:
    from datetime import datetime
    return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp() * 1000


def cross_chain_annual(rows, out_dir, stem):
    groups = by_kind(rows)
    if not groups:
        return note("cross-chain-annual", "sem linhas")
    frequencies = sorted({r["perDay"] for r in rows})
    fig, axes_by_kind, axes = network_axes(3.6)
    for ax in axes:
        own = [k for k in groups if axes_by_kind[k] is ax]
        width = 0.8 / max(len(own), 1)
        for j, kind in enumerate(own):
            label, color, _ = NETWORKS[kind]
            values = [next(r["annualBrl"] for r in groups[kind] if r["perDay"] == f) for f in frequencies]
            xs = [i + (j - (len(own) - 1) / 2) * width for i in range(len(frequencies))]
            bars = ax.bar(xs, values, width, color=color, label=network_label(groups[kind][0]))
            ax.bar_label(bars, labels=[reais(v) for v in values], fontsize=5.5, color=INK_2,
                         padding=1, rotation=90)
        ax.set_xticks(range(len(frequencies)), [str(f) for f in frequencies])
        ax.set_xlabel("Ancoragens por dia")
        ax.grid(axis="x", visible=False)
        ax.legend(loc="lower center", bbox_to_anchor=(0.5, 1.0), ncol=3, fontsize=7)
    money_axis(axes)
    for ax in axes:  # room for the rotated labels
        ax.set_ylim(top=ax.get_ylim()[1] * (1.3 if LINEAR else 8))
    axes[0].set_ylabel("Custo anual (R$" + (")" if LINEAR else ", escala log)"))
    fig.suptitle("Custo anual projetado por frequência de ancoragem", fontsize=11, color=INK)
    scenarios = read_meta(stem).get("scenarios", {})
    ranges = "; ".join(
        f"{NETWORKS[kind][0]} {reais(scenarios[r['network']]['p10']['brl'])} a "
        f"{reais(scenarios[r['network']]['p90']['brl'])}"
        for kind, group in groups.items() for r in group[:1] if r["network"] in scenarios)
    range_text = f" Faixa por ancoragem (p10 a p90 do custo diário): {ranges}." if ranges else ""
    save(fig, out_dir, "entre-redes-projecao-anual.png",
         f"Custo anual de operação (sem o deploy) por número de ancoragens por dia; 8 por dia "
         f"(a cada 3 h) é o cenário base. {MAINNET_NOTE}{range_text}", stem)


def cross_chain_per_record(rows, out_dir, stem):
    groups = by_kind(rows)
    if not groups:
        return note("cross-chain-per-record", "sem linhas")
    fig, ax = plt.subplots(figsize=(WIDTH_IN, 3.4))
    for kind, group in groups.items():
        label, color, marker = NETWORKS[kind]
        group = sorted(group, key=lambda r: r["batchSize"])
        ax.plot([r["batchSize"] for r in group], [r["perRecordBrl"] for r in group], color=color,
                marker=marker, label=network_label(group[0]))
    ax.set_xscale("log")
    ax.set_yscale("log")
    ax.xaxis.set_major_formatter(THOUSANDS)
    decimal_comma(ax)
    ax.set_xlabel("Registros por lote (escala log)")
    ax.set_ylabel("Custo por registro (R$, escala log)")
    ax.set_title("Amortização do custo de ancoragem pelo tamanho do lote")
    ax.legend(loc="upper right")
    save(fig, out_dir, "entre-redes-custo-por-registro.png",
         f"Custo de uma ancoragem dividido pelo número de registros do lote: o custo da transação "
         f"não depende do tamanho do lote. {MAINNET_NOTE}", stem)


def write_table(out_dir: Path, name: str, header, table, stem, what: str) -> None:
    path = out_dir / name
    with path.open("w", newline="") as f:
        csv.writer(f, delimiter=";").writerows([header] + table)
    print(f"\n{path}\n  {what} (separada por ';', vírgula decimal). Dados: {stem.name}.csv.")


def plain_number(value, decimals=0) -> str:
    if value is None:
        return "—"
    return f"{value:,.{decimals}f}".replace(",", "x").replace(".", ",").replace("x", ".")


def cross_chain_summary(rows, out_dir, stem):
    header = ["Rede", "Custo por ancoragem (R$)", "Custo por ancoragem (US$)", "Custo anual, 8/dia (R$)",
              "Inclusão, mediana (s)", "Finalidade, mediana (s)", "Finalidade, p95 (s)",
              "Falhas da rede (%)", "Chamadas RPC por ancoragem", "Modelo de confiança"]
    table = [[network_label(r), reais(r["costPerAnchoringBrl"]).removeprefix("R$ "),
              ("US$ " + f"{r['costPerAnchoringUsd']:.3g}".replace(".", ",")).removeprefix("US$ "),
              reais(r["annualBaseBrl"]).removeprefix("R$ "),
              plain_number(r["inclusionMedianS"], 1), plain_number(r["finalityMedianS"], 1),
              plain_number(r["finalityP95S"], 1),
              plain_number(None if r["failureRate"] is None else 100 * r["failureRate"], 1),
              plain_number(r["rpcCallsMean"], 0), r["trustModel"]]
             for r in sorted(rows, key=lambda r: list(NETWORKS).index(r["kind"]))]
    write_table(out_dir, "entre-redes-sintese.csv", header, table, stem,
                "Tabela de síntese: custo, tempo até a finalidade e modelo de confiança")


def cross_chain_deploy(rows, out_dir, stem):
    header = ["Rede", "Gas na testnet", "Gas na mainnet (estimado)", "Custo (R$)", "Custo (US$)"]
    table = [[network_label(r), plain_number(r["testnetGasUsed"]), plain_number(r["mainnetGas"]),
              reais(r["costBrl"]).removeprefix("R$ "), f"{r['costUsd']:.3g}".replace(".", ",")]
             for r in sorted(rows, key=lambda r: list(NETWORKS).index(r["kind"]))]
    write_table(out_dir, "entre-redes-deploy.csv", header, table, stem,
                "Custo único de implantação do contrato, com o gas estimado na mainnet")


def cross_chain_gas(rows, out_dir, stem):
    header = ["Rede", "Ancoragem: gas na testnet", "Ancoragem: gas na mainnet", "Testnet/mainnet",
              "Deploy: gas na testnet", "Deploy: gas na mainnet", "Testnet/mainnet (deploy)"]
    table = [[network_label(r), plain_number(r["anchoringTestnetGas"]), plain_number(r["anchoringMainnetGas"]),
              plain_number(r["anchoringTestnetOverMainnet"], 2), plain_number(r["deployTestnetGas"]),
              plain_number(r["deployMainnetGas"]), plain_number(r["deployTestnetOverMainnet"], 2)]
             for r in sorted(rows, key=lambda r: list(NETWORKS).index(r["kind"]))]
    write_table(out_dir, "entre-redes-gas.csv", header, table, stem,
                "Gas medido na rede de teste vs estimado na mainnet (ancoragem média e deploy)")


METRICS = {"inclusionS": "Inclusão (s)", "finalityS": "Finalidade (s)", "costBrl": "Custo por ancoragem no instante (R$)"}


def cross_chain_stats(rows, out_dir, stem):
    header = ["Rede", "Medida", "n", "Média", "Desvio padrão", "Mediana", "p95", "Mínimo", "Máximo"]
    decimals = {"inclusionS": 1, "finalityS": 1, "costBrl": 4}
    table = [[network_label(r), METRICS[r["metric"]], str(r["n"])]
             + [plain_number(r[k], decimals[r["metric"]]) for k in ("mean", "stdev", "median", "p95", "min", "max")]
             for r in sorted(rows, key=lambda r: (list(NETWORKS).index(r["kind"]), list(METRICS).index(r["metric"])))]
    write_table(out_dir, "entre-redes-estatisticas.csv", header, table, stem,
                "Estatísticas por rede (sem a ancoragem de aquecimento)")


def cross_chain_counts(rows, out_dir, stem):
    header = ["Rede", "Horários", "Aquecimento", "Finalizadas", "Só incluídas", "Falhas da rede",
              "Recusadas pelo provedor", "Perdidas", "Puladas (rede ocupada)", "Chamadas RPC: média",
              "Chamadas RPC: máximo", "Chamadas RPC: total"]
    table = [[network_label(r)] + [str(r.get(k, 0)) for k in ("scheduled", "warmUp", "finalized", "included",
                                                               "failed", "providerRefused", "missed", "skippedBusy")]
             + [plain_number(r["rpcCallsMean"], 1), plain_number(r["rpcCallsMax"]), plain_number(r["rpcCallsTotal"])]
             for r in sorted(rows, key=lambda r: list(NETWORKS).index(r["kind"]))]
    write_table(out_dir, "entre-redes-contagens.csv", header, table, stem,
                "Resultado de cada horário da coleta e uso de RPC por rede; recusadas pelo provedor = "
                "limite de requisições do RPC, sem chegar à rede (fora da taxa de falhas da rede)")


# ---------- cross-chain charts with the block explorers' gas prices ----------

SCANNER_NOTE = ("Preço do gas: médias diárias do Etherscan, Polygonscan e Arbiscan nos 6 meses anteriores à "
                "coleta, que refletem o valor médio pago por transação, inclusive por remetentes dispostos a "
                "pagar por prioridade.")


def scanner_ranges(stem) -> str:
    scenarios = read_meta(stem).get("scenarios", {})
    ranges = "; ".join(f"{name} {reais(v['p10']['brl'])} a {reais(v['p90']['brl'])}" for name, v in scenarios.items())
    return f" Faixa por ancoragem (p10 a p90 do custo diário): {ranges}." if ranges else ""


def scanner_annual(rows, name, title, ylabel, caption, out_dir, stem):
    groups = by_kind(rows)
    frequencies = sorted({r["perDay"] for r in rows})
    fig, axes_by_kind, axes = network_axes(3.6)
    for ax in axes:
        own = [k for k in groups if axes_by_kind[k] is ax]
        width = 0.8 / max(len(own), 1)
        for j, kind in enumerate(own):
            values = [next(r["annualBrl"] for r in groups[kind] if r["perDay"] == f) for f in frequencies]
            xs = [i + (j - (len(own) - 1) / 2) * width for i in range(len(frequencies))]
            bars = ax.bar(xs, values, width, color=NETWORKS[kind][1], label=network_label(groups[kind][0]))
            ax.bar_label(bars, labels=[reais(v) for v in values], fontsize=5.5, color=INK_2, padding=1, rotation=90)
        ax.set_xticks(range(len(frequencies)), [str(f) for f in frequencies])
        ax.set_xlabel("Ancoragens por dia")
        ax.grid(axis="x", visible=False)
        ax.legend(loc="lower center", bbox_to_anchor=(0.5, 1.0), ncol=3, fontsize=7)
    money_axis(axes)
    for ax in axes:  # room for the rotated labels
        ax.set_ylim(top=ax.get_ylim()[1] * (1.3 if LINEAR else 8))
    axes[0].set_ylabel(ylabel + (" (R$)" if LINEAR else " (R$, escala log)"))
    fig.suptitle(title, fontsize=11, color=INK)
    save(fig, out_dir, name, caption, stem)


def scanner_cost_24h(points, mean_summary, median_summary, out_dir, stem):
    points = [r for r in points if not r.get("warmUp")]
    t0 = datetime_ms(min(r["scheduledAt"] for r in points))
    mean_of = {r["kind"]: r["costPerAnchoringBrl"] for r in mean_summary}
    median_of = {r["kind"]: r["costPerAnchoringBrl"] for r in median_summary}
    fig, axes_by_kind, axes = network_axes(3.6)
    for kind, group in by_kind(points).items():
        _, color, marker = NETWORKS[kind]
        ax = axes_by_kind[kind]
        hours = [(datetime_ms(r["scheduledAt"]) - t0) / 3_600_000 for r in group]
        ax.plot(hours, [r["costBrl"] for r in group], color=color, marker=marker, markersize=3, linewidth=1.2,
                label=network_label(group[0]))
        ax.axhline(mean_of[kind], color=color, linestyle="--", linewidth=1)
        ax.axhline(median_of[kind], color=color, linestyle=":", linewidth=1)
    money_axis(axes)
    for ax in axes:
        ax.plot([], [], color=INK_2, linestyle="--", linewidth=1, label="Média dos 6 meses")
        ax.plot([], [], color=INK_2, linestyle=":", linewidth=1, label="Mediana dos 6 meses")
        ax.set_xlabel("Horas desde o início da coleta")
        decimal_comma(ax, "x")
        ax.legend(loc="lower center", bbox_to_anchor=(0.5, 1.0), ncol=3, fontsize=6.5)
    axes[0].set_ylabel("Custo por ancoragem (R$" + (")" if LINEAR else ", escala log)"))
    fig.suptitle("Custo de cada ancoragem nas 24 h, em relação ao período de 6 meses", fontsize=11, color=INK)
    save(fig, out_dir, "entre-redes-exploradores-custo-24h.png",
         "Custo de cada ancoragem da coleta se tivesse sido paga na mainnet no mesmo instante: gas estimado na "
         "mainnet × preço do gas consultado na mainnet no envio (taxa base + gorjeta mediana; os exploradores só "
         "publicam médias diárias) × cotação e PTAX médias do período. As linhas horizontais são a média e a mediana "
         f"do custo diário em 6 meses. {SCANNER_NOTE}", stem)


def scanner_per_record(mean_rows, median_rows, out_dir, stem):
    fig, ax = plt.subplots(figsize=(WIDTH_IN, 3.4))
    for rows, linestyle, suffix in ((mean_rows, "-", ""), (median_rows, "--", ", mediana")):
        for kind, group in by_kind(rows).items():
            _, color, marker = NETWORKS[kind]
            group = sorted(group, key=lambda r: r["batchSize"])
            ax.plot([r["batchSize"] for r in group], [r["perRecordBrl"] for r in group], color=color,
                    linestyle=linestyle, marker=marker if linestyle == "-" else None,
                    linewidth=2 if linestyle == "-" else 1, label=network_label(group[0]) + suffix)
    ax.set_xscale("log")
    ax.set_yscale("log")
    ax.xaxis.set_major_formatter(THOUSANDS)
    decimal_comma(ax)
    ax.set_xlabel("Registros por lote (escala log)")
    ax.set_ylabel("Custo por registro (R$, escala log)")
    ax.set_title("Amortização do custo de ancoragem pelo tamanho do lote")
    ax.legend(loc="upper right", fontsize=6.5, ncol=2)
    save(fig, out_dir, "entre-redes-exploradores-custo-por-registro.png",
         "Custo de uma ancoragem dividido pelo número de registros do lote (linha cheia: média; tracejada: mediana): "
         f"o custo da transação não depende do tamanho do lote. {SCANNER_NOTE}", stem)


def scanner_tables(mean_summary, median_summary, mean_deploy, median_deploy, out_dir, stem):
    by_net = lambda rows: {r["network"]: r for r in rows}
    median_s, median_d = by_net(median_summary), by_net(median_deploy)
    order = lambda r: list(NETWORKS).index(r["kind"])
    money = lambda v: reais(v).removeprefix("R$ ")
    usd = lambda v: f"{v:.3g}".replace(".", ",")
    write_table(out_dir, "entre-redes-exploradores-sintese.csv",
                ["Rede", "Por ancoragem, média (R$)", "Por ancoragem, mediana (R$)", "Por ancoragem, média (US$)",
                 "Por ancoragem, mediana (US$)", "Anual 8/dia, média (R$)", "Anual 8/dia, mediana (R$)",
                 "Inclusão, mediana (s)", "Finalidade, mediana (s)", "Finalidade, p95 (s)", "Falhas da rede (%)",
                 "Modelo de confiança"],
                [[network_label(r), money(r["costPerAnchoringBrl"]), money(median_s[r["network"]]["costPerAnchoringBrl"]),
                  usd(r["costPerAnchoringUsd"]), usd(median_s[r["network"]]["costPerAnchoringUsd"]),
                  money(r["annualBaseBrl"]), money(median_s[r["network"]]["annualBaseBrl"]),
                  plain_number(r["inclusionMedianS"], 1), plain_number(r["finalityMedianS"], 1),
                  plain_number(r["finalityP95S"], 1),
                  plain_number(None if r["failureRate"] is None else 100 * r["failureRate"], 1), r["trustModel"]]
                 for r in sorted(mean_summary, key=order)],
                stem, "Tabela de síntese com o preço dos exploradores: média e mediana do custo diário")
    write_table(out_dir, "entre-redes-exploradores-deploy.csv",
                ["Rede", "Gas na testnet", "Gas na mainnet (estimado)", "Custo, média (R$)", "Custo, mediana (R$)",
                 "Custo, média (US$)", "Custo, mediana (US$)"],
                [[network_label(r), plain_number(r["testnetGasUsed"]), plain_number(r["mainnetGas"]),
                  money(r["costBrl"]), money(median_d[r["network"]]["costBrl"]),
                  usd(r["costUsd"]), usd(median_d[r["network"]]["costUsd"])]
                 for r in sorted(mean_deploy, key=order)],
                stem, "Custo único de implantação com o preço dos exploradores")


def scanner_charts(loaded, out_dir) -> None:
    table = lambda statistic, name: loaded.get(f"cross-chain-scanner-{statistic}-{name}")
    needed = ["summary", "annual", "per-record", "deploy", "cost-24h"]
    missing = [f"{s}-{n}" for s in ("mean", "median") for n in needed if not table(s, n)]
    if len(missing) == 2 * len(needed):
        return
    if missing:
        return note("cross-chain-scanner", f"faltam as tabelas {', '.join(missing)}")
    mean_of = lambda name: table("mean", name)[0]
    median_of = lambda name: table("median", name)[0]
    stem = table("mean", "annual")[1]
    scanner_annual(mean_of("annual"), "entre-redes-exploradores-projecao-anual-media.png",
                   "Projeção de custo anual por frequência de ancoragem (média)", "Custo anual",
                   "Custo anual de operação (sem o deploy) por número de ancoragens por dia, pela média do custo "
                   f"diário nos 6 meses: é o orçamento esperado, pois inclui os dias caros. {SCANNER_NOTE}"
                   f"{scanner_ranges(stem)}", out_dir, stem)
    scanner_annual(median_of("annual"), "entre-redes-exploradores-projecao-anual-mediana.png",
                   "Ritmo de um dia típico, anualizado (mediana)", "Custo anualizado",
                   "Custo de um dia típico, anualizado, por número de ancoragens por dia: a mediana do custo diário "
                   "nos 6 meses × 365. Mostra quanto o ano custaria se todos os dias fossem típicos; não é uma "
                   f"previsão de gasto, pois não inclui o peso dos dias caros. {SCANNER_NOTE}", out_dir,
                   table("median", "annual")[1])
    scanner_cost_24h(mean_of("cost-24h"), mean_of("summary"), median_of("summary"), out_dir, table("mean", "cost-24h")[1])
    scanner_per_record(mean_of("per-record"), median_of("per-record"), out_dir, table("mean", "per-record")[1])
    scanner_tables(mean_of("summary"), median_of("summary"), mean_of("deploy"), median_of("deploy"), out_dir,
                   table("mean", "summary")[1])


def anchor_phases(rows):
    """Tree and proofs apart when the run measured them apart; together for older runs."""
    common = (("scanMs", "Leitura", BLUE), ("validateMs", "Verificação das assinaturas", ORANGE),
              ("leafMs", "Folhas", AQUA))
    if all("treeBuildMs" in r for r in rows):
        return common + (("treeBuildMs", "Árvore", YELLOW), ("proofsMs", "Provas", MAGENTA))
    return common + (("treeMs", "Árvore e provas", YELLOW),)


def anchor_total_time(raw, out_dir, stem):
    """Total time per batch on linear axes: a straight line means linear cost."""
    ns = sorted(raw)
    totals = [[r["totalMs"] / 1000 for r in raw[n]] for n in ns]
    means = [statistics.mean(t) for t in totals]
    spreads = [statistics.stdev(t) if len(t) > 1 else 0.0 for t in totals]
    # Least-squares slope through the origin: the average cost per record.
    slope_ms = 1000 * sum(n * m for n, m in zip(ns, means)) / sum(n * n for n in ns)

    fig, ax = plt.subplots(figsize=(WIDTH_IN, 3.6))
    ax.errorbar(ns, means, yerr=spreads, color=BLUE, marker="o", capsize=3, elinewidth=1,
                label="Média ± desvio padrão")
    ax.plot([0, ns[-1]], [0, slope_ms * ns[-1] / 1000], color=INK_2, linestyle="--",
            linewidth=1, label=f"Reta de {br(slope_ms)} ms por registro")
    ax.set_xlim(left=0)
    ax.set_ylim(bottom=0)
    ax.xaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{int(v):,}".replace(",", ".")))
    decimal_comma(ax)
    ax.set_xlabel("Registros no lote")
    ax.set_ylabel("Tempo total por lote (s)")
    ax.set_title("Tempo de processamento de um lote na ancoragem")
    ax.legend(loc="upper left")
    counts = [len(t) for t in totals]
    save(fig, out_dir, "anchor-perf-tempo.png",
         "Tempo total de processamento de um lote no anchor-service (leitura, verificação das "
         "assinaturas, folhas e árvore com provas), sem chamadas à blockchain "
         f"({repetitions_text(counts)}, após uma execução de aquecimento descartada; a barra indica "
         f"o desvio padrão). A reta tracejada é o ajuste de {br(slope_ms)} ms por registro.", stem)


def anchor_phase_table(raw, out_dir, stem):
    """Mean time per record in each phase, per size: a summary to paste as a table."""
    all_rows = [r for group in raw.values() for r in group]
    phases = [(key, label.replace("Verificação das assinaturas", "Assinaturas"))
              for key, label, _ in anchor_phases(all_rows)]
    header = ["Registros"] + [f"{label} (ms/reg)" for _, label in phases] + \
             [f"{label} (%)" for _, label in phases] + ["Total médio (s)", "Desvio (s)", "Repetições"]
    table = []
    for n in sorted(raw):
        group = raw[n]
        total = statistics.mean(r["totalMs"] for r in group)
        totals_s = [r["totalMs"] / 1000 for r in group]
        per_record = [statistics.mean(r[key] for r in group) / n for key, _ in phases]
        shares = [100 * statistics.mean(r[key] for r in group) / total for key, _ in phases]
        table.append([f"{n:,}".replace(",", ".")]
                     + [f"{v:.3f}".replace(".", ",") for v in per_record]
                     + [f"{v:.0f}" for v in shares]
                     + [f"{total / 1000:.2f}".replace(".", ","),
                        f"{statistics.stdev(totals_s) if len(totals_s) > 1 else 0:.2f}".replace(".", ","),
                        str(len(group))])

    path = out_dir / "anchor-perf-fases-tabela.csv"
    with path.open("w", newline="") as f:
        csv.writer(f, delimiter=";").writerows([header] + table)
    print(f"\n{path}\n  Tabela (separada por ';', vírgula decimal) para importar no Google Docs/Sheets. "
          f"Dados: {stem.name}.csv.")
    widths = [max(len(row[i]) for row in [header] + table) for i in range(len(header))]
    for row in [header] + table:
        print("  " + "  ".join(cell.rjust(w) for cell, w in zip(row, widths)))


def anchor_vs_audit(perf_rows, perf_stem, audit_rows, audit_stem, out_dir):
    anchor = {n: [r["totalMs"] / 1000 for r in g] for n, g in group_by_n(perf_rows).items()}
    audit = {n: [r["totalMs"] / 1000 for r in g] for n, g in group_by_n(audit_rows).items()}
    has_drill = all("drillDownMs" in r for r in audit_rows)
    located = {n: [(r["totalMs"] + r["drillDownMs"]) / 1000 for r in g]
               for n, g in group_by_n(audit_rows).items()} if has_drill else {}
    common = sorted(set(anchor) & set(audit))
    for n in sorted(set(anchor) ^ set(audit)):
        print(f"[aviso] comparacao-ancoragem-auditoria: n = {n} só existe em uma das execuções; ficou de fora")
    if len(common) < 2:
        return note("comparacao-ancoragem-auditoria", "menos de 2 tamanhos em comum entre as duas execuções")

    perf_meta, audit_meta = read_meta(perf_stem), read_meta(audit_stem)
    if not perf_meta:
        print("[aviso] comparacao-ancoragem-auditoria: a execução do anchor não tem .meta.json; "
              "não dá para conferir se as duas rodaram na mesma máquina")
    elif perf_meta.get("cpuModel") != audit_meta.get("cpuModel"):
        print("[aviso] comparacao-ancoragem-auditoria: as duas execuções vêm de CPUs diferentes "
              f"({perf_meta.get('cpuModel')} vs {audit_meta.get('cpuModel')})")

    spread = lambda values: statistics.stdev(values) if len(values) > 1 else 0.0
    anchor_s = [statistics.mean(anchor[n]) for n in common]
    audit_s = [statistics.mean(audit[n]) for n in common]
    fig, ax = plt.subplots(figsize=(WIDTH_IN, 3.8))
    ax.errorbar(common, anchor_s, yerr=[spread(anchor[n]) for n in common], color=BLUE,
                marker="o", label="Ancoragem", capsize=3, elinewidth=1)
    ax.errorbar(common, audit_s, yerr=[spread(audit[n]) for n in common], color=ORANGE,
                marker="s", label="Auditoria (conjunto íntegro)", capsize=3, elinewidth=1)
    if has_drill:
        ax.errorbar(common, [statistics.mean(located[n]) for n in common],
                    yerr=[spread(located[n]) for n in common], color=AQUA, marker="^",
                    linestyle="--", label="Auditoria com localização (todas as provas)",
                    capsize=3, elinewidth=1)
    last_labeled = None
    for n, a, b in zip(common, anchor_s, audit_s):
        # On a linear axis the small sizes crowd near zero: label only points with room.
        if LINEAR and last_labeled is not None and n - last_labeled < 0.06 * common[-1]:
            continue
        last_labeled = n
        ratio = f"{a / b:.1f}".replace(".", ",") + "×" if b > 0 else "—"
        top = max(a, statistics.mean(located[n])) if has_drill else a  # above every marker at n
        ax.annotate(ratio, (n, top), textcoords="offset points", xytext=(0, 10),
                    ha="center", fontsize=8, color=INK_2)
    if LINEAR:
        ax.set_xlim(left=0)
        ax.set_ylim(0, ax.get_ylim()[1] * 1.15)  # room for the ratio labels above the top point
        ax.xaxis.set_major_formatter(THOUSANDS)
        decimal_comma(ax)
        ax.set_xlabel("Registros no lote")
        ax.set_ylabel("Tempo de processamento (s, média)")
    else:
        ax.set_xscale("log")
        ax.set_yscale("log")
        low, high = ax.get_ylim()
        ax.set_ylim(low, high * 2)  # room for the ratio labels above the top point
        ax.set_xlabel("Registros no lote (escala log)")
        ax.set_ylabel("Tempo de processamento (s, média; escala log)")
    ax.set_title("Processamento por conjunto de registros: ancoragem vs auditoria")
    ax.legend(loc="upper left")

    limit = (audit_meta.get("options") or {}).get("maxBatchSize")
    limit_text = f" Limite de lote (ANCHOR_MAX_BATCH_SIZE): {limit}." if limit else ""
    save(fig, out_dir, "comparacao-ancoragem-auditoria.png",
         "Tempo total para processar um lote com n registros, sem chamadas à blockchain "
         f"({repetitions_text([len(anchor[n]) for n in common] + [len(audit[n]) for n in common])}, "
         "após uma execução de aquecimento descartada; a barra indica o desvio padrão). "
         + ("A linha tracejada soma ao caminho íntegro a verificação da prova de cada registro, "
            "o pior caso para localizar um registro adulterado. " if has_drill else "")
         + "Ancoragem: leitura, verificação das assinaturas, folhas e árvore com a geração e a "
         "conferência da prova de cada registro; auditoria: leitura dos registros e provas, folhas "
         "e reconstrução da raiz. A razão reflete o conjunto dessas diferenças, não só as "
         "assinaturas. O número acima de cada ponto é "
         f"a razão ancoragem/auditoria.{limit_text} Ancoragem: {perf_stem.name}.csv.",
         audit_stem)


def note(what: str, why: str) -> None:
    print(f"[pulado] {what}: {why}")


CHARTS = {
    "monitor-perf": monitor_perf,
    "monitor-detection": monitor_detection,
    "monitor-sizing": monitor_sizing,
    "perf": anchor_perf,
    "cross-chain": cross_chain_times,
    "cross-chain-cost-24h": cross_chain_cost_24h,
    "cross-chain-annual": cross_chain_annual,
    "cross-chain-per-record": cross_chain_per_record,
    "cross-chain-summary": cross_chain_summary,
    "cross-chain-deploy": cross_chain_deploy,
    "cross-chain-gas": cross_chain_gas,
    "cross-chain-stats": cross_chain_stats,
    "cross-chain-counts": cross_chain_counts,
    # monitor-audit-cost has no chart of its own; it feeds the comparison below.
}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("results_dir", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--file", type=Path, action="append", default=[])
    parser.add_argument("--linear", action="store_true",
                        help="eixos lineares nos gráficos de custo por ciclo e de comparação")
    args = parser.parse_args()

    if not args.results_dir.is_dir():
        sys.exit(f"{args.results_dir} is not a directory")
    out_dir = args.out or args.results_dir / "charts"
    out_dir.mkdir(parents=True, exist_ok=True)
    style()
    global LINEAR
    LINEAR = args.linear

    runs = find_runs(args.results_dir, args.file)
    pinned = {path.with_suffix("") for path in args.file}
    loaded: dict[str, tuple[list[dict], Path]] = {}
    for prefix in PREFIXES:
        stem = runs.get(prefix)
        if stem is None:
            note(prefix, "nenhum arquivo deste tipo no diretório")
            continue
        meta = read_meta(stem)
        if meta.get("incomplete"):
            failed = json.dumps(meta.get("failedCell"))
            if stem not in pinned:
                note(prefix, f"{stem.name} é uma execução incompleta (falhou em {failed}); "
                             "use --file para gerar os gráficos dela mesmo assim")
                continue
            print(f"[aviso] {prefix}: {stem.name} é uma execução incompleta (falhou em {failed})")
        rows = load_rows(stem)
        if not rows:
            note(prefix, f"{stem.name} não tem linhas")
            continue
        loaded[prefix] = (rows, stem)
        if prefix in CHARTS:
            CHARTS[prefix](rows, out_dir, stem)

    if "perf" in loaded and "monitor-audit-cost" in loaded:
        anchor_vs_audit(*loaded["perf"], *loaded["monitor-audit-cost"], out_dir)
    scanner_charts(loaded, out_dir)


if __name__ == "__main__":
    main()
