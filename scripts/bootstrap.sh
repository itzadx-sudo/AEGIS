#!/usr/bin/env bash
# Bring a bare machine to the point where ./start.sh can run, installing everything inside this
# folder. Nothing goes to $HOME, nothing needs sudo, and deleting .runtime/ undoes all of it.
#
#   ./scripts/bootstrap.sh              run whichever steps are missing
#   ./scripts/bootstrap.sh --check      report what is missing and exit, changing nothing
#   ./scripts/bootstrap.sh --force      re-run every step from scratch
#   SEDONA_FORCE_CPU=1 ./scripts/...    build without CUDA (much slower; say so out loud)
#
# On the ollama backend (the macOS default) steps 30-cuda and 40-llama are skipped: nothing is
# compiled, and the Ollama daemon serves both models.
#
# start.sh calls this on its own when it cannot find a usable interpreter, so a first run is
# just ./start.sh.
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

STEPS=(10-python 20-requirements 30-cuda 40-llama 50-models 60-frontend)

CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --force) rm -rf "$STAMP_DIR" ;;
    -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown option '$arg'" ;;
  esac
done

# What is actually missing, judged by whether the thing works — not by whether a stamp exists.
missing_steps() {
  local missing=()
  venv_usable                  || missing+=("10-python" "20-requirements")
  if using_ollama; then
    # Nothing to compile: no CUDA toolkit, no llama-cpp-python build. "Models" here means two
    # tags the daemon can resolve, not two GGUF files on disk.
    if ! ollama_present || ! ollama_daemon_up \
       || ! ollama_model_present "$(ollama_llm_model)" \
       || ! ollama_model_present "$(ollama_embed_model)"; then
      missing+=("50-models")
    fi
  else
    if [[ "${SEDONA_FORCE_CPU:-0}" != "1" ]]; then
      cuda_usable                || missing+=("30-cuda")
      # both, or a build that compiled fine but cannot actually serve reports nothing to do
      { llama_cuda_ready && llama_server_ready; } || missing+=("40-llama")
    fi
    local chat embed
    chat="$(basename "${SEDONA_LLM_GGUF:-google_gemma-3-4b-it-Q4_K_M.gguf}")"
    embed="$(basename "${SEDONA_EMBED_GGUF:-nomic-embed-text-v1.5.f16.gguf}")"
    [[ -s "$MODEL_DIR/$chat" && -s "$MODEL_DIR/$embed" ]] || missing+=("50-models")
  fi
  [[ -d "$PROJECT_ROOT/FRONTEND/node_modules" ]] || missing+=("60-frontend")
  # ":-" is load-bearing on bash 3.2 (macOS): expanding an empty array under `set -u` is an
  # error there, which killed this function exactly when nothing was missing. awk 'NF' drops the
  # empty line the default produces.
  printf '%s\n' "${missing[@]:-}" | awk 'NF' | sort -u
}

echo
log "Sedona bootstrap — everything installs under $RUNTIME_DIR"
if using_ollama; then
  # the weights are the daemon's, under ~/.ollama, not this folder's
  log "Inference backend: ollama (chat: $(ollama_llm_model) · embeddings: $(ollama_embed_model))"
  if ! ollama_present; then
    warn "the 'ollama' command is not on PATH — install it from https://ollama.com/download"
  elif ! ollama_daemon_up; then
    warn "the Ollama daemon is not running — open Ollama.app, or run 'ollama serve'"
  fi
else
  gpu_present && report_hardware || warn "no GPU detected; a CUDA build will not be attempted"
fi
echo

MISSING="$(missing_steps)"

if [[ -z "$MISSING" ]]; then
  ok "everything is already in place — nothing to do"
  exit 0
fi

log "missing: $(echo "$MISSING" | tr '\n' ' ')"

if [[ "$CHECK_ONLY" == "1" ]]; then
  echo
  log "--check given, so nothing was installed"
  exit 1
fi

for step in "${STEPS[@]}"; do
  if ! grep -qx "$step" <<<"$MISSING"; then
    continue
  fi
  echo
  log "── $step ──"
  bash "$(dirname "${BASH_SOURCE[0]}")/steps/$step.sh"
done

echo
if [[ -n "$(missing_steps)" ]]; then
  die "bootstrap finished but these are still missing: $(missing_steps | tr '\n' ' ')"
fi
ok "bootstrap complete — run ./start.sh"
