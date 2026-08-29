#!/usr/bin/env bash
#
# run_gpu.sh — launch the Sedona GPU inference engines (compiled llama.cpp).
#
# Starts TWO llama_cpp.server instances on the GPU, reading all settings from
# config.py (the single source of truth):
#   • LLM         → chat/completions on LLM_SERVER_PORT (gemma GGUF)
#   • Embeddings  → /v1/embeddings   on EMBED_SERVER_PORT (nomic GGUF)
#
# Idempotent: any port already serving is left alone (so a manually-started
# `start-gpu-engine` on :8000 is reused, never clobbered). Only the servers
# THIS script starts are torn down on Ctrl-C / SIGTERM.
#
# Usage:  ./run_gpu.sh         (foreground; Ctrl-C stops what it started)
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

# ── Pull config values from config.py ────────────────────────────────────────
read_cfg() { "$PYBIN_BIN" -c "import config; print(config.$1)"; }

# PYBIN is defined in config.py; bootstrap with the active interpreter to read it.
# llama_cpp links against libcudart, and the only thing that used to put CUDA on the library
# path was an interactive .bashrc. A non-interactive shell (ssh host 'bash start.sh', systemd,
# cron, CI) therefore died with "libcudart.so.11.0: cannot open shared object file".
# prefer the toolkit the bootstrap recorded: llama_cpp was compiled against it, so a stale
# CUDA_HOME exported by a shell profile must not win and point the loader at nothing
_RUNTIME_DIR="${SEDONA_RUNTIME_DIR:-$HERE/../.runtime}"
if [[ -r "$_RUNTIME_DIR/cuda.env" ]]; then
  source "$_RUNTIME_DIR/cuda.env"
fi
if [[ -n "${SEDONA_CUDA_HOME:-}" && -d "${SEDONA_CUDA_HOME}" ]]; then
  CUDA_HOME="$SEDONA_CUDA_HOME"
elif [[ -d "$_RUNTIME_DIR/cuda" ]]; then
  CUDA_HOME="$_RUNTIME_DIR/cuda"
fi
: "${CUDA_HOME:=$HOME/miniconda3/envs/cuda118}"
export CUDA_HOME
export LD_LIBRARY_PATH="$CUDA_HOME/lib:$CUDA_HOME/lib64:${LD_LIBRARY_PATH:-}"

# Pick an interpreter that can actually import llama_cpp, rather than trusting config.PYBIN.
# The bootstrap's venv comes before the machine-wide ones: it holds the build this checkout
# compiled CUDA into, and a stray system install would otherwise win and quietly run on CPU.
# config.PYBIN falls back to sys.executable, i.e. whichever interpreter happened to read it, and
# the API's venv has uvicorn and fastapi but no llama-cpp-python — so the engines were launched
# with a python that died immediately on "No module named 'llama_cpp'", leaving start.sh to sit
# out its full readiness timeout. Like the uvicorn interpreter check in start.sh, this stayed
# invisible for as long as the engines kept running, because a healthy port is reused and the
# launch path is never re-exercised.
#
# The CUDA library path exported above has to be in place first: the import itself needs libcudart.
# importing llama_cpp alone isn't enough — the server module is what actually gets run, and it
# needs the [server] extra, so an interpreter missing it used to pass here and die at launch
_can_serve_gguf() {
  [[ -x "$1" ]] && "$1" -c 'import llama_cpp.server.app' >/dev/null 2>&1
}
PYBIN_BIN=""
for _candidate in \
  "${SEDONA_LLAMA_PYBIN:-}" \
  "${SEDONA_PYBIN:-}" \
  "${SEDONA_RUNTIME_DIR:-$HERE/../.runtime}/venv/bin/python" \
  "$HOME/.pyenv/versions/aegis-env-3.12/bin/python" \
  "$HERE/.venv/bin/python" \
  "$HERE/../.venv/bin/python" \
  "$(command -v python3 || true)"
do
  [[ -n "$_candidate" ]] || continue
  if _can_serve_gguf "$_candidate"; then PYBIN_BIN="$_candidate"; break; fi
done
if [[ -z "$PYBIN_BIN" ]]; then
  echo "❌ No Python can run llama_cpp.server (CUDA_HOME=$CUDA_HOME)." >&2
  echo "   Needs llama-cpp-python[server]; set SEDONA_LLAMA_PYBIN to an interpreter that has it." >&2
  exit 1
fi
echo "▸ Engine interpreter: $PYBIN_BIN"

