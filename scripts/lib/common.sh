#!/usr/bin/env bash
# Shared paths, logging and hardware detection for the bootstrap steps.
# Everything Sedona installs lives inside the project folder, so the whole thing is one
# directory you can zip, move or delete — nothing lands in $HOME and nothing needs sudo.

set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
RUNTIME_DIR="${SEDONA_RUNTIME_DIR:-$PROJECT_ROOT/.runtime}"
VENV_DIR="$RUNTIME_DIR/venv"
CONDA_DIR="$RUNTIME_DIR/conda"
CUDA_ENV_DIR="$RUNTIME_DIR/cuda"
MODEL_DIR="${SEDONA_MODEL_DIR:-$PROJECT_ROOT/models}"
STAMP_DIR="$RUNTIME_DIR/.stamps"

PYTHON_VERSION="${SEDONA_PYTHON_VERSION:-3.12}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; RESET='\033[0m'
log()  { echo -e "${CYAN}[bootstrap]${RESET} $*"; }
ok()   { echo -e "${GREEN}  [ok] $*${RESET}"; }
warn() { echo -e "${YELLOW}  [warn] $*${RESET}"; }
fail() { echo -e "${RED}  [error] $*${RESET}" >&2; }

die() { fail "$*"; exit 1; }

# Steps are idempotent: each drops a stamp when it finishes, and skips if the stamp is there
# AND the thing it installed still works. A stamp alone is never trusted — a half-deleted
# .runtime would otherwise make every step claim success.
stamp_file() { echo "$STAMP_DIR/$1"; }
mark_done()  { mkdir -p "$STAMP_DIR"; date -u +%Y-%m-%dT%H:%M:%SZ > "$(stamp_file "$1")"; }
is_done()    { [[ -f "$(stamp_file "$1")" ]]; }

need_cmd() { command -v "$1" >/dev/null 2>&1; }

fetch() {
  local url="$1" dest="$2"
  mkdir -p "$(dirname "$dest")"
  if need_cmd curl; then
    curl -fL --retry 3 --retry-delay 2 -o "$dest.part" "$url"
  elif need_cmd wget; then
    wget -q --tries=3 -O "$dest.part" "$url"
  else
    die "neither curl nor wget is available to download $url"
  fi
  mv "$dest.part" "$dest"
}

# ── Python ───────────────────────────────────────────────────────────────────
venv_python() { echo "$VENV_DIR/bin/python"; }

venv_usable() {
  local py; py="$(venv_python)"
  [[ -x "$py" ]] && "$py" -c 'import uvicorn, fastapi' >/dev/null 2>&1
}

# ── GPU detection ────────────────────────────────────────────────────────────
# Hardcoding CUDA 11.8 / sm_75 only ever described this one VM. Both facts are readable off
# the machine, so read them.

gpu_present() {
  need_cmd nvidia-smi && nvidia-smi -L 2>/dev/null | grep -q "GPU 0"
}

gpu_name() {
  nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 | tr -d '\r'
}

# The highest CUDA the installed driver can talk to, e.g. "11.0" on driver 450.
driver_cuda_version() {
  nvidia-smi 2>/dev/null | sed -n 's/.*CUDA Version: *\([0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -1
}

driver_cuda_major() { driver_cuda_version | cut -d. -f1; }

# Compute capability as CMAKE_CUDA_ARCHITECTURES wants it: "7.5" -> "75".
# --query-gpu=compute_cap only exists on newer nvidia-smi, so fall back to a name table for
# the cards this project is likely to meet.
gpu_arch() {
  local cap
  cap="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1 | tr -d ' \r')"
  if [[ "$cap" =~ ^[0-9]+\.[0-9]+$ ]]; then
    echo "${cap//./}"
    return 0
  fi
  case "$(gpu_name)" in
    *T4*|*RTX\ 20*|*Quadro\ RTX*|*Titan\ RTX*) echo 75 ;;
    *V100*)                                    echo 70 ;;
    *P100*|*P40*|*GTX\ 10*)                    echo 60 ;;
    *A100*|*A30*)                              echo 80 ;;
    *A10*|*RTX\ 30*|*A40*)                     echo 86 ;;
    *L4*|*L40*|*RTX\ 40*)                      echo 89 ;;
    *H100*)                                    echo 90 ;;
    *) echo "" ;;
  esac
}

# Pick a toolkit inside the driver's own major line. Crossing majors is the one thing that
# cannot work: a CUDA 12 binary will not load on a driver that reports 11.x, however new the
# toolkit is. Within a major, NVIDIA's minor-version compatibility covers the gap — which is
# why an 11.8 build runs on this VM's 11.0 driver.
cuda_toolkit_for_driver() {
  local major="$1"
  case "$major" in
    11) echo "${SEDONA_CUDA_VERSION:-11.8.0}" ;;
    12) echo "${SEDONA_CUDA_VERSION:-12.4.0}" ;;
    13) echo "${SEDONA_CUDA_VERSION:-13.0.0}" ;;
    *)  echo "" ;;
  esac
}

cuda_nvcc() { echo "$CUDA_ENV_DIR/bin/nvcc"; }

cuda_usable() { [[ -x "$(cuda_nvcc)" ]]; }

llama_cuda_ready() {
  local py; py="$(venv_python)"
  [[ -x "$py" ]] || return 1
  CUDA_LIB_PATH="$CUDA_ENV_DIR/lib:$CUDA_ENV_DIR/lib64" \
  LD_LIBRARY_PATH="$CUDA_ENV_DIR/lib:$CUDA_ENV_DIR/lib64:${LD_LIBRARY_PATH:-}" \
    "$py" - <<'PY' >/dev/null 2>&1
import llama_cpp
# supports_gpu_offload is the honest check: the module imports fine on a CPU-only build too
assert getattr(llama_cpp.llama_cpp, "llama_supports_gpu_offload", lambda: False)()
PY
}

# run_gpu.sh serves the models with `python -m llama_cpp.server`, which needs the [server] extra.
# separate from the cuda check so a missing extra costs a pip install, not a half-hour rebuild
llama_server_ready() {
  local py; py="$(venv_python)"
  [[ -x "$py" ]] || return 1
  # same library path as llama_cuda_ready: importing the server pulls in llama_cpp, which needs
  # libcudart, so without this it fails for the wrong reason and looks like a missing extra
  CUDA_LIB_PATH="$CUDA_ENV_DIR/lib:$CUDA_ENV_DIR/lib64" \
  LD_LIBRARY_PATH="$CUDA_ENV_DIR/lib:$CUDA_ENV_DIR/lib64:${LD_LIBRARY_PATH:-}" \
    "$py" -c 'import llama_cpp.server.app' >/dev/null 2>&1
}

report_hardware() {
  if ! gpu_present; then
    warn "no NVIDIA GPU visible to nvidia-smi"
    return 1
  fi
  log "GPU:            $(gpu_name)"
  log "Driver CUDA:    $(driver_cuda_version) (maximum this driver can run)"
  log "Compute arch:   sm_$(gpu_arch)"
  log "Toolkit to use: $(cuda_toolkit_for_driver "$(driver_cuda_major)")"
}
