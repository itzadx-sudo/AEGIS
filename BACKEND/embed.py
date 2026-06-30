"""
embed.py — embedding via the GPU llama.cpp server (OpenAI-compatible endpoint).

Replaces the previous Ollama embedding path (which ran on CPU here). Both query
and document embeddings go through config.EMBED_SERVER_URL, served on the GPU by
run_gpu.sh / gpu_engine.

nomic-embed-text REQUIRES instruction prefixes that Ollama added implicitly:
  • queries   → "search_query: ..."
  • documents → "search_document: ..."
We add them explicitly here so stored vectors and query vectors stay aligned.
"""

import json
import urllib.request

import config

_QUERY_PREFIX    = "search_query: "
_DOCUMENT_PREFIX = "search_document: "


def _post_embeddings(inputs: list[str]) -> list[list[float]]:
    payload = {"model": config.EMBED_MODEL, "input": inputs}
    req = urllib.request.Request(
        config.EMBED_SERVER_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as response:
            data = json.loads(response.read().decode("utf-8"))
    except Exception as e:
        raise RuntimeError(f"Embedding server call failed ({config.EMBED_SERVER_URL}): {e}")

    if "data" not in data:
        raise ValueError(f"Unexpected embedding response: {data}")
    # Preserve request order (the endpoint returns an `index` per item).
    ordered = sorted(data["data"], key=lambda d: d.get("index", 0))
    return [d["embedding"] for d in ordered]


def embed_query(text: str) -> list[float]:
    """Embed a single search query (with the nomic query prefix)."""
    return _post_embeddings([_QUERY_PREFIX + text])[0]


def embed_documents(texts: list[str], batch_size: int = 64) -> list[list[float]]:
    """Embed document chunks in batches (with the nomic document prefix)."""
    embeddings: list[list[float]] = []
    for start in range(0, len(texts), batch_size):
        batch = [_DOCUMENT_PREFIX + t for t in texts[start:start + batch_size]]
        embeddings.extend(_post_embeddings(batch))
    return embeddings
