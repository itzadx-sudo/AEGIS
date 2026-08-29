import json
import urllib.request

import config

# nomic-embed-text needs these instruction prefixes to score properly
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
        with urllib.request.urlopen(req, timeout=60) as response:
            data = json.loads(response.read().decode("utf-8"))
    except Exception as e:
        raise RuntimeError(f"Embedding server call failed ({config.EMBED_SERVER_URL}): {e}")

    if "data" not in data:
        raise ValueError(f"Unexpected embedding response: {data}")
    # the server may answer out of order — re-sort by its index
    ordered = sorted(data["data"], key=lambda d: d.get("index", 0))
    result = [d["embedding"] for d in ordered]
    # a count mismatch would misalign the positional zip in ingest_chunks
    if len(result) != len(inputs):
        raise ValueError(f"Embedding count mismatch: sent {len(inputs)}, got {len(result)}")
    return result


def embed_query(text: str) -> list[float]:
    return _post_embeddings([_QUERY_PREFIX + text])[0]


def embed_documents(texts: list[str], batch_size: int = 64) -> list[list[float]]:
    embeddings: list[list[float]] = []
    for start in range(0, len(texts), batch_size):
        batch = [_DOCUMENT_PREFIX + t for t in texts[start:start + batch_size]]
        embeddings.extend(_post_embeddings(batch))
    return embeddings
