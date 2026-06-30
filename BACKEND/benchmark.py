"""
benchmark.py
Model-reporting metrics layer built ON TOP OF the existing assessment backend.

It reuses the real pipeline (hecvat_parser -> rag.retrieve -> assess.build_prompt ->
LLM -> assess.parse_llm_response) but swaps the plain `assess.call_llm` for an
instrumented, streaming LLM call that captures:

  - time_to_first_token_ms   (request sent -> first token received)
  - tokens_per_second        (eval_count / eval_duration, from Ollama's done message)
  - total_latency_ms         (request sent -> last token)
  - eval_count               (output tokens generated)
  - prompt_tokens            (prompt_eval_count)
  - retrieval_ms             (time spent in rag.retrieve for the item)

Each item still produces the real assessment status (COMPLIANT / PARTIAL / GAP /
INSUFFICIENT_EVIDENCE), so the benchmark reflects genuine model behaviour, not a toy
prompt. Low-similarity controls take the real "no LLM call" path (D16-style omission).

Usage (CLI):
    python benchmark.py --hecvat HECVAT_Filled.xlsx --models granite4.1:3b,qwen2.5:3b --n 10
"""

from __future__ import annotations

import time
import platform
import argparse
import urllib.request
import json
from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import Callable

import ollama

import config
import rag
import assess
import results_writer


# ── Control selection ────────────────────────────────────────────────────────
# The HECVAT parses to ~2150 rows, but most are NOT vendor-facing security
# controls: analyst/scoring sheets (Institution Evaluation, High-Risk
# Evaluation, (backend scoring), Questions, …) and identity/routing metadata
# (GNRL = company/contact info, COMP = company background, REQU = routing).
# Benchmarking those produces all-INSUFFICIENT_EVIDENCE noise — there is no
# policy context that can assess a vendor's phone number. For a meaningful D2
# signal we target substantive governance/security controls.

PRIMARY_SHEET = "Organization"          # CLAUDE.md §8: primary source for the prototype

VENDOR_SHEETS = [                       # sheets that hold real vendor-facing controls
    "Organization", "Product", "Infrastructure",
    "IT Accessibility", "Case-Specific", "AI", "Privacy",
]

ADMIN_PREFIXES = {"GNRL", "COMP", "REQU"}   # identity/contact/routing — not assessable


def select_controls(controls: list, sheet: str | None = PRIMARY_SHEET,
                    skip_admin: bool = True) -> list:
    """
    Filter parsed controls down to assessable, vendor-facing ones.

    sheet=<name>  → only that sheet (default the Organization governance sheet).
    sheet=None    → all vendor sheets (excludes analyst/scoring/master-list sheets).
    skip_admin    → drop GNRL/COMP/REQU identity metadata (always INSUFFICIENT_EVIDENCE).
    """
    allowed = {sheet} if sheet else set(VENDOR_SHEETS)
    out = []
    for c in controls:
        if c["sheet"] not in allowed:
            continue
        if skip_admin and c["control_id"].split("-")[0] in ADMIN_PREFIXES:
            continue
        out.append(c)
    return out


# ── Data structures ──────────────────────────────────────────────────────────

@dataclass
class BenchmarkItem:
    control_id: str
    section: str
    sheet: str
    status: str                       # COMPLIANT | PARTIAL | GAP | INSUFFICIENT_EVIDENCE
    risk_level: str
    llm_called: bool
    parse_ok: bool
    time_to_first_token_ms: float
    tokens_per_second: float
    total_latency_ms: float
    eval_count: int                   # output tokens
    prompt_tokens: int
    retrieval_ms: float
    response_snippet: str             # first 160 chars of raw LLM output


@dataclass
class BenchmarkRun:
    model: str
    ollama_version: str
    platform: str
    timestamp: str                    # ISO 8601
    hecvat_file: str
    n_items: int
    items: list[BenchmarkItem] = field(default_factory=list)
    # aggregates (computed in finalize)
    avg_tokens_per_second: float = 0.0
    avg_latency_ms: float = 0.0
    avg_time_to_first_token_ms: float = 0.0
    avg_retrieval_ms: float = 0.0
    parse_success_rate: float = 0.0
    llm_calls: int = 0
    total_run_time_s: float = 0.0
    status_distribution: dict = field(default_factory=dict)

    def finalize(self, total_run_time_s: float) -> "BenchmarkRun":
        from collections import Counter
        called = [it for it in self.items if it.llm_called]
        self.llm_calls = len(called)
        if called:
            self.avg_tokens_per_second = round(
                sum(i.tokens_per_second for i in called) / len(called), 2)
            self.avg_latency_ms = round(
                sum(i.total_latency_ms for i in called) / len(called), 1)
            self.avg_time_to_first_token_ms = round(
                sum(i.time_to_first_token_ms for i in called) / len(called), 1)
            self.parse_success_rate = round(
                sum(1 for i in called if i.parse_ok) / len(called), 4)
        if self.items:
            self.avg_retrieval_ms = round(
                sum(i.retrieval_ms for i in self.items) / len(self.items), 1)
        self.status_distribution = dict(Counter(i.status for i in self.items))
        self.total_run_time_s = round(total_run_time_s, 1)
        return self


