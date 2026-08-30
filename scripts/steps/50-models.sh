#!/usr/bin/env bash
# Make the chat and embedding models available to whichever backend is in use.
#
# llama_cpp — fetch the two GGUF files into the project's models/ folder. These are ~3.5 GB of
#             weights, deliberately not in git or the submission zip. They are plain data:
#             nothing here is compiled, and the same files work on CPU or GPU.
# ollama    — ask the daemon to pull the two tags. A "*-cloud" tag is a few hundred bytes of
#             manifest rather than gigabytes of weights: the model itself stays on ollama.com.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

STEP=models

# ── ollama backend ───────────────────────────────────────────────────────────
if using_ollama; then
  LLM_TAG="$(ollama_llm_model)"
  EMBED_TAG="$(ollama_embed_model)"

  ollama_present || die "the 'ollama' command was not found.
       Install Ollama from https://ollama.com/download and re-run.
       Ollama is the one dependency this bootstrap cannot install for you."

  ollama_daemon_up || die "the Ollama daemon is not responding.
       Open Ollama.app, or run 'ollama serve' in another terminal, then re-run."

  pull_tag() {  # $1 = tag, $2 = human label
    local tag="$1" label="$2"
    if ollama_model_present "$tag"; then
      ok "$label already present: $tag"
      return 0
    fi
    log "pulling the $label ($tag)"
    if ollama pull "$tag"; then
      ok "$label ready: $tag"
      return 0
    fi
    # A cloud tag resolves through your ollama.com account, so an unauthenticated daemon fails
    # here with an error that does not name the actual fix.
    case "$tag" in
      *-cloud) die "could not pull '$tag'.
       Cloud models need an ollama.com account. Run 'ollama signin' and re-run.
       To stay entirely local instead, set LLM_MODEL in BACKEND/config.py to a local tag
       such as gemma3:4b." ;;
      *)       die "could not pull '$tag'. Check the tag name against 'ollama list'." ;;
    esac
  }

  pull_tag "$LLM_TAG"   "chat model"
  pull_tag "$EMBED_TAG" "embedding model"

  ok "models ready via ollama"
  mark_done "$STEP"
  exit 0
fi

# ── llama_cpp backend ────────────────────────────────────────────────────────

CHAT_NAME="$(basename "${SEDONA_LLM_GGUF:-google_gemma-3-4b-it-Q4_K_M.gguf}")"
EMBED_NAME="$(basename "${SEDONA_EMBED_GGUF:-nomic-embed-text-v1.5.f16.gguf}")"

CHAT_URL="${SEDONA_LLM_GGUF_URL:-https://huggingface.co/unsloth/gemma-3-4b-it-GGUF/resolve/main/gemma-3-4b-it-Q4_K_M.gguf}"
EMBED_URL="${SEDONA_EMBED_GGUF_URL:-https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.f16.gguf}"

have_models() {
  [[ -s "$MODEL_DIR/$CHAT_NAME" && -s "$MODEL_DIR/$EMBED_NAME" ]]
}

if have_models; then
  ok "models already present in $MODEL_DIR"
  mark_done "$STEP"
  exit 0
fi

mkdir -p "$MODEL_DIR"

# A partially downloaded GGUF loads far enough to look plausible and then fails deep inside
# llama.cpp, so fetch() writes to .part and only renames on a clean exit.
if [[ ! -s "$MODEL_DIR/$CHAT_NAME" ]]; then
  log "downloading the chat model (~2.5 GB) -> $CHAT_NAME"
  fetch "$CHAT_URL" "$MODEL_DIR/$CHAT_NAME"
fi

if [[ ! -s "$MODEL_DIR/$EMBED_NAME" ]]; then
  log "downloading the embedding model (~270 MB) -> $EMBED_NAME"
  fetch "$EMBED_URL" "$MODEL_DIR/$EMBED_NAME"
fi

have_models || die "model download did not produce both files in $MODEL_DIR"

ok "models ready in $MODEL_DIR"
mark_done "$STEP"
