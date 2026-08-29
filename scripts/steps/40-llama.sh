#!/usr/bin/env bash
# Build llama-cpp-python from source against the toolkit 30-cuda.sh installed.
#
# Building rather than installing a wheel is not a preference. The published CUDA wheels are
# built on newer distributions and will not load against Ubuntu 20.04's glibc, and the plain
# wheel is CPU-only. Compiling here is a one-time cost — nothing recompiles at run time.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

STEP=llama

if is_done "$STEP"; then
  if [[ "${SEDONA_FORCE_CPU:-0}" == "1" ]] || llama_cuda_ready; then
    if llama_server_ready; then
      ok "llama-cpp-python already built"
      exit 0
    fi
    # the compiled binary is good; only the pure-python server deps are missing
    log "llama-cpp-python is built but cannot serve — installing the [server] extra"
    "$(venv_python)" -m pip install -q --no-cache-dir "llama-cpp-python[server]"
    if llama_server_ready; then
      ok "llama-cpp-python server extra installed"
      exit 0
    fi
    warn "the server extra is still missing — rebuilding from source"
  else
    warn "llama-cpp-python is installed but reports no GPU offload — rebuilding"
  fi
fi

[[ -x "$(venv_python)" ]] || die "run 10-python.sh first"

if [[ "${SEDONA_FORCE_CPU:-0}" == "1" ]]; then
  warn "SEDONA_FORCE_CPU=1 — building the CPU-only llama-cpp-python"
  "$(venv_python)" -m pip install -q --no-cache-dir "llama-cpp-python[server]"
  ok "llama-cpp-python installed (CPU only — expect roughly 14 tokens/sec)"
  mark_done "$STEP"
  exit 0
fi

[[ -f "$RUNTIME_DIR/cuda.env" ]] || die "run 30-cuda.sh first"
# shellcheck disable=SC1091
source "$RUNTIME_DIR/cuda.env"

CUDA_HOME="$SEDONA_CUDA_HOME"
ARCH="$SEDONA_CUDA_ARCH"
NVCC="$CUDA_HOME/bin/nvcc"

[[ -x "$NVCC" ]] || die "no nvcc at $NVCC — re-run 30-cuda.sh"

log "building llama-cpp-python against CUDA $SEDONA_CUDA_TOOLKIT for sm_$ARCH"
log "this compiles GPU kernels and takes 10-30 minutes; it happens once"

# CMAKE_CUDA_COMPILER is passed explicitly on purpose. CMake searches PATH first, and a box with
# an older apt-installed /usr/bin/nvcc will be picked up ahead of the toolkit we just installed —
# which fails the build in a way that reads like a CUDA bug rather than a wrong compiler.
export CUDA_HOME
export PATH="$CUDA_HOME/bin:$PATH"
export LD_LIBRARY_PATH="$CUDA_HOME/lib:$CUDA_HOME/lib64:${LD_LIBRARY_PATH:-}"
export CMAKE_ARGS="-DGGML_CUDA=on -DCMAKE_CUDA_ARCHITECTURES=$ARCH -DCUDAToolkit_ROOT=$CUDA_HOME -DCMAKE_CUDA_COMPILER=$NVCC"
export FORCE_CMAKE=1

BUILD_LOG="$RUNTIME_DIR/llama-build.log"
# --no-binary names only llama-cpp-python: ":all:" would also force cmake and ninja to compile
# from source, adding many minutes to build two tools that have perfectly good wheels
if ! "$(venv_python)" -m pip install --no-binary llama-cpp-python --no-cache-dir --force-reinstall \
      "llama-cpp-python[server]" > "$BUILD_LOG" 2>&1; then
  fail "the build failed — last 25 lines of $BUILD_LOG:"
  tail -25 "$BUILD_LOG" >&2
  die "llama-cpp-python did not build"
fi

if ! llama_cuda_ready; then
  fail "llama-cpp-python built but reports no GPU offload support."
  fail "full build log: $BUILD_LOG"
  die "refusing to mark this step done — a CPU-only build here would quietly cost hours per run"
fi

if ! llama_server_ready; then
  fail "full build log: $BUILD_LOG"
  die "llama-cpp-python built but cannot run llama_cpp.server — the [server] extra is missing"
fi

ok "llama-cpp-python built with CUDA offload for sm_$ARCH"
mark_done "$STEP"