LLM_GGUF="$(read_cfg LLM_GGUF_PATH)"
LLM_PORT="$(read_cfg LLM_SERVER_PORT)"
LLM_HOST="$(read_cfg LLM_SERVER_HOST)"
LLM_CTX="$(read_cfg LLM_NUM_CTX)"
EMBED_GGUF="$(read_cfg EMBED_GGUF_PATH)"
EMBED_PORT="$(read_cfg EMBED_SERVER_PORT)"
EMBED_HOST="$(read_cfg EMBED_SERVER_HOST)"
NGL="$(read_cfg N_GPU_LAYERS)"

# ── Sanity checks on the model files ─────────────────────────────────────────
if [[ ! -f "$LLM_GGUF" ]]; then
    echo "❌ LLM GGUF not found: $LLM_GGUF" >&2
    exit 1
fi
if [[ ! -f "$EMBED_GGUF" ]]; then
    echo "❌ Embedding GGUF not found: $EMBED_GGUF" >&2
    echo "   Download it with:" >&2
    echo "   \"$PYBIN_BIN\" -c \"from huggingface_hub import hf_hub_download; hf_hub_download(repo_id='nomic-ai/nomic-embed-text-v1.5-GGUF', filename='nomic-embed-text-v1.5.f16.gguf', local_dir='$(dirname "$EMBED_GGUF")')\"" >&2
    exit 1
fi

# ── Helpers ──────────────────────────────────────────────────────────────────
port_healthy() {  # $1 = port
    curl -sf "http://localhost:$1/v1/models" >/dev/null 2>&1
}

wait_ready() {    # $1 = port, $2 = label, $3 = pid of the server we started (optional)
    local port="$1" label="$2" pid="${3:-}" tries=0
    until port_healthy "$port"; do
        # Fast-fail: if we started this server and its process has already died,
        # don't sit through the full 180s timeout — surface the failure now.
        if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
            echo "❌ $label server (pid $pid) exited before becoming ready on :$port — check the log above." >&2
            return 1
        fi
        tries=$((tries + 1))
        if (( tries > 180 )); then
            echo "❌ $label did not become ready on :$port after 180s" >&2
            return 1
        fi
        sleep 1
    done
    echo "✅ $label ready on :$port"
}

PIDS=()
LLM_PID=""
EMBED_PID=""
cleanup() {
    echo
    echo "Stopping GPU engine(s) started by this script…"
    for pid in "${PIDS[@]:-}"; do
        [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
    done
    wait 2>/dev/null || true
    echo "Stopped."
}
trap cleanup INT TERM EXIT

# ── Launch LLM server (skip if already up) ───────────────────────────────────
if port_healthy "$LLM_PORT"; then
    echo "↺ LLM already serving on :$LLM_PORT — reusing, not starting a new one."
else
    echo "▶ Starting LLM server on :$LLM_PORT  ($(basename "$LLM_GGUF"))"
    "$PYBIN_BIN" -m llama_cpp.server \
        --model "$LLM_GGUF" \
        --n_gpu_layers "$NGL" \
        --n_ctx "$LLM_CTX" \
        --host "$LLM_HOST" \
        --port "$LLM_PORT" &
    LLM_PID="$!"
    PIDS+=("$LLM_PID")
fi

# ── Launch embedding server (skip if already up) ─────────────────────────────
if port_healthy "$EMBED_PORT"; then
    echo "↺ Embeddings already serving on :$EMBED_PORT — reusing."
else
    echo "▶ Starting embedding server on :$EMBED_PORT  ($(basename "$EMBED_GGUF"))"
    "$PYBIN_BIN" -m llama_cpp.server \
        --model "$EMBED_GGUF" \
        --embedding True \
        --n_gpu_layers "$NGL" \
        --host "$EMBED_HOST" \
        --port "$EMBED_PORT" &
    EMBED_PID="$!"
    PIDS+=("$EMBED_PID")
fi

# ── Wait until both are serving (fast-fail if a server we started dies) ───────
wait_ready "$LLM_PORT"   "LLM"        "$LLM_PID"
wait_ready "$EMBED_PORT" "Embeddings" "$EMBED_PID"

echo "🚀 GPU engines ready (LLM :$LLM_PORT · embeddings :$EMBED_PORT). Ctrl-C to stop."

# If we started nothing (both reused), don't hang forever.
if (( ${#PIDS[@]} == 0 )); then
    trap - EXIT
    echo "Nothing to supervise (both reused). Exiting."
    exit 0
fi

wait