# ── Helpers ──────────────────────────────────────────────────────────────────

def _attr(obj, key, default=None):
    """Read a key from a dict OR a pydantic/attr object (ollama lib returns both)."""
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def get_ollama_version() -> str:
    try:
        base = config.OLLAMA_BASE_URL.rstrip("/")
        with urllib.request.urlopen(f"{base}/api/version", timeout=3) as r:
            return json.loads(r.read()).get("version", "unknown")
    except Exception:
        return "unknown"


def platform_string() -> str:
    sysname = platform.system()
    mach = platform.machine()
    label = {"Darwin": "macOS", "Linux": "Linux", "Windows": "Windows"}.get(sysname, sysname)
    backend = "Metal" if (sysname == "Darwin" and mach == "arm64") else "CPU/GPU (auto)"
    return f"{label} {mach} · Ollama {backend}"


def list_models() -> list[str]:
    """Chat-capable models pulled in Ollama (excludes the embedding model)."""
    try:
        data = ollama.list()
        models = [_attr(m, "model") or _attr(m, "name") for m in _attr(data, "models", [])]
        return sorted([m for m in models if m and config.EMBED_MODEL not in m])
    except Exception:
        return [config.LLM_MODEL]


# ── Instrumented streaming LLM call ──────────────────────────────────────────

def call_llm_metered(prompt: str, model: str) -> tuple[str, dict]:
    """
    Same call as assess.call_llm, but streamed so we can time the first token,
    and reading Server-Sent Events (SSE) chunks to manually calculate metrics.

    Returns (raw_text, metrics_dict).
    """
    messages = [
        {"role": "system", "content": config.SYSTEM_PROMPT},
        {"role": "user", "content": prompt},
    ]

    payload = {
        "model": model,
        "messages": messages,
        "temperature": 0.0,
        "top_p": 0.9,
        "stream": True,
    }

    url = "http://localhost:8000/v1/chat/completions"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST"
    )

    t0 = time.perf_counter()
    ttft_ms = 0.0
    first_token_t = 0.0          # perf_counter at first emitted token (for client tok/s)
    last_token_t = 0.0           # perf_counter at most recent token
    parts: list[str] = []
    streamed_tokens = 0          # client-side token count (chunks carrying output)
    prompt_tokens = 0

    with urllib.request.urlopen(req) as response:
        for line in response:
            if not line:
                continue
            decoded_line = line.decode("utf-8").strip()
            if not decoded_line:
                continue
            if decoded_line.startswith("data:"):
                data_str = decoded_line[5:].strip()
                if data_str == "[DONE]":
                    break
                try:
                    chunk = json.loads(data_str)
                except json.JSONDecodeError:
                    continue

                if "usage" in chunk and chunk["usage"]:
                    prompt_tokens = chunk["usage"].get("prompt_tokens", 0)

                choices = chunk.get("choices", [])
                if choices:
                    delta = choices[0].get("delta", {})
                    content = delta.get("content", "") or ""
                    thinking = delta.get("reasoning_content", "") or delta.get("thinking", "") or ""
                    emitted = bool(content or thinking)

                    if emitted:
                        now = time.perf_counter()
                        if ttft_ms == 0.0:
                            ttft_ms = (now - t0) * 1000.0
                            first_token_t = now
                        last_token_t = now
                        streamed_tokens += 1
                    if content:
                        parts.append(content)

    total_latency_ms = (time.perf_counter() - t0) * 1000.0

    gen_s = max(last_token_t - first_token_t, 0.0)
    tok_per_s = (streamed_tokens / gen_s) if (gen_s > 0 and streamed_tokens > 1) else 0.0

    text = "".join(parts).strip()
    metrics = {
        "time_to_first_token_ms": round(ttft_ms, 1),
        "tokens_per_second": round(tok_per_s, 2),
        "total_latency_ms": round(total_latency_ms, 1),
        "eval_count": int(streamed_tokens),
        "prompt_tokens": int(prompt_tokens),
    }
    return text, metrics


# ── Main benchmark loop ──────────────────────────────────────────────────────

