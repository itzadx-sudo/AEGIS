"""
gui_app.py
Streamlit dashboard for the Aegis model benchmark.

Wraps benchmark.run_benchmark (which runs the real assessment backend) and shows:
  - Ollama status + platform header
  - Run controls (model, HECVAT file, number of controls)
  - Live metrics during a run (tokens/s, TTFT, elapsed, progress, tok/s chart)
  - A sortable per-control results table
  - Historical comparison across past runs (avg tok/s per model) from the
    append-only docs/benchmark_results.md

Run:  streamlit run gui_app.py
"""

from __future__ import annotations

import os
import sys
import glob
import time


# ── Bootstrap: allow `python gui_app.py` (e.g. PyCharm Run) to work ──────────
# Streamlit apps must run under `streamlit run`. If launched as a plain script
# (no ScriptRunContext), relaunch ourselves through the Streamlit CLI and exit.
def _has_streamlit_ctx() -> bool:
    try:
        from streamlit.runtime.scriptrunner import get_script_run_ctx
        return get_script_run_ctx() is not None
    except Exception:
        return False


if __name__ == "__main__" and not _has_streamlit_ctx():
    import subprocess
    print("Launching Streamlit…  (open http://localhost:8501)")
    sys.exit(subprocess.call(
        [sys.executable, "-m", "streamlit", "run", os.path.abspath(__file__),
         "--server.port", "8501", *sys.argv[1:]]
    ))


import pandas as pd
import streamlit as st

import config
import benchmark
import results_writer

RESULTS_PATH = "docs/benchmark_results.md"

st.set_page_config(page_title="Aegis Model Benchmark", page_icon="📊", layout="wide")


# ── Header ───────────────────────────────────────────────────────────────────

st.title("📊 Aegis — Model Benchmark")
st.caption("Performance metrics for the local HECVAT gap-assessment backend "
           "(ChromaDB retrieval → Ollama LLM → JSON findings).")

models = benchmark.list_models()
ollama_up = len(models) > 0 and models != [config.LLM_MODEL] or False
try:
    version = benchmark.get_ollama_version()
    ollama_up = version != "unknown"
except Exception:
    version = "unknown"

c1, c2, c3 = st.columns(3)
c1.metric("Ollama", "🟢 online" if ollama_up else "🔴 offline", help=config.OLLAMA_BASE_URL)
c2.metric("Ollama version", version)
c3.metric("Platform", benchmark.platform_string())

if not ollama_up:
    st.error("Ollama is not reachable on " + config.OLLAMA_BASE_URL +
             ".  Start it with `ollama serve` and reload.")
    st.stop()


# ── Controls ─────────────────────────────────────────────────────────────────

st.subheader("Run controls")

xlsx_files = sorted(glob.glob("*.xlsx"))
default_hecvat = "HECVAT_Filled.xlsx" if "HECVAT_Filled.xlsx" in xlsx_files else (
    xlsx_files[0] if xlsx_files else "")

cc1, cc2, cc3, cc4 = st.columns([2, 2, 2, 1])
with cc1:
    model = st.selectbox("Model", models,
                         index=models.index(config.LLM_MODEL) if config.LLM_MODEL in models else 0)
with cc2:
    hecvat = st.selectbox("HECVAT file", xlsx_files,
                          index=xlsx_files.index(default_hecvat) if default_hecvat else 0) \
        if xlsx_files else st.text_input("HECVAT file path", value="")
with cc3:
    # Restrict to substantive vendor-facing sheets; default to the Organization
    # governance sheet so the benchmark exercises real gap analysis, not the
    # GNRL identity metadata that always returns INSUFFICIENT_EVIDENCE.
    sheet_options = ["All vendor sheets"] + benchmark.VENDOR_SHEETS
    sheet_choice = st.selectbox("Sheet", sheet_options,
                                index=sheet_options.index(benchmark.PRIMARY_SHEET))
    sheet = None if sheet_choice == "All vendor sheets" else sheet_choice
with cc4:
    n_items = st.slider("Controls", min_value=1, max_value=50, value=10)

skip_admin = st.checkbox(
    "Skip identity metadata (GNRL / COMP / REQU)", value=True,
    help="These vendor identity/contact questions have no policy basis to assess "
         "and always return INSUFFICIENT_EVIDENCE. Off = include them.")

start = st.button("▶ Start benchmark", type="primary", width="stretch")


# ── Live run ─────────────────────────────────────────────────────────────────

if "last_run_df" not in st.session_state:
    st.session_state.last_run_df = None
    st.session_state.last_run_summary = None

