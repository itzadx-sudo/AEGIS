# Aegis — IT Risk Assessment Tool (Local LLM)

Fully local. No cloud. No external APIs. Vendor documents never leave the machine.

## Hardware Tested
- Ubuntu VM: NVIDIA GRID T4-8Q 8GB VRAM · 24 CPU · 64GB RAM
  - LLM + embedding models both run on the GPU via compiled `llama.cpp` (see Setup).

---

## How It Works (System Flow)

```
YOUR ORG DOCS (once)                    VENDOR DOCS (per assessment)
──────────────────────────────────────  ──────────────────────────────────
Internal Policy PDFs  ──┐               Vendor filled HECVAT (Excel)
HECVAT Template xlsx  ──┼──► ChromaDB   Vendor SOC 2 Type 2 PDF  ──► ChromaDB
                        │   (vector DB) Other vendor docs (PDF)   ──► ChromaDB
                        │
                        ▼
                   At assessment time:
                   For each HECVAT control question + vendor answer:
                     1. RAG retrieves:
                        - Context A: relevant internal policy chunks
                        - Context B: relevant vendor evidence chunks (SOC2 etc.)
                     2. If policy similarity < 0.45 → INSUFFICIENT_EVIDENCE (no LLM)
                     3. LLM reads both contexts → assesses gap
                     4. JSON output: status, risk_level, risk_score (0–100)
                   
                   Aggregate:
                     - Per-section risk scores
                     - Overall risk score (0–100) + band (LOW/MEDIUM/HIGH/CRITICAL)
                     - PDF report + Excel risk register
```

### Why Agentic RAG (not naive)?

The system uses **agentic multi-source RAG** — it routes queries to the right
collections (internal policies vs vendor evidence) and combines them into a
structured dual-context prompt. Naive RAG (single collection, one retrieval)
would mix policy with evidence and confuse the LLM about what is *required*
vs what the vendor *claims*. Graph RAG would be overkill for structured Excel data.

---

## Setup

Inference runs on the **GPU** via a compiled `llama.cpp` server (not Ollama, which falls
back to CPU on this VM). Two GGUF models are served — the LLM and the embedding model.

### 1. Install Python dependencies
```bash
pip install -r requirements.txt
```

### 2. Get the GGUF models (one-time)
Place the GGUFs in `/home/td01/models/` and point `config.py` at them
(`LLM_GGUF_PATH`, `EMBED_GGUF_PATH`). The embedding model:
```bash
python -c "from huggingface_hub import hf_hub_download; \
  hf_hub_download(repo_id='nomic-ai/nomic-embed-text-v1.5-GGUF', \
  filename='nomic-embed-text-v1.5.f16.gguf', local_dir='/home/td01/models')"
```

### 3. GPU engine
The CLI **auto-starts** the GPU engine (and shuts it down on exit), so no manual step is
needed for `ingest` / `assess` / `followup`. To run the two GPU servers by hand instead:
```bash
./run_gpu.sh        # LLM on :8000 + embeddings on :8001, all layers on GPU
```

---

## Step 1 — Build Knowledge Base (run once, re-run when docs change)

**Your org's internal policies:**
```bash
python main.py ingest policy path/to/ict_security_policy.pdf
python main.py ingest policy path/to/data_classification_policy.pdf
python main.py ingest policy path/to/incident_response_policy.pdf
```

**HECVAT template** (the framework question structure, not a filled response):
```bash
python main.py ingest hecvat path/to/hecvat_template.xlsx
```

**Vendor SOC 2 Type 2** (vendor evidence — corroborates their HECVAT answers):
```bash
python main.py ingest soc2 path/to/vendor_soc2.pdf
```

**Any other vendor-provided docs** (pen-test results, their internal policies, etc.):
```bash
python main.py ingest vendor path/to/vendor_pentest.pdf
python main.py ingest vendor path/to/vendor_policy.pdf
```

Check what's stored:
```bash
python main.py stats
```

---

