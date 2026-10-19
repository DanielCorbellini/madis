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
- For each kind of result (`perf`, `cross-chain`, `monitor-perf`, `monitor-detection`, `monitor-sizing`), the script charts the **newest** file by its timestamp. `--file` (repeatable) pins a specific run of that kind instead, e.g. an older `perf` run with more sizes.
- **Runs are never combined.** Each run is already a complete experiment (repeats happen inside it), and mixing runs could silently mix setups. To check stability, run a bench twice, compare, and chart one.
- Rows are read from the `.json` file. The `.csv` is only a fallback, since the writer doesn't quote commas inside values.
- A kind with no file, or with no usable rows (a `perf` file with a single size, or a `cross-chain` file with no confirmed submission), is skipped with a `[pulado]` note. The script still exits 0.
- For each chart it prints a suggested Portuguese caption, including the source file and a one-line machine summary from the run's `.meta.json`.

| Chart | From |
|---|---|
| `monitor-custo-tempo.png`, `monitor-custo-cpu.png`, `monitor-custo-memoria.png` | `monitor-perf` |
| `monitor-deteccao-vs-k.png`, `monitor-estrategias.png` | `monitor-detection` |
| `monitor-dimensionamento.png` | `monitor-sizing` |
| `anchor-perf-fases.png`, `anchor-perf-cpu-memoria.png` | `perf` |
| `anchor-cross-chain.png` | `cross-chain` |

## Smoke check

`fixtures/` holds **synthetic** monitor results (fake numbers, timestamp 2026-01-01) in the exact formats the benches write. Both commands must exit 0:

```bash
tools/bench-charts/.venv/bin/python tools/bench-charts/plot.py tools/bench-charts/fixtures --out /tmp/charts-fixtures
tools/bench-charts/.venv/bin/python tools/bench-charts/plot.py apps/anchor-service/bench/results --out /tmp/charts-anchor
```

The first draws the 6 monitor charts. The second draws whichever anchor charts the newest anchor runs support, and notes the rest.
