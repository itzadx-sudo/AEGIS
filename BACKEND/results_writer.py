"""
results_writer.py
Append-only writer for docs/benchmark_results.md.

NEVER truncates or overwrites the file. Each run appends a new dated section.
Also exposes parse_results() so the GUI can read past runs for the history chart.
"""

from __future__ import annotations

import os
import re
from datetime import datetime


HEADER = """# Aegis — Model Benchmark Results

Persistent log. Appended on every run. Never overwritten.
Purpose: inform model selection for the full Aegis risk assessment system.

Backend under test: local RAG gap-assessment pipeline
(hecvat_parser -> ChromaDB retrieval -> Ollama LLM -> JSON findings).
Metrics captured per HECVAT control: tokens/second, time-to-first-token,
total latency, output tokens, retrieval time, and the resulting gap status.
"""


def _ensure_header(path: str) -> None:
    """Write the one-time header if the file does not yet exist."""
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(HEADER)


def _next_run_number(path: str) -> int:
    if not os.path.exists(path):
        return 1
    with open(path, "r", encoding="utf-8") as f:
        nums = re.findall(r"^## Run (\d+)", f.read(), re.MULTILINE)
    return (max(int(n) for n in nums) + 1) if nums else 1


def write_run(run, path: str = "docs/benchmark_results.md") -> str:
    """Append a BenchmarkRun as a Markdown section. Returns the path written."""
    _ensure_header(path)
    n = _next_run_number(path)

    status_line = " · ".join(
        f"{k}: {v}" for k, v in sorted(run.status_distribution.items())
    ) or "—"

    lines = []
    lines.append("\n---\n")
    lines.append(f"## Run {n:03d} — {run.timestamp}\n")
    lines.append("| Field | Value |")
    lines.append("|---|---|")
    lines.append(f"| Model | {run.model} |")
    lines.append(f"| Platform | {run.platform} |")
    lines.append(f"| Ollama version | {run.ollama_version} |")
    lines.append(f"| HECVAT file | {run.hecvat_file} |")
    lines.append(f"| Controls evaluated | {run.n_items} (LLM calls: {run.llm_calls}) |")
    lines.append("")
    lines.append("### Summary metrics\n")
    lines.append("| Metric | Value |")
    lines.append("|---|---|")
    lines.append(f"| Avg tokens/second | {run.avg_tokens_per_second} |")
    lines.append(f"| Avg time to first token | {run.avg_time_to_first_token_ms} ms |")
    lines.append(f"| Avg total latency per item | {run.avg_latency_ms} ms |")
    lines.append(f"| Avg retrieval time | {run.avg_retrieval_ms} ms |")
    lines.append(f"| Parse success rate | {run.parse_success_rate*100:.0f}% |")
    lines.append(f"| Total run time | {run.total_run_time_s} s |")
    lines.append("")
    lines.append("### Status distribution\n")
    lines.append(f"{status_line}\n")
    lines.append("### Per-item results\n")
    lines.append("| Control | Section | Status | Risk | Tok/s | Latency ms | TTFT ms | Out tok | Retr ms | Parse |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|")
    for it in run.items:
        parse = "✓" if it.parse_ok else "✗"
        tps = f"{it.tokens_per_second:.1f}" if it.llm_called else "—"
        lat = f"{it.total_latency_ms:.0f}" if it.llm_called else "—"
        ttft = f"{it.time_to_first_token_ms:.0f}" if it.llm_called else "—"
        out = it.eval_count if it.llm_called else "—"
        section = (it.section or "")[:24].replace("|", "\\|")
        control_id = (it.control_id or "").replace("|", "\\|")
        risk_level = (it.risk_level or "").replace("|", "\\|")
        lines.append(
            f"| {control_id} | {section} | {it.status} | {risk_level} | "
            f"{tps} | {lat} | {ttft} | {out} | {it.retrieval_ms:.0f} | {parse} |"
        )
    lines.append("")
    lines.append("### Notes\n<!-- space for manual observations after reviewing the run -->\n")

    with open(path, "a", encoding="utf-8") as f:
        f.write("\n".join(lines))

    return path


# ── Reading past runs (for the GUI history chart) ────────────────────────────

def parse_results(path: str = "docs/benchmark_results.md") -> list[dict]:
    """
    Parse the append-only log into a list of run summaries:
    {run, timestamp, model, avg_tokens_per_second, avg_ttft_ms, avg_latency_ms,
     parse_success_rate, n_items}. Best-effort; ignores malformed sections.
    """
    if not os.path.exists(path):
        return []
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()

    runs = []
    sections = re.split(r"\n## Run ", text)[1:]
    for sec in sections:
        sec = "## Run " + sec
        try:
            run_no = int(re.search(r"## Run (\d+)", sec).group(1))
            ts_m = re.search(r"## Run \d+ — (\S+)", sec)
            model_m = re.search(r"\| Model \| (.+?) \|", sec)
            n_m = re.search(r"\| Controls evaluated \| (\d+)", sec)

            def num(label):
                m = re.search(rf"\| {re.escape(label)} \| ([\d.]+)", sec)
                return float(m.group(1)) if m else 0.0

            parse_m = re.search(r"\| Parse success rate \| ([\d.]+)%", sec)
            runs.append({
                "run": run_no,
                "timestamp": ts_m.group(1) if ts_m else "",
                "model": model_m.group(1).strip() if model_m else "unknown",
                "avg_tokens_per_second": num("Avg tokens/second"),
                "avg_ttft_ms": num("Avg time to first token"),
                "avg_latency_ms": num("Avg total latency per item"),
                "parse_success_rate": float(parse_m.group(1)) if parse_m else 0.0,
                "n_items": int(n_m.group(1)) if n_m else 0,
            })
        except Exception:
            continue
    return runs