if start:
    if not hecvat or not os.path.exists(hecvat):
        st.error(f"HECVAT file not found: {hecvat}")
        st.stop()

    st.subheader("Live metrics")
    m1, m2, m3, m4 = st.columns(4)
    cur_tps = m1.empty()
    cur_ttft = m2.empty()
    cur_elapsed = m3.empty()
    cur_done = m4.empty()
    progress = st.progress(0.0)
    chart_area = st.empty()
    table_area = st.empty()

    rows: list[dict] = []
    tps_series: list[float] = []
    wall0 = time.perf_counter()

    def on_item(item: benchmark.BenchmarkItem, done: int, total: int):
        rows.append({
            "Control": item.control_id,
            "Section": item.section,
            "Status": item.status,
            "Risk": item.risk_level,
            "Tok/s": item.tokens_per_second if item.llm_called else None,
            "Latency ms": round(item.total_latency_ms) if item.llm_called else None,
            "TTFT ms": round(item.time_to_first_token_ms) if item.llm_called else None,
            "Out tok": item.eval_count if item.llm_called else None,
            "Retr ms": round(item.retrieval_ms),
            "Parse": "✓" if item.parse_ok else "✗",
        })
        if item.llm_called:
            tps_series.append(item.tokens_per_second)

        cur_tps.metric("Tokens/sec (last)",
                       f"{item.tokens_per_second:.1f}" if item.llm_called else "—")
        cur_ttft.metric("TTFT (last)",
                        f"{item.time_to_first_token_ms:.0f} ms" if item.llm_called else "—")
        cur_elapsed.metric("Elapsed", f"{time.perf_counter() - wall0:.1f} s")
        cur_done.metric("Completed", f"{done}/{total}")
        progress.progress(done / total)
        if tps_series:
            chart_area.line_chart(pd.DataFrame({"tokens/sec": tps_series}))
        table_area.dataframe(pd.DataFrame(rows), width="stretch", hide_index=True)

    with st.spinner(f"Running {model} on {n_items} controls…"):
        run = benchmark.run_benchmark(hecvat, model, n_items, progress_callback=on_item,
                                      sheet=sheet, skip_admin=skip_admin)
        results_writer.write_run(run, RESULTS_PATH)

    progress.progress(1.0)
    st.success(
        f"Done · avg {run.avg_tokens_per_second} tok/s · "
        f"TTFT {run.avg_time_to_first_token_ms} ms · "
        f"latency {run.avg_latency_ms} ms · parse {run.parse_success_rate*100:.0f}% · "
        f"total {run.total_run_time_s}s  →  appended to {RESULTS_PATH}"
    )

    st.session_state.last_run_df = pd.DataFrame(rows)
    st.session_state.last_run_summary = {
        "Model": run.model,
        "Avg tok/s": run.avg_tokens_per_second,
        "Avg TTFT ms": run.avg_time_to_first_token_ms,
        "Avg latency ms": run.avg_latency_ms,
        "Parse %": round(run.parse_success_rate * 100),
        "LLM calls": run.llm_calls,
        "Status dist": run.status_distribution,
    }

elif st.session_state.last_run_df is not None:
    st.subheader("Last run")
    st.json(st.session_state.last_run_summary)
    st.dataframe(st.session_state.last_run_df, width="stretch", hide_index=True)


# ── Historical comparison ────────────────────────────────────────────────────

st.subheader("Historical comparison")
st.caption(f"Parsed from the append-only log: {RESULTS_PATH}")

history = results_writer.parse_results(RESULTS_PATH)
if not history:
    st.info("No runs logged yet. Run a benchmark to populate the history.")
else:
    hdf = pd.DataFrame(history)

    st.markdown("**Average tokens/sec per model** (mean across all logged runs)")
    by_model = hdf.groupby("model")["avg_tokens_per_second"].mean().round(2)
    st.bar_chart(by_model)

    h1, h2 = st.columns(2)
    with h1:
        st.markdown("**Avg time-to-first-token per model (ms)**")
        st.bar_chart(hdf.groupby("model")["avg_ttft_ms"].mean().round(0))
    with h2:
        st.markdown("**Parse success rate per model (%)**")
        st.bar_chart(hdf.groupby("model")["parse_success_rate"].mean().round(1))

    st.markdown("**All logged runs**")
    st.dataframe(
        hdf[["run", "timestamp", "model", "n_items", "avg_tokens_per_second",
             "avg_ttft_ms", "avg_latency_ms", "parse_success_rate"]]
        .sort_values("run", ascending=False),
        width="stretch", hide_index=True,
    )
