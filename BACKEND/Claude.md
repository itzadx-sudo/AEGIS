# Claude.md — Aegis Model Evaluation Prototype

**Team Aegis · ICT302 IT Professional Practice Project · Murdoch University · Trimester 2, 2026**

> **This repo already contains a working local gap-assessment backend.** The current
> task is NOT to rebuild it. The backend (`main.py`, `assess.py`, `rag.py`, `ingest.py`,
> `hecvat_parser.py`, `config.py`, `report.py`) ingests Murdoch policy PDFs + the HECVAT
> template into ChromaDB and runs RAG-grounded gap analysis against a local **GPU
> inference engine** (compiled `llama.cpp`). See **§A. Current runtime architecture**
> for how the LLM and embedding models are served on the GPU — Ollama is **not** used
> for inference here (it runs on CPU on this VM).
>
> On top of that backend we have added a **model-evaluation / reporting layer**:
> `benchmark.py`, `results_writer.py`, and a Streamlit GUI (`gui_app.py`). This layer
> measures each model's speed and output behaviour against a real HECVAT and persists
> the results, so the team can make an informed model-selection decision (D2).
>
> Any AI agent working in this repo reads this file first and follows it exactly.
> When anything is ambiguous, make the smallest assumption, comment it in code,
> and log it in `docs/OPEN_DECISIONS.md`.

-----

## 0. What we are building and why

**Two layers live in this repo:**

**A. The assessment backend (already built — the source of truth).**

1. **Ingestion** (`ingest.py`) — parse Murdoch policy PDFs (PyMuPDF), the HECVAT
   template (`hecvat_parser.py`), and optional SOC 2 reports; chunk, embed with
   `nomic-embed-text`, and store in three ChromaDB collections.
1. **RAG retrieval** (`rag.py`) — embed a control's question+answer, retrieve the
   top-k most similar policy chunks across collections, and gate on a similarity
   floor (0.45) so weakly-grounded controls are flagged INSUFFICIENT_EVIDENCE
   without an LLM call.
1. **Gap assessment** (`assess.py`) — for each HECVAT control, build a strict
   context-only prompt, call the Ollama LLM, and parse a JSON finding with a
   status (`COMPLIANT | PARTIAL | GAP | INSUFFICIENT_EVIDENCE`) and risk level.
1. **Reports** (`report.py`) — produce a PDF risk assessment + Excel risk register.

**B. The model-evaluation / reporting layer (added on top — what this task delivers):**

1. **Benchmark runner** (`benchmark.py`) — runs the *real* assessment pipeline against
   the first N controls of a HECVAT, but swaps the plain LLM call for an instrumented,
   streaming call that captures **tokens/second, time-to-first-token, total latency,
   output tokens, and retrieval time** per control — alongside the genuine gap status.
   Runs any Ollama model by name; no backend code is changed.
1. **Persistent results log** (`results_writer.py` → `docs/benchmark_results.md`) —
   append-only. Each run adds a dated Markdown section. Never overwritten.
1. **Streamlit GUI** (`gui_app.py`) — model picker, HECVAT picker, control-count
   slider, live tokens/s + TTFT + elapsed + progress during a run, a sortable
   per-control results table, and a historical comparison chart (avg tok/s, TTFT,
   parse rate per model) read back from the append-only log.

**Why this layer?** Before committing to a model for the full system the team needs to
answer: (a) which model gives usable gap-analysis output on real HECVAT controls?
(b) how fast is it on the target hardware? (c) does a small model hold up or is a
larger one needed? The reporting layer answers all three from real runs of the
backend that already exists — evidence base for decision **D2**.

-----

## A. Current runtime architecture (GPU inference engine)

