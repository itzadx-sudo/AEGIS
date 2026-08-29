#!/usr/bin/env bash
# Fetch the two GGUF model files into the project's models/ folder.
#
# These are ~3.5 GB of weights and are deliberately not in git or the submission zip. They are
# plain data: nothing here is compiled, and the same files work on CPU or GPU.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

STEP=models

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