def run_benchmark(
    hecvat_path: str,
    model: str,
    n_items: int,
    progress_callback: Callable[[BenchmarkItem, int, int], None] | None = None,
    sheet: str | None = PRIMARY_SHEET,
    skip_admin: bool = True,
) -> BenchmarkRun:
    """
    Run the real assessment pipeline against the first `n_items` assessable
    controls, capturing per-item performance metrics. `progress_callback(item,
    done, total)` is invoked after every item so a GUI can update live.

    By default this targets the Organization sheet's substantive controls
    (skipping GNRL/COMP/REQU identity metadata), so the benchmark exercises real
    gap analysis rather than vendor contact details. Pass sheet=None to span all
    vendor sheets, or skip_admin=False to include the identity questions.
    """
    controls = assess.parse_uploaded_hecvat(hecvat_path)
    controls = select_controls(controls, sheet=sheet, skip_admin=skip_admin)
    controls = controls[:n_items]
    total = len(controls)

    run = BenchmarkRun(
        model=model,
        ollama_version=get_ollama_version(),
        platform=platform_string(),
        timestamp=datetime.now().isoformat(timespec="seconds"),
        hecvat_file=hecvat_path.split("/")[-1],
        n_items=total,
    )

    wall_start = time.perf_counter()

    for idx, control in enumerate(controls, 1):
        # ── Retrieval (timed) ────────────────────────────────────────────────
        query = f"{control['question']} {control['response']}"
        r0 = time.perf_counter()
        retrieval_result = rag.retrieve(query)
        retrieval_ms = round((time.perf_counter() - r0) * 1000.0, 1)

        # ── Insufficient context → real "no LLM call" path ───────────────────
        if not rag.has_sufficient_context(retrieval_result):
            item = BenchmarkItem(
                control_id=control["control_id"],
                section=control["section"],
                sheet=control["sheet"],
                status="INSUFFICIENT_EVIDENCE",
                risk_level="N/A",
                llm_called=False,
                parse_ok=True,
                time_to_first_token_ms=0.0,
                tokens_per_second=0.0,
                total_latency_ms=0.0,
                eval_count=0,
                prompt_tokens=0,
                retrieval_ms=retrieval_ms,
                response_snippet="(no LLM call — low similarity)",
            )
            run.items.append(item)
            if progress_callback:
                progress_callback(item, idx, total)
            continue

        # ── LLM call (instrumented) ──────────────────────────────────────────
        context_block = rag.build_context_block(retrieval_result)
        prompt = assess.build_prompt(control, context_block)
        raw_out, m = call_llm_metered(prompt, model)
        finding = assess.parse_llm_response(raw_out, control)

        parse_ok = not str(finding.get("gap_description") or "").startswith(
            "LLM response could not be parsed")

        # Mirror the real pipeline: carry the critical flag, then score RMF so
        # the benchmark reports the same overall_status / rmf_level the
        # assessment engine produces. (The finding dict no longer carries a
        # flat "status" / "risk_level" — those are overall_status / rmf_level.)
        finding["is_critical"] = control.get("is_critical", False)
        rmf = assess.compute_rmf_risk(finding)

        item = BenchmarkItem(
            control_id=control["control_id"],
            section=control["section"],
            sheet=control["sheet"],
            status=finding.get("overall_status", "INSUFFICIENT_EVIDENCE"),
            risk_level=rmf.get("rmf_level", "NOT_SCORED"),
            llm_called=True,
            parse_ok=parse_ok,
            time_to_first_token_ms=m["time_to_first_token_ms"],
            tokens_per_second=m["tokens_per_second"],
            total_latency_ms=m["total_latency_ms"],
            eval_count=m["eval_count"],
            prompt_tokens=m["prompt_tokens"],
            retrieval_ms=retrieval_ms,
            response_snippet=raw_out[:160].replace("\n", " "),
        )
        run.items.append(item)
        if progress_callback:
            progress_callback(item, idx, total)

    run.finalize(time.perf_counter() - wall_start)
    return run


# ── CLI ──────────────────────────────────────────────────────────────────────

def _cli():
    p = argparse.ArgumentParser(description="Aegis model benchmark (metrics over the real backend)")
    p.add_argument("--hecvat", default="HECVAT_Filled.xlsx", help="HECVAT .xlsx to assess")
    p.add_argument("--models", default=config.LLM_MODEL,
                   help="Comma-separated Ollama models to benchmark")
    p.add_argument("--n", type=int, default=10, help="Number of controls per model")
    p.add_argument("--sheet", default=PRIMARY_SHEET,
                   help="HECVAT sheet to benchmark, or 'all' for every vendor sheet")
    p.add_argument("--include-admin", action="store_true",
                   help="Include GNRL/COMP/REQU identity metadata (off by default)")
    p.add_argument("--results", default="docs/benchmark_results.md",
                   help="Append-only results markdown path")
    args = p.parse_args()

    sheet = None if args.sheet.lower() == "all" else args.sheet

    models = [m.strip() for m in args.models.split(",") if m.strip()]
    for model in models:
        print(f"\n=== Benchmarking {model} on {args.hecvat} ({args.n} items) ===")

        def cb(item: BenchmarkItem, done: int, total: int):
            tps = f"{item.tokens_per_second:.1f} tok/s" if item.llm_called else "—"
            print(f"  [{done}/{total}] {item.control_id:<10} {item.status:<22} {tps}")

        run = run_benchmark(args.hecvat, model, args.n, progress_callback=cb,
                            sheet=sheet, skip_admin=not args.include_admin)
        results_writer.write_run(run, args.results)
        print(f"  avg {run.avg_tokens_per_second} tok/s · "
              f"TTFT {run.avg_time_to_first_token_ms} ms · "
              f"parse {run.parse_success_rate*100:.0f}% · "
              f"total {run.total_run_time_s}s")
        print(f"  → appended to {args.results}")


if __name__ == "__main__":
    _cli()
