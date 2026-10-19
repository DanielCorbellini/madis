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

PREFIXES = ["perf", "cross-chain", "monitor-perf", "monitor-detection", "monitor-sizing"]
NAME = re.compile(r"^(?P<prefix>.+)-(?P<ts>\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)\.(json|csv)$")

# Categorical slots (validated: CVD-safe on white; slots 3-4 need labels/markers).
BLUE, ORANGE, AQUA, YELLOW = "#2a78d6", "#eb6834", "#1baf7a", "#eda100"
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


def machine_line(stem: Path) -> str:
    meta_path = Path(f"{stem}.meta.json")
    if not meta_path.exists():
        return ""
    meta = json.loads(meta_path.read_text())
    gib = meta.get("totalMemBytes", 0) / 2**30
    commit = meta.get("gitCommit") or "?"
    dirty = " (com alterações locais)" if meta.get("gitDirty") else ""
    return (f" Máquina: {meta.get('cpuModel')} ({meta.get('cpuCores')} núcleos), "
            f"{gib:.0f} GiB de RAM, Node {meta.get('nodeVersion')}; commit {commit}{dirty}.")


# ---------- helpers ----------

def median(values):
    return statistics.median(values)


def p95(values):
    ordered = sorted(values)
    return ordered[max(0, math.ceil(0.95 * len(ordered)) - 1)]


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


def config_lines(ax, rows, value):
    ends = []
    for config, (label, color, marker) in CONFIGS.items():
        series = by_config(rows).get(config)
        if not series:
            continue
        ms = sorted(series)
        meds = [median([value(r) for r in series[m]]) for m in ms]
        highs = [p95([value(r) for r in series[m]]) for m in ms]
        ax.errorbar(ms, meds, yerr=[[0] * len(ms), [h - v for h, v in zip(highs, meds)]],
                    color=color, marker=marker, label=label, capsize=3, elinewidth=1)
        ends.append((ms[-1], meds[-1]))
    ax.set_xscale("log")
    decimal_comma(ax)
    label_ends(ax, ends)
    ax.set_xlabel("Lotes ancorados (M, escala log)")
    ax.legend()


# ---------- monitor charts ----------

def monitor_perf(rows, out_dir, stem):
    if len({r["m"] for r in rows}) < 2:
        return note("monitor-perf", "menos de 2 valores de M")
    batch = rows[0].get("batchSize")

    fig, ax = plt.subplots(figsize=(WIDTH_IN, 3.6))
    config_lines(ax, rows, lambda r: r["durationMs"] / 1000)
    ax.set_ylabel("Tempo por ciclo (s, mediana; barra = p95)")
    ax.set_title("Custo por ciclo do monitor: varredura completa vs amostragem")
    save(fig, out_dir, "monitor-custo-tempo.png",
         f"Tempo por ciclo do monitor em função do número de lotes ({batch} registros por lote). "
         "Mediana dos ciclos medidos; a barra indica o p95.", stem)

    fig, ax = plt.subplots(figsize=(WIDTH_IN, 3.4))
    config_lines(ax, rows, lambda r: (r["cpuUserMs"] + r["cpuSystemMs"]) / 1000)
    ax.set_ylabel("Tempo de CPU por ciclo (s, mediana)")
    ax.set_title("CPU por ciclo do monitor")
    save(fig, out_dir, "monitor-custo-cpu.png",
         f"Tempo de CPU (usuário + sistema) por ciclo do monitor. {CPU_CAVEAT}", stem)

    fig, ax = plt.subplots(figsize=(WIDTH_IN, 3.4))
    config_lines(ax, rows, lambda r: r["peakRssBytes"] / 2**20)
    ax.set_ylabel("Pico de memória (MiB, mediana)")
    ax.set_title("Memória por ciclo do monitor")
    save(fig, out_dir, "monitor-custo-memoria.png",
         "Pico de memória residente (RSS) do processo por ciclo; cada configuração "
         "roda em um processo próprio.", stem)


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

