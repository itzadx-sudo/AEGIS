#!/usr/bin/env bash
# Install a CUDA toolkit into the project, matched to whatever driver this box actually has.
#
# The toolkit is a *compiler*, needed once to turn llama.cpp's .cu kernels into machine code for
# this GPU. The driver is never touched and nothing is installed system-wide.
#
# The version is chosen, not hardcoded. The rule that matters: stay inside the driver's own CUDA
# major line. NVIDIA's minor-version compatibility means an 11.8 build runs on a driver that
# reports 11.0, which is exactly why this project works on a 450-series driver — but a 12.x
# binary on that same driver fails at load time, so crossing the major is never attempted.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

STEP=cuda

if [[ "${SEDONA_FORCE_CPU:-0}" == "1" ]]; then
  warn "SEDONA_FORCE_CPU=1 — skipping the CUDA toolkit; inference will run on CPU"
  mark_done "$STEP"
  exit 0
fi

if is_done "$STEP" && cuda_usable; then
  ok "CUDA toolkit already present ($("$(cuda_nvcc)" --version 2>/dev/null | sed -n 's/.*release \([0-9.]*\).*/\1/p' | head -1))"
  exit 0
fi

if ! gpu_present; then
  die "no NVIDIA GPU detected by nvidia-smi.
       Sedona will not silently fall back to CPU: a full assessment takes roughly four hours
       without a GPU, and starting one unknowingly wastes an afternoon.
       Re-run with SEDONA_FORCE_CPU=1 if you genuinely want the CPU build."
fi

report_hardware

DRIVER_MAJOR="$(driver_cuda_major)"
ARCH="$(gpu_arch)"
TOOLKIT="$(cuda_toolkit_for_driver "$DRIVER_MAJOR")"

[[ -n "$DRIVER_MAJOR" ]] || die "could not read the driver's CUDA version from nvidia-smi"
[[ -n "$ARCH" ]] || die "could not determine this GPU's compute capability.
       Set SEDONA_CUDA_ARCH (e.g. 75 for a T4) and re-run."
[[ -n "$TOOLKIT" ]] || die "no known CUDA toolkit for driver CUDA major '$DRIVER_MAJOR'.
       Set SEDONA_CUDA_VERSION to a toolkit inside the ${DRIVER_MAJOR}.x line and re-run."

# conda is only used as a package manager for the toolkit here — it needs no root and keeps
# every file under .runtime/
if [[ ! -x "$CONDA_DIR/bin/conda" ]]; then
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64)  MF_ARCH=Linux-x86_64 ;;
    Linux-aarch64) MF_ARCH=Linux-aarch64 ;;
    *) die "the CUDA toolkit is only packaged for Linux x86_64/aarch64" ;;
  esac
  url="${SEDONA_MINIFORGE_URL:-https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-$MF_ARCH.sh}"
  log "downloading Miniforge to host the toolkit"
  fetch "$url" "$RUNTIME_DIR/miniforge.sh"
  bash "$RUNTIME_DIR/miniforge.sh" -b -p "$CONDA_DIR"
  rm -f "$RUNTIME_DIR/miniforge.sh"
fi

log "installing CUDA toolkit $TOOLKIT into $CUDA_ENV_DIR (this is a large download)"
"$CONDA_DIR/bin/conda" create -y -q -p "$CUDA_ENV_DIR" \
  -c "nvidia/label/cuda-$TOOLKIT" cuda-toolkit

cuda_usable || die "the toolkit installed but $(cuda_nvcc) is missing"

# Record what was chosen so 40-llama.sh builds against exactly this, and so a later failure can
# be diagnosed without guessing what the machine looked like at install time.
# every value is quoted: GPU names contain spaces ("GRID T4-8Q"), and an unquoted one turns
# `source cuda.env` into an attempt to run T4-8Q as a command, which under set -e kills the
# build step that reads this file
cat > "$RUNTIME_DIR/cuda.env" <<EOF
# written by 30-cuda.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
SEDONA_CUDA_HOME="$CUDA_ENV_DIR"
SEDONA_CUDA_ARCH="${SEDONA_CUDA_ARCH:-$ARCH}"
SEDONA_CUDA_TOOLKIT="$TOOLKIT"
SEDONA_DRIVER_CUDA="$(driver_cuda_version)"
SEDONA_GPU_NAME="$(gpu_name)"
EOF

ok "CUDA $TOOLKIT toolkit installed for sm_${SEDONA_CUDA_ARCH:-$ARCH}"
mark_done "$STEP"
