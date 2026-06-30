# Aegis — Model Benchmark Results

Persistent log. Appended on every run. Never overwritten.
Purpose: inform model selection for the full Aegis risk assessment system.

Backend under test: local RAG gap-assessment pipeline
(hecvat_parser -> ChromaDB retrieval -> Ollama LLM -> JSON findings).
Metrics captured per HECVAT control: tokens/second, time-to-first-token,
total latency, output tokens, retrieval time, and the resulting gap status.

---

## Run 001 — 2026-06-16T17:10:03

| Field | Value |
|---|---|
| Model | gemma3:4b |
| Platform | macOS arm64 · Ollama Metal |
| Ollama version | 0.30.4 |
| HECVAT file | HECVAT_Filled.xlsx |
| Controls evaluated | 2 (LLM calls: 2) |

### Summary metrics

| Metric | Value |
|---|---|
| Avg tokens/second | 30.64 |
| Avg time to first token | 5643.9 ms |
| Avg total latency per item | 16146.4 ms |
| Avg retrieval time | 189.9 ms |
| Parse success rate | 100% |
| Total run time | 32.7 s |

### Status distribution

INSUFFICIENT_EVIDENCE: 1 · PARTIAL: 1

### Per-item results

| Control | Section | Status | Risk | Tok/s | Latency ms | TTFT ms | Out tok | Retr ms | Parse |
|---|---|---|---|---|---|---|---|---|---|
| THRD-05 | Third-Party Management | INSUFFICIENT_EVIDENCE | MEDIUM | 30.9 | 17054 | 7826 | 285 | 342 | ✓ |
| CHNG-01 | Change Management | PARTIAL | EXTREME | 30.4 | 15238 | 3462 | 358 | 38 | ✓ |

### Notes
<!-- space for manual observations after reviewing the run -->