> **Why this section exists.** Earlier drafts of this doc described inference as running
> through **Ollama** (`localhost:11434`). That is no longer how the system runs: on this
> VM **Ollama falls back to the CPU**, which is too slow. Both the LLM *and* the embedding
> model are now served on the GPU by a CUDA-compiled **`llama.cpp`** (via
> `llama-cpp-python`'s OpenAI-compatible server). Ollama is only still referenced by
> `benchmark.py` for listing candidate model names — never for the assessment hot path.

### Two GPU servers (one model each)

`llama_cpp.server` serves a single model per process, so the engine is **two** processes,
both with `--n_gpu_layers -1` (all layers on the GPU — GRID **T4-8Q, 8 GB VRAM**):

| Server | Port | Model (GGUF) | Endpoint | Used by |
|--------|------|--------------|----------|---------|
| **LLM** | `8000` | `google_gemma-3-4b-it-Q4_K_M.gguf` (~2.5 GB) | `POST /v1/chat/completions` | `assess.call_llm`, `followup`, `benchmark` |
| **Embeddings** | `8001` | `nomic-embed-text-v1.5.f16.gguf` (~274 MB) | `POST /v1/embeddings` | `rag` (queries), `ingest` (documents) via `embed.py` |

VRAM budget: gemma-3-4b Q4 (~2.5 GB) + 6144-token KV cache + nomic (~0.65 GB) fits in 8 GB.

### `config.py` is the single source of truth

All paths/ports live in `config.py`: `LLM_GGUF_PATH`, `LLM_SERVER_PORT`/`LLM_SERVER_URL`,
`EMBED_GGUF_PATH`, `EMBED_SERVER_PORT`/`EMBED_SERVER_URL`, `N_GPU_LAYERS`, `LLM_NUM_CTX`,
`PYBIN`. Changing the model here changes what the launcher starts. `LLM_MODEL`/`EMBED_MODEL`
remain only as display labels / the cosmetic `"model"` field in payloads (llama.cpp ignores it).

### `run_gpu.sh` — the launcher

Repo-local, reads `config.py`, and starts both servers on the GPU. **Idempotent per port:**
if a port is already serving (e.g. you ran the legacy `start-gpu-engine` alias on :8000), it
is reused, not clobbered; it only tears down the servers it started. Run standalone with
`./run_gpu.sh` (Ctrl-C stops them). It does **not** replace the `start-gpu-engine` alias.

### `gpu_engine.py` — app-managed lifecycle

So you don't have to start the engine by hand, the **CLI manages it**: `main.py` calls
`gpu_engine.ensure_started()` for the `ingest`, `assess`, and `followup` commands (not
`stats`). It launches `run_gpu.sh` in a new process session, waits until both ports are
healthy, and registers `atexit` + SIGINT/SIGTERM handlers that **shut the GPU servers down
when the command exits**. If both ports are already healthy it reuses them and leaves them
running (only stops what it started).

### `embed.py` — embeddings helper

`rag._embed_query` and `ingest.embed_texts` both route through `embed.py`, which POSTs to
`EMBED_SERVER_URL`. nomic-embed-text needs instruction prefixes that Ollama added
implicitly; `embed.py` adds them explicitly — `search_query:` for queries,
`search_document:` for stored chunks — so query and document vectors stay aligned and the
`MIN_SIMILARITY = 0.45` floor still holds. **Switching the embedding backend means the KB
must be re-ingested** so stored + query vectors come from the same pipeline.

### Flow at a glance

```
main.py {ingest|assess|followup}
   └─ gpu_engine.ensure_started() ── launches ──► run_gpu.sh
                                                     ├─ llama_cpp.server  gemma  :8000  (GPU)
                                                     └─ llama_cpp.server  nomic  :8001  (GPU, --embedding)
   ingest:  embed.embed_documents() → :8001 → ChromaDB
   assess:  rag.retrieve() → embed.embed_query() → :8001 ;  assess.call_llm() → :8000
   on exit: gpu_engine.stop() ── SIGTERM ──► both servers shut down
```

### One-time setup (the embedding GGUF)

The nomic GGUF is not in the repo. Download it once into `/home/td01/models/`:

```bash
"$PYBIN" -c "from huggingface_hub import hf_hub_download; \
  hf_hub_download(repo_id='nomic-ai/nomic-embed-text-v1.5-GGUF', \
  filename='nomic-embed-text-v1.5.f16.gguf', local_dir='/home/td01/models')"
```

(F16 matches Ollama's previous nomic build, so similarity scores stay comparable.)

-----

## 1. Hard constraints (same as the full system — non-negotiable)

1. **100% local / offline.** No cloud LLM APIs. No telemetry. All inference runs on the
   local **GPU `llama.cpp` engine** (LLM `localhost:8000`, embeddings `localhost:8001`;
   see §A). The HECVAT is confidential — it never leaves the machine.
1. **No confidential data in git.** Only synthetic samples and the template structure
   (question IDs + question text, no vendor answers) go in the repo. Real policy docs
   and filled HECVATs are git-ignored.
1. **Cross-platform.** Runs on the Ubuntu VM (NVIDIA GRID T4-4Q, 4 GB VRAM, 24 CPU,
   64 GB RAM), macOS (Apple Silicon or Intel), and Windows. One codebase, one
   `.env.example`, platform differences handled by Ollama automatically.
1. **`benchmark_results.md` is append-only.** Never truncate or overwrite it. Each
   run appends a new dated section. This is the persistent evidence log.
1. **Models are swappable.** The default lives in `config.py` (`LLM_MODEL`, currently
   `gemma3:4b`). The benchmark runner accepts any pulled Ollama model by name
   (`--models a,b,c` or the GUI dropdown) with no code changes to the backend.

-----

## 2. Deployment targets

|Platform                |Hardware                                 |Ollama backend    |Default model (`config.LLM_MODEL`)|
|------------------------|-----------------------------------------|------------------|----------------------------------|
|**Ubuntu VM** (primary) |GRID T4-4Q 4 GB VRAM · 24 CPU · 64 GB RAM|CUDA (auto)       |`gemma3:4b`                       |
|**macOS Apple Silicon** |M1–M4 unified memory                     |Metal / MLX (auto)|`gemma3:4b`                       |
|**macOS Intel**         |CPU only                                 |CPU               |`gemma3:4b`                       |
|**Windows** (NVIDIA GPU)|Any CUDA GPU                             |CUDA (auto)       |`gemma3:4b`                       |
|**Windows** (CPU only)  |Any x64 CPU                              |CPU               |`gemma3:4b`                       |

**Model shortlist for evaluation** — the benchmark runner tests whatever is pulled in
Ollama; pass them with `--models` or pick them in the GUI. Candidates seen on the dev
machine include `gemma3:4b` (current default), `granite4.1:3b`, `qwen2.5:3b`, `ministral-3:3b`,
`gemma4:e2b`, `nemotron-3-nano:4b`, `qwen3:4b`, and `llama3.1:8b`.
The append-only `docs/benchmark_results.md` is the evidence base for choosing one (D2).

**Keep evaluation candidates at ≈4B parameters or below** for the T4-4Q (4 GB VRAM):
a 7B+ model (e.g. `llama3.1:8b`) loads but falls back to slow CPU/partial-offload
inference. Benchmark it for reference, but it is not a deployment candidate.

-----

## 3. Repository layout

The repo is flat (modules at the root), not a `backend/` package. Actual layout:

```
~ict302_project/
│
│  ── Assessment backend (already built) ─────────────────────────────
├── main.py                 # CLI: ingest | assess | stats | followup (auto-starts GPU engine)
├── config.py               # plain module: GPU engine GGUF paths/ports/URLs, CHROMA dirs, SYSTEM_PROMPT
├── run_gpu.sh              # launches the two GPU llama.cpp servers from config.py (§A)
├── gpu_engine.py           # app-managed lifecycle: start run_gpu.sh, wait healthy, stop on exit (§A)
├── embed.py                # embeddings via GPU :8001 (/v1/embeddings) with nomic query/doc prefixes
├── ingest.py               # PDF (PyMuPDF) + HECVAT xlsx → chunk → embed (GPU) → ChromaDB
├── hecvat_parser.py        # structure-aware HECVAT .xlsx parser (no fixed columns)
├── rag.py                  # embed query (GPU) → retrieve top-k chunks → context block + similarity gate
├── assess.py               # build prompt → call LLM (GPU :8000) → parse JSON finding → summarize
├── report.py               # PDF risk assessment + Excel risk register (reportlab/openpyxl)
│
│  ── Model-evaluation / reporting layer (this task) ─────────────────
├── benchmark.py            # instrumented streaming run over the real pipeline; per-control metrics
├── results_writer.py       # append-only writer + parser for docs/benchmark_results.md
├── gui_app.py              # Streamlit dashboard: live metrics, results table, history
│
│  ── Data & outputs ─────────────────────────────────────────────────
├── HECVAT_Template.xlsx    # HECVAT framework template (ingested into ChromaDB)
├── HECVAT_Filled.xlsx      # a filled vendor HECVAT to assess / benchmark against
├── ICT Security Policy 1.pdf, ICT Security Standard 1.pdf, IT Conditions of Use Policy 1.pdf
├── chroma_db/              # ChromaDB persistent dir (internal_policies, hecvat_template, soc2_controls)
├── reports/                # generated PDF/Excel/JSON assessment outputs
├── docs/
│   └── benchmark_results.md   # ← PERSISTENT; appended every benchmark run; never overwritten
├── requirements.txt
└── README.md
```

> **Note on confidentiality (constraint §1):** the policy PDFs and filled HECVATs in the
> repo root are real working data on the dev machine and must be git-ignored before any
> push. `docs/benchmark_results.md` contains only metrics + control IDs, so it is safe to
> commit.

-----

## 4. Tech stack

### Backend (Python)

|Concern      |Choice (actual)                       |Notes                                                    |
|-------------|--------------------------------------|---------------------------------------------------------|
|Language     |**Python 3.12+**                      |Dev machine runs 3.14                                    |
|Settings     |**plain `config.py` module**          |Constants (`LLM_MODEL`, `CHROMA_DIR`, `SYSTEM_PROMPT`, …). No pydantic/.env yet|
|LLM runtime  |**compiled `llama.cpp`** (`llama-cpp-python` server) |GPU, `localhost:8000`; started by `run_gpu.sh` (§A). Ollama not used (CPU here)|
|Default model|**`gemma-3-4b-it` Q4_K_M GGUF** (`config.LLM_GGUF_PATH`)|All layers on GPU (`--n_gpu_layers -1`)|
|LLM client   |**stdlib `urllib`** → `POST /v1/chat/completions`     |`assess.call_llm`; benchmark streams the same endpoint for metric capture|
|Embeddings   |**`nomic-embed-text-v1.5` f16 GGUF** on GPU `:8001`   |`embed.py` → `POST /v1/embeddings` (query/document prefixes) for RAG|
|Vector store |**ChromaDB** (persistent)             |`./chroma_db/` dir; cosine space; git-ignored            |
|HECVAT parse |**openpyxl**                          |Structure-aware (`hecvat_parser.py`); no fixed columns   |
|Policy parse |**PyMuPDF (`fitz`)**                  |Page-by-page PDF text extraction                         |
|Chunking     |**langchain-text-splitters**          |`RecursiveCharacterTextSplitter`, ~400-token chunks      |
|Reports      |**reportlab + openpyxl**              |PDF risk assessment + Excel risk register                |
|Results log  |**stdlib** (file append)              |`results_writer.py` appends Markdown to `docs/benchmark_results.md`|

### GUI

|Concern     |Choice                                    |Notes                                            |
|------------|------------------------------------------|-------------------------------------------------|
|Framework   |**Streamlit**                             |Fast to build; sufficient for a metrics dashboard|
|Live metrics|`st.metric`, `st.progress`, `st.dataframe`|Tokens/s gauge, per-query table, totals          |
|Charts      |`st.line_chart`                           |Tokens/s over time during a run                  |


> **Why Streamlit not React?** The prototype is a benchmark tool, not a polished product.
> Streamlit is 20x faster to build for this specific use case (metrics dashboard +
> run controls). React is reserved for the full system UI. This decision is logged as D21.

### Configuration — `config.py` (no `.env` yet)

Settings are plain module constants. Anything model/path related is changed here or,
for benchmarks, overridden via CLI flags / the GUI:

```python
# GPU engine (see §A) — config.py is the single source of truth
PYBIN           = "/home/td01/.pyenv/versions/aegis-env-3.12/bin/python"
LLM_GGUF_PATH   = "/home/td01/models/google_gemma-3-4b-it-Q4_K_M.gguf"
LLM_SERVER_URL  = "http://localhost:8000/v1/chat/completions"
EMBED_GGUF_PATH = "/home/td01/models/nomic-embed-text-v1.5.f16.gguf"
EMBED_SERVER_URL= "http://localhost:8001/v1/embeddings"
N_GPU_LAYERS    = -1          # all layers on GPU
LLM_NUM_CTX     = 6144

LLM_MODEL   = "qwen3.5:4b"        # label only (payload "model" field; llama.cpp ignores it)
EMBED_MODEL = "nomic-embed-text"  # label only
OLLAMA_BASE_URL = "http://localhost:11434"  # legacy: benchmark.py model-listing only

CHROMA_DIR = "./chroma_db"
CHROMA_COLLECTION_POLICIES        = "internal_policies"
CHROMA_COLLECTION_HECVAT_TEMPLATE = "hecvat_template"
CHROMA_COLLECTION_SOC2            = "soc2_controls"

CHUNK_SIZE = 400        # approx tokens
CHUNK_OVERLAP = 120
TOP_K_RESULTS = 6       # chunks retrieved per query

SYSTEM_PROMPT = "...strict context-only IT-risk analyst prompt (see config.py)..."
```

> Migrating to `pydantic-settings` + `.env` is a reasonable future cleanup, but it is
> **not** required for the prototype and is not yet implemented. Don't assume a `.env`
> file exists.

-----

## 5. Data flow

```
Policy PDFs + HECVAT template            (ingest once — ingest.py)
        │
        ▼ PyMuPDF / hecvat_parser
  RecursiveCharacterTextSplitter (~400 tok)
        │
        ▼ nomic-embed-text GGUF on GPU :8001 (embed.py, "search_document:" prefix)
   ChromaDB (chroma_db/) ──────────────────────────┐
   internal_policies · hecvat_template · soc2       │ rag.retrieve(query, top_k)
                                                    │   embeds query, cosine search,
Filled HECVAT.xlsx  (assess / benchmark target)     │   converts distance→similarity
  │ hecvat_parser (never embedded — runtime only)   │
  ▼                                                 │
controls: {control_id, section, sheet, question,    │
           response, evidence, guidance}            │
  │                                                 │
  ▼ for each control:                               │
  ├─ rag.retrieve() ◀──────────────────────────────┘
  ├─ has_sufficient_context()? (sim ≥ 0.45)
  │     └─ no  → status INSUFFICIENT_EVIDENCE, NO LLM call
  ├─ assess.build_prompt(control, context_block)   (strict context-only)
  ├─ LLM call  → finding JSON   (GPU llama.cpp :8000 /v1/chat/completions)
  │     • backend:   assess.call_llm()        (urllib, non-streaming)
  │     • benchmark: call_llm_metered()       (streamed — captures
  │                    TTFT · tokens/sec · latency · output tokens)
  ├─ assess.parse_llm_response() → {status, risk_level, gap, recommendation, …}
  └─ outputs:
        • backend   → reports/ PDF + Excel + findings_raw.json   (report.py)
        • benchmark → BenchmarkItem → append to docs/benchmark_results.md

GUI (gui_app.py, Streamlit) drives the benchmark path and shows, per control:
  ├─ live tokens/s, TTFT, elapsed, progress (updated via progress_callback)
  ├─ a line chart of tokens/s across controls
  ├─ a sortable results table (control, status, tok/s, latency, TTFT, parse)
  └─ historical comparison across past runs (avg tok/s / TTFT / parse per model)
```

-----

## 6. Module specs

### Backend (already built — do not rewrite without reason)

#### `hecvat_parser.py`

Structure-aware parser for real HECVAT `.xlsx` files using **openpyxl** — there are
**no fixed column positions**. It reads merged-cell ranges, then walks each sheet
row-by-row classifying every row as a *section header* (wide merge), a *column-header
row* (keywords like "Answer", "Guidance"), or a *data row* (first/second cell matches
the ID regex `^[A-Z]{1,6}-\d{1,3}[A-Z]?$`). For data rows it maps answer / additional
info / guidance / analyst notes using the detected column map, with a positional
fallback. `parse_hecvat_excel(path, debug=False)` returns a list of dicts:

```python
{sheet, section, control_id, question, answer, additional_info, guidance, analyst_notes}
```

Also provides `hecvat_control_to_text()` (template embedding, no answer),
`hecvat_control_to_text_with_response()`, and `hecvat_control_to_metadata()`.

#### `ingest.py`

`get_chroma_client()` → `chromadb.PersistentClient(config.CHROMA_DIR)`. Three public
ingest functions write into three cosine-space collections:

- `ingest_policy_pdf(pdf)` → `internal_policies` — PyMuPDF page text → 
  `RecursiveCharacterTextSplitter` (~400 tok, 120 overlap) → `nomic-embed-text` → upsert.
- `ingest_soc2_pdf(pdf)` → `soc2_controls` (optional; may not exist).
- `ingest_hecvat_template(xlsx)` → `hecvat_template` — embeds the framework questions.

`show_stats()` prints per-collection counts. **Uploaded vendor HECVATs are never
ingested** — they are read at runtime and discarded.

#### `rag.py`

- `retrieve(query, collections=None, top_k=None)` — embeds the query with
  `nomic-embed-text`, queries each collection, converts cosine distance to a
  `similarity = 1 - distance`, merges, sorts desc, returns the global top-k as
  `{text, metadata, collection, similarity}`. Missing collections warn and are skipped.
- `build_context_block(chunks)` — formats labelled, source-tagged context for the prompt.
- `has_sufficient_context(chunks, min_similarity=0.45)` — gate; if the best similarity
  is below 0.45 the control is flagged INSUFFICIENT_EVIDENCE with **no LLM call**.

#### `assess.py`

- `parse_uploaded_hecvat(path)` — parses the vendor HECVAT (runtime only).
- `build_prompt(control, context_block)` — strict "use ONLY the context" prompt that
  requests a single JSON object.
- `call_llm(prompt)` — `ollama.chat(model=config.LLM_MODEL, …)`, **non-streaming**,
  `temperature=0, top_p=0.9, repeat_penalty=1.1, num_ctx=4096`.
- `parse_llm_response(raw, control)` — strips fences, regex-extracts the JSON object,
  `json.loads`; on failure returns a safe INSUFFICIENT_EVIDENCE fallback (never crashes).
- `run_assessment(path, service_name)` → `list[finding]`; `summarize_findings(findings)`
  → status/risk breakdown. Finding **status ∈ {COMPLIANT, PARTIAL, GAP,
  INSUFFICIENT_EVIDENCE}**, **risk_level ∈ {CRITICAL, HIGH, MEDIUM, LOW, N/A}**.

#### `report.py`

`generate_all(findings, summary, service_name, output_dir)` → PDF risk assessment
(reportlab) + Excel risk register (openpyxl). Driven by `main.py assess`.

#### `main.py`

CLI: `python main.py ingest {policy|soc2|hecvat} <file>` · `assess <file> --service NAME`
· `stats`.

### Reporting layer (this task)

#### `benchmark.py`

Reuses `assess` + `rag` exactly, but replaces the LLM call with `call_llm_metered()`,
a **streamed** `ollama.chat` that records:

- `time_to_first_token_ms` — request send → first content token.
- `tokens_per_second` — `eval_count / (eval_duration/1e9)` from the done message.
- `total_latency_ms`, `eval_count` (output tokens), `prompt_tokens`.
- `retrieval_ms` — time inside `rag.retrieve` for that control.

```python
def run_benchmark(
    hecvat_path: str,
    model: str,
    n_items: int,
    progress_callback: Callable[[BenchmarkItem, int, int], None] | None = None,
) -> BenchmarkRun
```

For the first `n_items` parsed controls it runs the real path (including the
sim-< 0.45 → no-LLM-call branch, recorded with `llm_called=False`), invokes
`progress_callback` per control for the GUI, and returns:

```python
@dataclass
class BenchmarkItem:
    control_id: str; section: str; sheet: str
    status: str            # COMPLIANT | PARTIAL | GAP | INSUFFICIENT_EVIDENCE
    risk_level: str
    llm_called: bool; parse_ok: bool
    time_to_first_token_ms: float; tokens_per_second: float; total_latency_ms: float
    eval_count: int; prompt_tokens: int; retrieval_ms: float
    response_snippet: str

@dataclass
class BenchmarkRun:
    model: str; ollama_version: str; platform: str; timestamp: str
    hecvat_file: str; n_items: int; items: list[BenchmarkItem]
    avg_tokens_per_second: float; avg_latency_ms: float; avg_time_to_first_token_ms: float
    avg_retrieval_ms: float; parse_success_rate: float; llm_calls: int
    total_run_time_s: float; status_distribution: dict
```

Helpers: `list_models()` (pulled chat models, embed model excluded),
`get_ollama_version()`, `platform_string()`.
CLI: `python benchmark.py --hecvat HECVAT_Filled.xlsx --models a,b,c --n 10`.

#### `results_writer.py`

**Append-only. Opens `docs/benchmark_results.md` in `"a"` mode. Never truncates.**
`write_run(run, path)` writes the one-time header (if absent), auto-increments the run
number, and appends a dated section: Field table → Summary metrics → Status
distribution → per-control results table → a Notes stub. `parse_results(path)` reads
the log back into per-run summary dicts for the GUI history charts.

#### `gui_app.py` (Streamlit)

Sections, in order:

- **Header** — title, Ollama online/offline + version + platform (`st.metric`); stops
  with an error if Ollama is unreachable.
- **Controls** — model dropdown (`benchmark.list_models()`), HECVAT picker (`*.xlsx`
  in the repo), controls slider (1–50), "▶ Start benchmark" button.
- **Live metrics** (during a run, via `progress_callback`) — tokens/sec (last), TTFT
  (last), elapsed, completed `n/total`, a progress bar, a `st.line_chart` of tokens/s,
  and a growing results table.
- **Result** — on completion, writes the run to the append-only log and shows the
  summary + per-control table.
- **Historical comparison** — `parse_results()` → bar charts of avg tok/s, avg TTFT,
  and parse rate **per model**, plus a table of all logged runs. The key view for D2.

-----

## 7. Prompt design (in code, not a separate file)

There is **no `config/prompts/` directory**. Two pieces define the prompt:

**System prompt** — `config.SYSTEM_PROMPT` (strict, anti-hallucination):

```
You are a strict IT risk and compliance analyst.
RULES YOU MUST FOLLOW — NO EXCEPTIONS:
1. You ONLY use the CONTEXT provided below to make your assessment.
2. You MUST NOT reference … any external frameworks, laws, regulations, or policies
   that are not explicitly present in the CONTEXT.
3. You MUST NOT reference NIST, ISO, GDPR, HIPAA, FedRAMP, CIS … unless verbatim in CONTEXT.
4. If the CONTEXT lacks enough info, respond with status "INSUFFICIENT_EVIDENCE" — never guess.
5. You MUST NOT hallucinate policy text, control numbers, or requirements.
6. Your entire reasoning must be traceable to the CONTEXT provided.
```

**User prompt** — built by `assess.build_prompt(control, context_block)`. It embeds the
retrieved internal context, the control being assessed, the vendor response, and
requests a single JSON object:

```json
{
  "control_id": "...", "section": "...",
  "requirement_summary": "...", "vendor_response_summary": "...",
  "status": "COMPLIANT | PARTIAL | GAP | INSUFFICIENT_EVIDENCE",
  "risk_level": "CRITICAL | HIGH | MEDIUM | LOW | N/A",
  "gap_description": "...", "recommendation": "...",
  "evidence_quality": "STRONG | WEAK | NONE",
  "context_sources": ["..."]
}
```

**Prompt / inference rules (as implemented):**

- LLM options: `temperature=0`, `top_p=0.9`, `repeat_penalty=1.1`, `num_ctx=4096`.
- The status vocabulary is `COMPLIANT | PARTIAL | GAP | INSUFFICIENT_EVIDENCE`
  (not match/mismatch/omission — that was the earlier idealized spec).
- Strict grounding: only retrieved internal context may be used; external frameworks
  are forbidden unless they appear verbatim in the context.
- Malformed JSON → safe fallback finding, never a crash. The benchmark counts a
  fallback as `parse_ok = False`.

-----

## 8. HECVAT 4.1.3 template reference

The HECVAT used is **HECVAT™ Full v4.1.3** (EDUCAUSE). It has 332 questions
across 35 section prefixes, spread across multiple sheets. The benchmark runner
uses the **Organization sheet** as the primary source for the prototype (most
relevant to Murdoch’s IT governance context). Other sheets can be added later.

**Sheet structure:**

- `START HERE` — general info (vendor name, solution name, contact)
- `Organization` — primary governance, documentation, security questions
- `Product` — product-specific security questions
- `Infrastructure` — hosting, data centre, network questions
- `IT Accessibility` — WCAG / VPAT accessibility questions
- `Case-Specific` — consulting, on-premises, special cases
- `AI` — AI/ML specific questions (new in v4.1.x)
- `Privacy` — data privacy, GDPR, privacy policy questions
- `High-Risk Evaluation`, `Institution Evaluation`, `Privacy Analyst Evaluation` — analyst sheets (not vendor-facing)
- `Questions` — master list of all 332 question IDs (used by the parser)
- `Auto Responses`, `(backend scoring)` — formula/scoring sheets (read-only)

**Column structure (Organization sheet, row 21+):**

|Col A      |Col B        |Col C            |Col D          |Col E   |Col F        |
|-----------|-------------|-----------------|---------------|--------|-------------|
|Question ID|Question text|**Vendor answer**|Additional info|Guidance|Analyst notes|

The vendor fills **Col C (Answer)** and optionally **Col D (Additional Information)**.
Col E (Guidance) and Col F (Analyst Notes) are for the institution’s analyst.

**Skip sections for Murdoch AU context** (US-specific legislation, not applicable):

```yaml
skip_sections:
  - HIPA    # HIPAA — US health data law
  - PCID    # PCI-DSS — payment card (separate Murdoch process)
  - PRGN    # FERPA — US student records law
  - INTL    # GDPR — EU; Murdoch AU has separate process
  - CONS    # Consulting-specific (only relevant for consulting engagements)
```

**Section reference (all 35 prefixes):**

|Prefix|Section name                              |Sheet           |
|------|------------------------------------------|----------------|
|GNRL  |General Information                       |Multiple        |
|COMP  |Company Background                        |START HERE      |
|REQU  |Requirements Routing                      |START HERE      |
|DOCU  |Documentation                             |Organization    |
|ITAC  |IT Accessibility                          |IT Accessibility|
|THRD  |Third Party Assessment                    |Organization    |
|CONS  |Consulting Services                       |Case-Specific   |
|APPL  |Application Security                      |Organization    |
|AAAI  |Authentication & Access                   |Organization    |
|CHNG  |Change Management                         |Organization    |
|DATA  |Data Management                           |Organization    |
|DCTR  |Data Centre & Hosting                     |Infrastructure  |
|FIDP  |Firewall & IDS/IPS                        |Infrastructure  |
|PPPR  |Policies, Processes & Procedures          |Organization    |
|HFIH  |Incident Response                         |Organization    |
|VULN  |Vulnerability Management                  |Organization    |
|HIPA  |HIPAA (US-specific — skip for MU AU)      |Case-Specific   |
|PCID  |PCI-DSS (skip for MU AU)                  |Case-Specific   |
|OPEM  |Operational & Emerging Tech               |Organization    |
|PRGN  |FERPA/COPPA (US-specific — skip)          |Privacy         |
|PCOM  |Privacy Compliance                        |Privacy         |
|PDOC  |Privacy Documentation                     |Privacy         |
|PTHP  |Privacy Third Parties                     |Privacy         |
|PCHG  |Privacy Change Management                 |Privacy         |
|PDAT  |Personal Data Processing                  |Privacy         |
|PRPO  |Privacy Risk & Programme                  |Privacy         |
|INTL  |International (GDPR — separate MU process)|Privacy         |
|DRPV  |Data Privacy Impact Assessment            |Privacy         |
|DPAI  |AI & Data Privacy                         |AI              |
|AIQU  |AI / Machine Learning                     |AI              |
|AIGN  |AI Governance                             |AI              |
|AIPL  |AI Policies & Procedures                  |AI              |
|AISC  |AI Security & Data                        |AI              |
|AIML  |AI/ML Data Separation                     |AI              |
|AILM  |LLM Privileges                            |AI              |

**`config/hecvat_profile.yaml`:**

```yaml
version: "4.1.3"
primary_sheet: "Organization"
all_sheets:
  - "Organization"
  - "Product"
  - "Infrastructure"
  - "IT Accessibility"
  - "Case-Specific"
  - "AI"
  - "Privacy"
question_id_col: 0      # column A (0-indexed)
question_text_col: 1    # column B
vendor_answer_col: 2    # column C
additional_info_col: 3  # column D
header_row: 12          # data starts at row 12 (1-indexed) in Organization sheet
skip_sections:
  - "HIPA"
  - "PCID"
  - "PRGN"
  - "INTL"
  - "CONS"
section_headers:        # rows that are section dividers, not questions
  marker: " "           # section header rows start with a space in col A
```

-----

## 9. `config/hecvat_profile.yaml` — full question list reference

All 332 question IDs extracted from HECVAT v4.1.3 `Questions` sheet.
The parser uses this as the canonical ID list. Sections marked `[SKIP-MU-AU]`
are excluded by default for Murdoch Australia.

```
GNRL: GNRL-01 GNRL-02 GNRL-03 GNRL-04 GNRL-05 GNRL-06 GNRL-07 GNRL-08 GNRL-09
COMP: COMP-01 COMP-02 COMP-03 COMP-04 COMP-05
REQU: REQU-01 REQU-02 REQU-03 REQU-04 REQU-05 REQU-06 REQU-07 REQU-08
DOCU: DOCU-01 DOCU-02 DOCU-03 DOCU-04 DOCU-05 DOCU-06 DOCU-07
ITAC: ITAC-01 through ITAC-18
THRD: THRD-01 THRD-02 THRD-03 THRD-04 THRD-05
CONS: CONS-01 through CONS-08  [SKIP-MU-AU: consulting-specific]
APPL: APPL-01 through APPL-nn
AAAI: AAAI-01 through AAAI-nn
CHNG: CHNG-01 through CHNG-16
DATA: DATA-01 through DATA-nn
DCTR: DCTR-01 through DCTR-nn
FIDP: FIDP-01 through FIDP-nn
PPPR: PPPR-01 through PPPR-nn
HFIH: HFIH-01 through HFIH-nn
VULN: VULN-01 through VULN-nn
HIPA: HIPA-01 through HIPA-nn  [SKIP-MU-AU: US HIPAA]
PCID: PCID-01 through PCID-nn  [SKIP-MU-AU: PCI-DSS]
OPEM: OPEM-01 through OPEM-nn
PRGN: PRGN-01 through PRGN-nn  [SKIP-MU-AU: US FERPA]
PCOM: PCOM-01 through PCOM-nn
PDOC: PDOC-01 through PDOC-nn
PTHP: PTHP-01 through PTHP-nn
PCHG: PCHG-01 through PCHG-nn
PDAT: PDAT-01 through PDAT-nn
PRPO: PRPO-01 through PRPO-nn
INTL: INTL-01 through INTL-nn  [SKIP-MU-AU: GDPR / EU]
DRPV: DRPV-01 through DRPV-nn
DPAI: DPAI-01 through DPAI-nn
AIQU: AIQU-01 through AIQU-nn
AIGN: AIGN-01 through AIGN-nn
AIPL: AIPL-01 through AIPL-nn
AISC: AISC-01 through AISC-nn
AIML: AIML-01 through AIML-nn
AILM: AILM-01 through AILM-nn
```

> **Note:** `nn` placeholders indicate the full count from the xlsx. The parser reads
> the actual file — this list is reference only, not the authoritative source.
> The authoritative source is the `Questions` sheet in the uploaded HECVAT xlsx.

-----

## 10. `docs/benchmark_results.md` — persistent results log

This file is created on first run and appended forever. It lives in `docs/` and is
committed to git (it contains no confidential data — only metrics and question IDs).

**Initial header (written once):**

```markdown
# Aegis — Model Benchmark Results

Persistent log. Appended on every run. Never overwritten.
Purpose: inform model selection for the full Aegis risk assessment system.
See OPEN_DECISIONS.md D2 for the decision this log informs.

Models under evaluation: gemma3:2b · phi4-mini:3.8b · gemma3:4b · llama3.2:3b
VM: GRID T4-4Q 4 GB VRAM · Ubuntu 20.04 LTS · 24 CPU · 64 GB RAM
```

**Each run appends:**

```markdown
---

## Run 001 — 2026-06-04T17:30:44

| Field | Value |
|---|---|
| Model | granite4.1:3b |
| Platform | macOS arm64 · Ollama Metal |
| Ollama version | 0.24.0 |
| HECVAT file | HECVAT_Filled.xlsx |
| Controls evaluated | 4 (LLM calls: 4) |

### Summary metrics

| Metric | Value |
|---|---|
| Avg tokens/second | 40.99 |
| Avg time to first token | 1474.5 ms |
| Avg total latency per item | 4945.4 ms |
| Avg retrieval time | 56.1 ms |
| Parse success rate | 100% |
| Total run time | 20.0 s |

### Status distribution

COMPLIANT: 1 · GAP: 1 · INSUFFICIENT_EVIDENCE: 2

### Per-item results

| Control | Section | Status | Risk | Tok/s | Latency ms | TTFT ms | Out tok | Retr ms | Parse |
|---|---|---|---|---|---|---|---|---|---|
| GNRL-01 | START HERE | COMPLIANT | N/A | 40.8 | 4720 | 1138 | 139 | 136 | ✓ |
| GNRL-04 | START HERE | GAP | N/A | 40.9 | 5207 | 1791 | 135 | 29 | ✓ |
| ...

### Notes
<!-- space for manual observations after reviewing the run -->
```

> The exact format above is produced by `results_writer.write_run()`. Status vocabulary
> is the backend's `COMPLIANT | PARTIAL | GAP | INSUFFICIENT_EVIDENCE` (there is no
> "gap_type" match/mismatch/omission scale in the actual code).

-----

## 11. Build plan

**Status: the assessment backend and the reporting layer both exist and run.**

**Done — assessment backend:** `hecvat_parser.py`, `ingest.py` (policies + HECVAT
template embedded into `chroma_db/`), `rag.py`, `assess.py`, `report.py`, `main.py`.
ChromaDB currently holds ~134 policy chunks + ~1911 HECVAT-template chunks.

**Done — reporting / evaluation layer (this task):**

- `benchmark.py` — instrumented streaming run over the real pipeline; captures
  tokens/s, TTFT, latency, output tokens, retrieval time + the real gap status.
- `results_writer.py` — append-only `docs/benchmark_results.md` + history parser.
- `gui_app.py` — Streamlit dashboard (controls, live metrics, results table, history).

**Next — produce the evidence for D2:**

- Run the candidate models (`granite4.1:3b`, `qwen2.5:3b`, `ministral-3:3b`,
  `gemma3:4b`, …) against `HECVAT_Filled.xlsx` on the **VM** (real target hardware).
- Review `docs/benchmark_results.md` as a team → decide D2 (model selection).
- Optional cleanup: migrate `config.py` constants to `pydantic-settings` + `.env`;
  add a `.gitignore` for the confidential PDFs/xlsx; add pytest coverage with a mocked
  Ollama client.

**Week 8 onwards — full system** (separate spec / Claude.md update)

-----

## 12. Work split for the prototype

|Person    |Task                                                                                          |Deliverable                                                       |
|----------|----------------------------------------------------------------------------------------------|------------------------------------------------------------------|
|**Aditya**|`ollama_client.py` (chat + embed + metrics capture) + `benchmark_runner.py` orchestration     |Working benchmark loop on 20 HECVAT items                         |
|**Fahad** |`hecvat_parser.py` + `knowledge_base.py` (chunk + embed + retrieve) + `results_writer.py`     |Parser + ChromaDB working; MD results file appending correctly    |
|**Sakina**|`gui/app.py` — Streamlit dashboard with live metrics + history comparison chart               |Working GUI that shows live tok/s and results table               |
|**Saleh** |Prompt design iteration in `config/prompts/gap_analysis.txt` + quality review of model outputs|Tested prompt that gets valid JSON from `gemma3:2b` reliably      |
|**Izaan** |`config/hecvat_profile.yaml` + skip_sections logic + validate parser output correctness       |Correct section filtering; omission detection working             |
|**Ryan**  |Synthetic sample docs (`samples/`) + `docs/benchmark_results.md` initial header + README      |Team can run `make demo` end to end without real confidential docs|

-----

## 13. How to run (no Makefile — flat repo, run modules directly)

```bash
# 0. deps (once) + one-time embedding GGUF download (see §A)
.venv/bin/pip install -r requirements.txt streamlit
"$PYBIN" -c "from huggingface_hub import hf_hub_download; \
  hf_hub_download(repo_id='nomic-ai/nomic-embed-text-v1.5-GGUF', \
  filename='nomic-embed-text-v1.5.f16.gguf', local_dir='/home/td01/models')"

# 1. GPU engine — the CLI auto-starts it (gpu_engine.ensure_started, §A), so no
#    manual step is needed. To run the two GPU servers by hand instead:
./run_gpu.sh        # LLM :8000 + embeddings :8001, both on GPU; Ctrl-C stops

# 2. build the knowledge base (once, or when policies change — re-ingest if the
#    embedding model changes). ingest auto-starts the GPU engine.
python main.py ingest policy  "ICT Security Policy 1.pdf"
python main.py ingest policy  "ICT Security Standard 1.pdf"
python main.py ingest policy  "IT Conditions of Use Policy 1.pdf"
python main.py ingest hecvat  HECVAT_Template.xlsx
python main.py stats

# 3a. full assessment → PDF + Excel + JSON in reports/  (auto-starts + stops the engine)
python main.py assess HECVAT_Filled.xlsx --service "ExampleService" --output ./reports

# 3b. benchmark one or more models → appends to docs/benchmark_results.md
python benchmark.py --hecvat HECVAT_Filled.xlsx --models granite4.1:3b,qwen2.5:3b --n 10

# 4. GUI dashboard (live metrics + history)  →  http://localhost:8501
.venv/bin/streamlit run gui_app.py --server.port 8501
```

> A Makefile / `pyproject.toml` could wrap these, but the repo currently uses
> `requirements.txt` + direct module invocation. Don't assume `make` targets exist.

-----

## 14. Cross-platform setup

Same code path everywhere; Ollama handles the GPU/CPU backend. After cloning:

```bash
python3 -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements.txt streamlit
ollama pull gemma3:4b
ollama pull nomic-embed-text
# build KB (§13 step 2), then:
python benchmark.py --hecvat HECVAT_Filled.xlsx --models granite4.1:3b --n 10
streamlit run gui_app.py --server.port 8501     # http://localhost:8501
```

- **macOS:** `brew install python ollama`; `brew services start ollama` (Metal auto).
- **Ubuntu VM (primary):** Ollama uses CUDA automatically on the GRID T4-4Q.
- **Windows:** install Ollama + Python from their sites; use the PowerShell venv
  activation above.

-----

## 15. Open decisions (`docs/OPEN_DECISIONS.md`)

|#  |Decision                                                                                                                                                                  |Status                          |
|---|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------|
|D1 |Exact Murdoch RMF scales → needed for full system, not prototype                                                                                                          |Open                            |
|D2 |**Model selection**: benchmark the pulled candidates (`granite4.1:3b`, `qwen2.5:3b`, `ministral-3:3b`, `gemma3:4b`, …) — **decided by `docs/benchmark_results.md`**         |**Open — resolved by benchmark**|
|D3 |ChromaDB as vector store (cosine space; collections: internal_policies · hecvat_template · soc2_controls)                                                                  |Ratified                        |
|D5 |Private repo + confidentiality arrangement with supervisor                                                                                                                |Open                            |
|D13|Inference: fixed `num_ctx=4096`, `temperature=0`, `top_p=0.9`, `repeat_penalty=1.1` (as set in `assess.call_llm`)                                                          |Ratified                        |
|D15|`OLLAMA_KEEP_ALIVE=600`, `OLLAMA_NUM_PARALLEL=1` for serving                                                                                                              |Ratified                        |
|D16|"No-LLM-call" path = retrieval similarity < 0.45 → INSUFFICIENT_EVIDENCE (not blank-answer omission). Blank answers become "Not answered" and are still assessed.          |Ratified                        |
|D19|VM: Ubuntu 20.04.6 LTS · 24 CPU · 64 GB RAM · 512 GB SSD · GRID T4-4Q 4 GB VRAM · `ICT30226T2TD01` · `10.51.33.69`                                                        |Ratified                        |
|D20|Default model `gemma3:4b` (`config.LLM_MODEL`) across platforms; any pulled model is benchmarkable via `--models` / GUI                                                  |Ratified                        |
|D21|GUI: Streamlit (not React). React reserved for full system.                                                                                                               |Ratified                        |
|D22|Scope: assessment backend + benchmark/reporting layer + Streamlit GUI + persistent MD log. No new risk-scoring engine in this task — backend already emits status/risk.   |Ratified                        |

-----

## 16. Agent guidance

- **The backend in this repo is the source of truth.** Reuse `assess`, `rag`,
  `ingest`, `hecvat_parser`, `config`. Don't reintroduce the earlier idealized spec
  (async `ollama_client.py`, `backend/` package, `config/prompts/`, `hecvat_profile.yaml`,
  `knowledge_base.py`, gap_type match/mismatch/omission) — none of those exist here.
- **Don't change backend behaviour to add metrics.** `benchmark.py` wraps the pipeline;
  it must keep producing the same gap status the backend would (it reuses
  `assess.build_prompt` / `assess.parse_llm_response`).
- `docs/benchmark_results.md` is **append-only**. `results_writer` opens it with `"a"`.
  Never truncate or rewrite past runs.
- Models are swappable by **name** (CLI `--models`, GUI dropdown) — never hardcode a
  model in `benchmark.py`/`gui_app.py`; read the default from `config.LLM_MODEL`.
- Keep inference settings as the backend sets them: `temperature=0`, `top_p=0.9`,
  `repeat_penalty=1.1`, `num_ctx=4096`.
- The only "no LLM call" path is `rag.has_sufficient_context(... ) is False`
  (similarity < 0.45) → INSUFFICIENT_EVIDENCE. Preserve it in the benchmark
  (recorded as `llm_called=False`).
- 100% local. No cloud APIs, no telemetry. Inference via the GPU `llama.cpp` engine
  (LLM `localhost:8000`, embeddings `localhost:8001`; §A). Ollama is CPU-only here and is
  not on the assessment path — don't reintroduce `ollama.chat`/`ollama.embeddings` in
  `assess`/`rag`/`ingest`. The KB must be re-ingested if the embedding model changes.
- No confidential data in git: the policy PDFs, `HECVAT_*.xlsx`, `chroma_db/`, and
  `reports/` must be git-ignored before any push. `docs/benchmark_results.md` is safe.
- Log new decisions in `docs/OPEN_DECISIONS.md` with the next D-number.