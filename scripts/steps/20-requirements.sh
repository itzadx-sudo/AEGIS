#!/usr/bin/env bash
# Install Sedona's Python dependencies into the project venv.
#
# llama-cpp-python is deliberately excluded here and built by 40-llama.sh instead: pip would
# fetch a prebuilt CPU wheel, and on a GPU box that silently gives you a working import with no
# GPU offload at all — the slowest possible outcome, arrived at without an error message.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

STEP=requirements
REQ="$PROJECT_ROOT/BACKEND/requirements.txt"

[[ -f "$REQ" ]] || die "missing $REQ"

if is_done "$STEP" && venv_usable; then
  ok "python dependencies already installed"
  exit 0
fi

venv_usable || [[ -x "$(venv_python)" ]] || die "run 10-python.sh first"

log "installing dependencies (excluding llama-cpp-python, which is built against CUDA later)"
FILTERED="$RUNTIME_DIR/requirements.no-llama.txt"
mkdir -p "$RUNTIME_DIR"
grep -v '^[[:space:]]*llama-cpp-python' "$REQ" > "$FILTERED"

"$(venv_python)" -m pip install -q -r "$FILTERED"

venv_usable || die "dependencies installed but 'import uvicorn, fastapi' still fails"

ok "python dependencies installed"
mark_done "$STEP"
