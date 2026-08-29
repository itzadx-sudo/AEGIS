# chromadb needs a newer sqlite3 than some hosts ship
try:
    __import__('pysqlite3')
    import sys
    sys.modules['sqlite3'] = sys.modules.pop('pysqlite3')
except ImportError:
    pass

import chromadb
import config
import embed

_client = None
_collections = {}


def _get_client():
    global _client
    if _client is None:
        _client = chromadb.PersistentClient(path=config.CHROMA_DIR)
    return _client


def invalidate_cache() -> None:
    _collections.clear()


def _embed_query(query: str) -> list[float]:
    return embed.embed_query(query)


def _query_collection(
    col_name: str,
    query_emb: list[float],
    top_k: int,
    *,
    where: dict | None = None,
) -> list[dict]:
    client = _get_client()
    try:
        col = _collections.get(col_name)
        if col is None:
            try:
                col = client.get_collection(col_name)
                _collections[col_name] = col
            except Exception as e:
                # usually just "not ingested yet" — log it so a corrupt store isn't silent
                print(f"  [rag] collection '{col_name}' unavailable ({e}) — treating as no hits")
                return []
        col_count = col.count()
        if col_count == 0:
            return []
        query_args = {
            "query_embeddings": [query_emb],
            "n_results": min(top_k, col_count),
            "include": ["documents", "metadatas", "distances"],
        }
        if where:
            query_args["where"] = where
        res = col.query(
            **query_args,
        )
        results = []
        for chunk_id, doc, meta, dist in zip(
            res["ids"][0],
            res["documents"][0],
            res["metadatas"][0],
            res["distances"][0],
        ):
            results.append({
                "text":       doc,
                # chroma hands back None for a chunk stored without metadata
                "metadata":   meta or {},
                "collection": col_name,
                "chunk_id":   chunk_id,
                "similarity": round(1 - dist, 4),
            })
        return results
    except Exception as e:
        # corruption or a dimension mismatch — don't mask this as "no data"
        print(f"  [RAG] Error querying '{col_name}': {e}")
        raise


def retrieve(
    query: str,
    top_k: int = None,
    *,
    session_id: str | None = None,
    vendor_id: str | None = None,
) -> dict:
    if top_k is None:
        top_k = config.TOP_K_RESULTS

    query_emb = _embed_query(query)

    # keep these apart — merged, HECVAT guidance reads to the model as Murdoch policy
    policy_chunks = _query_collection(config.CHROMA_COLLECTION_POLICIES, query_emb, top_k)
    policy_chunks.sort(key=lambda x: x["similarity"], reverse=True)

    hecvat_chunks = _query_collection(config.CHROMA_COLLECTION_HECVAT_TEMPLATE, query_emb, top_k)
    hecvat_chunks.sort(key=lambda x: x["similarity"], reverse=True)

    # no session id, no vendor evidence — unscoped chunks stay out of Context B
    vendor_chunks = (
        _query_collection(
            config.CHROMA_COLLECTION_SOC2,
            query_emb,
            config.TOP_K_VENDOR_RESULTS,
            where={"session_id": session_id},
        )
        if session_id else []
    )
    vendor_chunks = [
        chunk for chunk in vendor_chunks
        if (chunk.get("metadata") or {}).get("session_id") == session_id
        and (
            vendor_id is None
            or (chunk.get("metadata") or {}).get("vendor_id") == vendor_id
        )
    ]
    vendor_chunks.sort(key=lambda x: x["similarity"], reverse=True)

    # only real policy counts toward the coverage gate
    best_similarity = policy_chunks[0]["similarity"] if policy_chunks else 0.0

    return {
        "policy_chunks":           policy_chunks,
        "hecvat_chunks":           hecvat_chunks,
        "vendor_chunks":           vendor_chunks,
        "best_policy_similarity":  best_similarity,
        # questionnaire match quality, never counted as policy coverage
        "best_hecvat_similarity":  hecvat_chunks[0]["similarity"] if hecvat_chunks else 0.0,
    }


def policy_corpus_size() -> int:
    client = _get_client()
    total = 0
    for name in (config.CHROMA_COLLECTION_POLICIES, config.CHROMA_COLLECTION_HECVAT_TEMPLATE):
        try:
            total += client.get_collection(name).count()
        except Exception:
            pass  # collection not ingested yet — contributes nothing, which is the case we're detecting
    return total


def has_sufficient_context(retrieval_result: dict) -> bool:
    # policy similarity only — vendor evidence alone is not something to assess against
    return retrieval_result["best_policy_similarity"] >= config.MIN_SIMILARITY


def build_context_block(retrieval_result: dict) -> str:
    lines = []

    lines.append("=== CONTEXT A: Internal Policies (what your organisation requires) ===")
    policy_chunks = retrieval_result["policy_chunks"]
    if policy_chunks:
        for i, c in enumerate(policy_chunks, 1):
            meta = c.get("metadata") or {}
            src = meta.get("source", "unknown")
            sec = meta.get("section", "")
            label = f"[Policy {i}: {src}" + (f" | {sec}" if sec else "") + "]"
            lines.append(f"{label}\n{c['text']}")
    else:
        lines.append("NO INTERNAL POLICY CONTEXT FOUND.")

    lines.append("")
    lines.append("=== CONTEXT A2: HECVAT Guidance (framework expectation — NOT your policy) ===")
    hecvat_chunks = retrieval_result.get("hecvat_chunks") or []
    if hecvat_chunks:
        for i, c in enumerate(hecvat_chunks, 1):
            meta = c.get("metadata") or {}
            sec = meta.get("section", "")
            label = f"[HECVAT {i}" + (f" | {sec}" if sec else "") + "]"
            lines.append(f"{label}\n{c['text']}")
    else:
        lines.append("No HECVAT guidance retrieved for this control.")

    lines.append("")
    lines.append("=== CONTEXT B: Vendor Evidence (SOC 2 / supporting docs) ===")
    vendor_chunks = retrieval_result["vendor_chunks"]
    if vendor_chunks:
        for i, c in enumerate(vendor_chunks, 1):
            meta = c.get("metadata") or {}
            src = meta.get("source", "unknown")
            dtype = meta.get("doc_type", "vendor")
            label = f"[Vendor Evidence {i}: {src} ({dtype})]"
            lines.append(f"{label}\n{c['text']}")
    else:
        lines.append("No vendor evidence documents ingested.")

    return "\n\n".join(lines)