## Step 2 — Run Risk Assessment

```bash
python main.py assess path/to/vendor_filled_hecvat.xlsx \
    --service "ServiceName" \
    --output  ./reports
```

Output:
- `reports/risk_assessment_servicename_TIMESTAMP.pdf`  — full PDF report with scores
- `reports/risk_register_servicename_TIMESTAMP.xlsx`   — Excel with per-control scores + section scores tab
- `reports/findings_raw.json`                          — raw JSON for downstream use

---

## Risk Scoring

Each control gets a **numeric risk score (0–100)**:

| Factor | Values |
|---|---|
| Status penalty | GAP=1.0, INSUFFICIENT_EVIDENCE=0.75, PARTIAL=0.5, COMPLIANT=0.0 |
| Risk level severity | CRITICAL=4, HIGH=3, MEDIUM=2, LOW=1, N/A=0 |
| Section weight | Data Security / Access Control / Incident Response / Encryption = 3× |

Section scores and an overall score + band (LOW / MEDIUM / HIGH / CRITICAL) are shown
in the PDF executive summary and the Excel "Section Scores" tab.

---

## Hallucination Safeguards

- Temperature = 0 (no randomness)
- LLM only sees retrieved internal policy chunks (Context A) + vendor evidence (Context B)
- System prompt explicitly forbids referencing NIST, ISO, GDPR, HIPAA, etc.
- Similarity floor 0.45 — controls below threshold → INSUFFICIENT_EVIDENCE, no LLM call
- JSON output validated; malformed response → safe fallback, never a crash

---

## Document Roles (IMPORTANT)

| Document | Ingest command | Role in Assessment |
|---|---|---|
| Your org's policy PDFs | `ingest policy` | **Required** — defines what is required |
| HECVAT template xlsx | `ingest hecvat` | Context for control guidance text |
| Vendor SOC 2 Type 2 | `ingest soc2` | Vendor evidence — corroborates vendor claims |
| Other vendor docs | `ingest vendor` | Vendor evidence — corroborates vendor claims |
| Vendor filled HECVAT | **never ingested** | Read at runtime, assessed, discarded |

---

## Benchmark / Model Evaluation

```bash
python benchmark.py --hecvat path/to/vendor_filled_hecvat.xlsx --n 10
```

Measures tokens/second, TTFT, parse rate per model on real HECVAT controls.
Results appended to `docs/benchmark_results.md` (never overwritten).

---

## Switch Models

Edit `config.py` — point it at a different GGUF on disk (it's the source of truth that
`run_gpu.sh` reads):
```python
LLM_GGUF_PATH = "/home/td01/models/your-model-Q4_K_M.gguf"
```

Keep models ≤ 4B for the T4 VRAM budget. After changing the **embedding** model
(`EMBED_GGUF_PATH`), re-ingest the knowledge base so stored and query vectors match.

---

## File Structure
```
aegis/
├── main.py            # CLI: ingest | assess | stats | followup (auto-starts GPU engine)
├── config.py          # All settings: GPU engine GGUF paths/ports + scoring weights
├── run_gpu.sh         # Launches the two GPU llama.cpp servers from config.py
├── gpu_engine.py      # Start/stop lifecycle for the GPU engine (used by the CLI)
├── embed.py           # Embeddings via GPU :8001 with nomic query/document prefixes
├── ingest.py          # PDF + HECVAT xlsx → ChromaDB (3 collections)
├── hecvat_parser.py   # Structure-aware HECVAT xlsx parser
├── rag.py             # Dual-source retrieval (policy + vendor evidence)
├── assess.py          # Gap analysis + numeric risk scoring
├── report.py          # PDF + Excel report generation
├── benchmark.py       # Instrumented model evaluation CLI
├── results_writer.py  # Append-only benchmark log
├── chroma_db/         # ChromaDB vector store (auto-created)
├── reports/           # Assessment outputs (auto-created)
└── docs/
    └── benchmark_results.md   # Persistent; never overwritten
```
