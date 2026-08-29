# Sedona By Team AEGIS

Sedona is a local-first vendor security assessment application. It parses HECVAT workbooks,
compares answers with institution-approved policy content, optionally uses session-scoped
vendor evidence, and produces browser, CSV, PDF, and PowerPoint outputs.

Everything runs on the machine it is installed on: the language model, the embedding model and
the vector store are all local. No vendor data leaves the host.

## System at a glance

- React/Vite frontend in `FRONTEND/src`
- FastAPI application in `FRONTEND/api.py`
- HECVAT parsing, retrieval, assessment, consensus, follow-up and reporting in `BACKEND`
- Local llama.cpp chat and embedding servers
- Chroma persistent retrieval store under the configured data directory
- Local users, role-based access, cookie sessions, CSRF checks, and session
  ownership/assignment

Sedona does not make a vendor compliant. It produces decision support that requires qualified
human review — particularly for insufficient evidence, controls with no usable model result,
SOC 2 exceptions, scanned documents, and manual resolutions.

---

## Getting started

On a machine with nothing installed:

```bash
./start.sh
```

That is the whole procedure. If `start.sh` cannot find a Python that has Sedona's dependencies,
it runs `scripts/bootstrap.sh` first, then starts the services.

To install without starting anything, or to see what is missing:

```bash
./scripts/bootstrap.sh            # install whatever is missing
./scripts/bootstrap.sh --check    # report what is missing, change nothing
./scripts/bootstrap.sh --force    # re-run every step from scratch
```

Then open the URL `start.sh` prints and sign in.

The first administrator is created from `SEDONA_BOOTSTRAP_ADMIN_USERNAME` and
`SEDONA_BOOTSTRAP_ADMIN_PASSWORD` on the first start, when the user database is empty. Copy
`.env.example` to a protected environment file outside git and set the placeholders before that
first start. Self-service sign-up only ever creates a `viewer`.

Do not run `start.sh` as root.

---

## What the bootstrap installs, and where

Everything lands **inside this folder**. Nothing is written to `$HOME`, nothing needs sudo, and
deleting `.runtime/` undoes all of it.

| Path | Contents |
| --- | --- |
| `.runtime/venv` | the Python environment and Sedona's dependencies |
| `.runtime/conda` | package manager, only used to fetch the CUDA toolkit |
| `.runtime/cuda` | the CUDA toolkit — a compiler, used once at install time |
| `.runtime/.stamps` | which steps have completed |
| `models/` | the GGUF chat and embedding weights |

Steps run in order and each one is skipped when the thing it installs already works:

| Step | Does |
| --- | --- |
| `10-python` | finds a suitable Python or installs one, then creates the venv |
| `20-requirements` | installs `BACKEND/requirements.txt` |
| `30-cuda` | detects the GPU and installs a matching CUDA toolkit |
| `40-llama` | compiles `llama-cpp-python` against that toolkit |
| `50-models` | downloads the GGUF model files |

A step is judged by whether it actually works, not by whether a marker file exists, so a
half-finished or partly deleted install repairs itself on the next run rather than being
skipped.

### GPU detection

The CUDA version and GPU architecture are read off the machine rather than hardcoded:

- compute capability from the GPU (a T4 reports 7.5, so the build targets `sm_75`), falling
  back to a card-name table where `nvidia-smi` is too old to report it;
- the CUDA toolkit chosen **inside the driver's own CUDA major line**.

That last point is the constraint that matters. NVIDIA's minor-version compatibility means a
binary built against 11.8 runs on a driver that only advertises 11.0 — which is why this works
on a 450-series driver. Crossing a major version does not work: a CUDA 12 binary will not load
against an 11.x driver, so it is never attempted.

If there is no GPU, the bootstrap **stops with an explanation** instead of quietly producing a
CPU-only build. A full assessment takes roughly four hours on CPU against minutes on a GPU, and
finding that out halfway through a run is worse than being told up front. To ask for it
deliberately:

```bash
SEDONA_FORCE_CPU=1 ./scripts/bootstrap.sh
```

The compile takes 10–30 minutes and happens once. Nothing recompiles at run time.

---

## Service lifecycle

| Command | Effect |
| --- | --- |
| `./start.sh` | Start whatever is down, reuse whatever is healthy. Reused services are not owned by this run, so `Ctrl-C` does not stop them. |
| `./start.sh --adopt` | Same, but take ownership of services already running, so `Ctrl-C` stops them. |
| `./start.sh --stop` | Stop this checkout's API and frontend. |
| `./start.sh --stop --engines` | Also stop the chat and embedding servers. Expect a multi-minute model reload next start. |
| `./start.sh --restart-api` | Replace only the API process, after a backend code change. |

`start.sh` starts four things: the chat model server, the embedding server, the API, and the
frontend. It reuses any that are already healthy, so a bare run is a safe health check.

**Ownership is proven before anything is signalled.** A process counts as this checkout's only
when `/proc/<pid>/cwd` resolves inside this folder. Nothing is ever killed by port, so a second
Sedona elsewhere on the host, or a hand-started model server, is never disturbed.

Backend changes need `--restart-api`; there is no `--reload`. Use the flag rather than killing
and relaunching by hand: uvicorn holds the port for a moment after exiting, so a naive restart
races, the new process dies on an address-in-use error, and the API stays down while the
frontend proxy returns 500s. `--restart-api` waits for the port to actually free, then relaunches
and polls `/health`.

Frontend changes hot-reload; no restart needed.

### Configuration

Paths, ports, model files, origins and data locations are all environment-overridable — see
`.env.example`. The useful ones:

| Variable | Purpose |
| --- | --- |
| `SEDONA_PYBIN` | use a specific interpreter instead of searching |
| `SEDONA_DATA_DIR` | relocate all persistent state at once |
| `SEDONA_API_PORT` / `SEDONA_FRONTEND_PORT` | change ports (default 8080 / 5173) |
| `SEDONA_MODEL_DIR` | where the GGUF files live |
| `SEDONA_RUNTIME_DIR` | where the bootstrap installs |
| `SEDONA_FORCE_CPU` | build without CUDA |

Storage paths are anchored to the project root, never the working directory, so it does not
matter where you launch from.

---

## Main workflow

1. An administrator indexes approved institutional policies and the HECVAT guidance template.
2. An assessor uploads a filled HECVAT and names the vendor or service.
3. Before starting, the assessor may attach the vendor's SOC 2 report or other supporting PDFs.
   Those documents are isolated to that session and never enter the institution-wide store.
4. Sedona assesses each institutionally applicable control. A control whose runs do not produce
   a usable result is excluded from the scores and flagged for manual resolution rather than
   being guessed at.
5. The assessor reviews the follow-up questions, attaches further evidence, answers or skips,
   and resolves flagged controls with a recorded justification.
6. Sedona generates the JSON/API, CSV, PDF and PPTX outputs from one canonical finding set, so
   the four cannot disagree.

The PDF and CSV carry every control in full. The PPTX is a fixed-length executive briefing —
title, recommendation, key components, severity distribution, top risks, assurance and
limitations, next steps — and does not grow with the size of the assessment.

## Health

`GET /health` reports the real state of the chat server, the embedding server and the vector
store, plus whether an assessment can actually run. It returns HTTP 200 even when degraded, so
that `start.sh` can distinguish "the API is up" from "the API is healthy"; the body carries the
truth. Pass `?strict=1` to get a 503 when degraded instead.