def anchor_perf(rows, out_dir, stem):
    rows = sorted(rows, key=lambda r: r["n"])
    if len(rows) < 2:
        return note("perf", "menos de 2 tamanhos no arquivo (use --file para escolher outra execução)")
    ns = [r["n"] for r in rows]
    labels = [f"{n:,}".replace(",", ".") for n in ns]

    fig, ax = plt.subplots(figsize=(WIDTH_IN, 3.6))
    bottom = [0.0] * len(rows)
    for key, label, color in (("scanMs", "Leitura", BLUE), ("validateMs", "Validação", ORANGE),
                              ("leafMs", "Folhas", AQUA), ("treeMs", "Árvore", YELLOW)):
        values = [r[key] / 1000 for r in rows]
        ax.bar(labels, values, bottom=bottom, color=color, label=label,
               edgecolor="white", linewidth=1)
        bottom = [b + v for b, v in zip(bottom, values)]
    decimal_comma(ax)
    ax.set_xlabel("Registros ancorados")
    ax.set_ylabel("Tempo (s)")
    ax.set_title("Tempo por fase da ancoragem")
    ax.grid(axis="x", visible=False)
    ax.legend()
    save(fig, out_dir, "anchor-perf-fases.png",
         "Tempo de cada fase do anchor-service por volume de registros.", stem)

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


def anchor_cross_chain(rows, out_dir, stem):
    confirmed = [r for r in rows if r.get("status") == "confirmed"]
    if not confirmed:
        return note("cross-chain", "nenhuma submissão confirmada no arquivo (use --file para outra execução)")
    chains = sorted({r["chain"] for r in confirmed})
    fig, (fee_ax, time_ax) = plt.subplots(1, 2, figsize=(WIDTH_IN, 3.2))
    fees = [median([float(r["feeNative"]) for r in confirmed if r["chain"] == c]) for c in chains]
    times = [median([r["submitToMinedMs"] / 1000 for r in confirmed if r["chain"] == c]) for c in chains]
    for ax, values, ylabel, title, fmt in (
        (fee_ax, fees, "Taxa (moeda nativa, mediana)", "Custo por âncora", "{:.2g}"),
        (time_ax, times, "Envio até mineração (s, mediana)", "Latência", "{:.1f}"),
    ):
        bars = ax.bar(chains, values, color=BLUE, width=0.5)
        ax.bar_label(bars, labels=[fmt.format(v).replace(".", ",") for v in values],
                     fontsize=7, color=INK_2, padding=2)
        ax.set_xlim(-0.75, max(len(chains), 2) - 0.25)  # one network: no full-width bar
        decimal_comma(ax)
        ax.set_ylabel(ylabel)
        ax.set_title(title)
        ax.grid(axis="x", visible=False)
    save(fig, out_dir, "anchor-cross-chain.png",
         "Custo e latência de ancoragem de uma raiz por rede (submissões confirmadas).", stem)


def note(what: str, why: str) -> None:
    print(f"[pulado] {what}: {why}")


CHARTS = {
    "monitor-perf": monitor_perf,
    "monitor-detection": monitor_detection,
    "monitor-sizing": monitor_sizing,
    "perf": anchor_perf,
    "cross-chain": anchor_cross_chain,
}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("results_dir", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--file", type=Path, action="append", default=[])
    args = parser.parse_args()

    if not args.results_dir.is_dir():
        sys.exit(f"{args.results_dir} is not a directory")
    out_dir = args.out or args.results_dir / "charts"
    out_dir.mkdir(parents=True, exist_ok=True)
    style()

    runs = find_runs(args.results_dir, args.file)
    for prefix in PREFIXES:
        stem = runs.get(prefix)
        if stem is None:
            note(prefix, "nenhum arquivo deste tipo no diretório")
            continue
        rows = load_rows(stem)
        if not rows:
            note(prefix, f"{stem.name} não tem linhas")
            continue
        CHARTS[prefix](rows, out_dir, stem)


if __name__ == "__main__":
    main()
