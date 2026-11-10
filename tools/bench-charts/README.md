# bench-charts

Turns a bench `results/` directory into PNG charts (Portuguese labels, 200 dpi, one Google Docs page wide) for the thesis.

## Setup (once)

```bash
python3 -m venv tools/bench-charts/.venv
tools/bench-charts/.venv/bin/pip install -r tools/bench-charts/requirements.txt
```

## Usage

```bash
tools/bench-charts/.venv/bin/python tools/bench-charts/plot.py <results-dir> [--out <dir>] [--file <path> ...]
```

- `<results-dir>` is `apps/monitor-service/bench/results` or `apps/anchor-service/bench/results`.
- Charts go to `<results-dir>/charts/` unless `--out` is given.
- For each kind of result (`perf`, `cross-chain`, `monitor-perf`, `monitor-detection`, `monitor-sizing`, `monitor-audit-cost`, and the cross-chain projection's `cross-chain-cost-24h`, `cross-chain-annual`, `cross-chain-per-record`, `cross-chain-summary`, `cross-chain-deploy`, `cross-chain-gas`), the script charts the **newest** file by its timestamp. `--file` (repeatable) pins a specific run of that kind instead, e.g. an older `perf` run with more sizes.
- **Runs are never combined.** Each run is already a complete experiment (repeats happen inside it), and mixing runs could silently mix setups. To check stability, run a bench twice, compare, and chart one.
- Rows are read from the `.json` file. The `.csv` is only a fallback, since the writer doesn't quote commas inside values.
- A kind with no file, or with no usable rows (a `perf` file with a single size, or a `cross-chain` run with no included anchoring), is skipped with a `[pulado]` note. The script still exits 0.
- For each chart it prints a suggested Portuguese caption, including the source file and a one-line machine summary from the run's `.meta.json`.

| Chart | From |
|---|---|
| `monitor-custo-tempo.png`, `monitor-custo-cpu.png`, `monitor-custo-memoria.png` | `monitor-perf` |
| `monitor-deteccao-vs-k.png`, `monitor-estrategias.png` | `monitor-detection` |
| `monitor-dimensionamento.png` | `monitor-sizing` |
| `anchor-perf-fases.png`, `anchor-perf-cpu-memoria.png` | `perf` |
| `entre-redes-tempos.png` (median + p95 marker), `entre-redes-tempos-mediana.png` (median only) | `cross-chain` (the collection run) |
| `entre-redes-custo-24h.png` | `cross-chain-cost-24h` |
| `entre-redes-projecao-anual.png` | `cross-chain-annual` (p10–p90 range in the caption, from its `.meta.json`) |
| `entre-redes-custo-por-registro.png` | `cross-chain-per-record` |
| `entre-redes-sintese.csv`, `entre-redes-deploy.csv`, `entre-redes-gas.csv` | `cross-chain-summary`, `cross-chain-deploy`, `cross-chain-gas` |
| `entre-redes-exploradores-projecao-anual-media.png` (annual budget), `-projecao-anual-mediana.png` (a typical day, annualized), `-projecao-anual-media-horizontal.png` and `-mediana-horizontal.png` (the same data with horizontal bars and larger labels; log mode only), `-custo-24h.png` (with the period's mean and median as reference lines), `-custo-por-registro.png`, `-sintese.csv`, `-deploy.csv` | `cross-chain-scanner-{mean,median}-{annual,cost-24h,per-record,summary,deploy}`, all ten needed |
| `comparacao-ancoragem-auditoria.png` | `perf` + `monitor-audit-cost` together |

### Cross-chain comparison

The collection run and the projection tables live in `apps/anchor-service/bench/results`. Chart them from there, pinning the official run and projection with `--file` (all six projection files share one timestamp):

```bash
tools/bench-charts/.venv/bin/python tools/bench-charts/plot.py apps/anchor-service/bench/results \
  --file apps/anchor-service/bench/results/cross-chain-<runId>.json \
  --file apps/anchor-service/bench/results/cross-chain-annual-<timestamp>.json  # …and the other five
```

The cost charts are on a log y-axis; with `--linear` they become two linear panels (Ethereum on the left, Polygon and Arbitrum on the right, each with its own axis). The times chart is always log.

### Anchoring vs auditing comparison

The two runs live in different directories, so pin the anchor run with `--file`:

```bash
tools/bench-charts/.venv/bin/python tools/bench-charts/plot.py apps/monitor-service/bench/results \
  --file apps/anchor-service/bench/results/perf-<timestamp>.json
```

Only sizes present in both runs are plotted; others are noted, and fewer than 2 common sizes skips the chart. A warning is printed if the two runs came from different CPUs, or if the anchor run has no `.meta.json` to check. Pinning the anchor run also redraws the anchor charts into the monitor's `charts/`, which is harmless.

## Smoke check

`fixtures/` holds **synthetic** monitor and anchor results (fake numbers, timestamp 2026-01-01) in the exact formats the benches write. Both commands must exit 0:

```bash
tools/bench-charts/.venv/bin/python tools/bench-charts/plot.py tools/bench-charts/fixtures --out /tmp/charts-fixtures
tools/bench-charts/.venv/bin/python tools/bench-charts/plot.py apps/anchor-service/bench/results --out /tmp/charts-anchor
```

The first draws the 6 monitor charts, the 2 anchor `perf` charts and the anchoring vs auditing comparison. The second draws whichever anchor charts the newest anchor runs support, and notes the rest.
