#!/usr/bin/env bash
#
# run_gpu.sh — launch the Aegis GPU inference engines (compiled llama.cpp).
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

# PYBIN is defined in config.py; bootstrap with a sensible default to read it.
PYBIN_BIN="${PYBIN:-/home/td01/.pyenv/versions/aegis-env-3.12/bin/python}"
PYBIN_BIN="$(read_cfg PYBIN)"

LLM_GGUF="$(read_cfg LLM_GGUF_PATH)"
LLM_PORT="$(read_cfg LLM_SERVER_PORT)"
LLM_CTX="$(read_cfg LLM_NUM_CTX)"
EMBED_GGUF="$(read_cfg EMBED_GGUF_PATH)"
EMBED_PORT="$(read_cfg EMBED_SERVER_PORT)"
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
