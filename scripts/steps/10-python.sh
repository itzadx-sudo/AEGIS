#!/usr/bin/env bash
# Put a Python of the right version inside the project, without sudo and without touching
# whatever the host already has on PATH.
#
# Miniforge rather than the system package manager: the target box may be Ubuntu 20.04 with
# python3.8, and installing a newer Python system-wide needs root and a PPA. A conda install
# under .runtime/ needs neither and is deleted by removing the folder.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

STEP=python

if is_done "$STEP" && venv_usable; then
  ok "python environment already present"
  exit 0
fi

# An interpreter the operator has already pointed at, or one the host happens to ship at the
# right version, is preferred over downloading 100 MB of conda for no reason.
host_python() {
  local candidate
  for candidate in "${SEDONA_PYBIN:-}" "python$PYTHON_VERSION" python3; do
    [[ -n "$candidate" ]] || continue
    command -v "$candidate" >/dev/null 2>&1 || continue
    local full; full="$(command -v "$candidate")"
    "$full" -c "import sys; raise SystemExit(0 if sys.version_info[:2] >= tuple(int(p) for p in '$PYTHON_VERSION'.split('.')) else 1)" 2>/dev/null \
      && { echo "$full"; return 0; }
  done
  return 1
}

BASE_PYTHON="$(host_python || true)"

if [[ -z "$BASE_PYTHON" ]]; then
  log "no Python >= $PYTHON_VERSION on this host; installing one under .runtime/"
  if [[ ! -x "$CONDA_DIR/bin/python" ]]; then
    case "$(uname -s)-$(uname -m)" in
      Linux-x86_64)  MF_ARCH=Linux-x86_64 ;;
      Linux-aarch64) MF_ARCH=Linux-aarch64 ;;
      Darwin-arm64)  MF_ARCH=MacOSX-arm64 ;;
      Darwin-x86_64) MF_ARCH=MacOSX-x86_64 ;;
      *) die "unsupported platform $(uname -s)-$(uname -m)" ;;
    esac
    url="${SEDONA_MINIFORGE_URL:-https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-$MF_ARCH.sh}"
    log "downloading Miniforge ($MF_ARCH)"
    fetch "$url" "$RUNTIME_DIR/miniforge.sh"
    bash "$RUNTIME_DIR/miniforge.sh" -b -p "$CONDA_DIR"
    rm -f "$RUNTIME_DIR/miniforge.sh"
  fi
  "$CONDA_DIR/bin/conda" install -y -q "python=$PYTHON_VERSION" >/dev/null
  BASE_PYTHON="$CONDA_DIR/bin/python"
fi

log "base interpreter: $BASE_PYTHON ($("$BASE_PYTHON" -V 2>&1))"

if [[ ! -x "$(venv_python)" ]]; then
  log "creating the project virtual environment"
  "$BASE_PYTHON" -m venv "$VENV_DIR"
fi
"$(venv_python)" -m pip install -q --upgrade pip setuptools wheel

ok "python environment ready at $VENV_DIR"
mark_done "$STEP"
