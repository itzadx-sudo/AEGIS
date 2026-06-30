#!/usr/bin/env bash
#
# run_gpu.sh — launch the Aegis GPU inference engines on macOS or Linux.
#
# Thin OS-aware wrapper around run_gpu.py, which does the real work and is fully
# cross-platform (Linux/CUDA, macOS/Metal, Windows). This script just picks a
# Python interpreter and hands off. On Windows, use run_gpu.ps1 instead.
#
# Usage:  ./run_gpu.sh         (foreground; Ctrl-C stops what it started)
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

OS="$(uname -s)"
case "$OS" in
    Darwin) echo "🍎 Detected macOS — llama.cpp will use Metal if on Apple Silicon." ;;
    Linux)  echo "🐧 Detected Linux — llama.cpp will use CUDA if an NVIDIA GPU is present." ;;
    *)      echo "⚠️  Unrecognised OS '$OS' via run_gpu.sh; on Windows use run_gpu.ps1." >&2 ;;
esac

# Pick the Python interpreter:
#   1. $AEGIS_PYBIN if set (also consumed by config.py)
#   2. the VM's pyenv interpreter, if it exists (keeps `bash run_gpu.sh` working
#      unchanged on the project VM)
#   3. python3 / python from PATH
pick_python() {
    if [[ -n "${AEGIS_PYBIN:-}" ]]; then echo "$AEGIS_PYBIN"; return; fi
    local vm_py="$HOME/.pyenv/versions/aegis-env-3.12/bin/python"
    if [[ -x "$vm_py" ]]; then echo "$vm_py"; return; fi
    if command -v python3 >/dev/null 2>&1; then echo "python3"; return; fi
    echo "python"
}

PY="$(pick_python)"
echo "🐍 Using interpreter: $PY"
exec "$PY" "$HERE/run_gpu.py"
