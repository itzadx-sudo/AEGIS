"""
rag.py
Retrieves context from ChromaDB for a given control query.

Two separate retrieval paths:
  - Internal policies  → what YOUR org requires (authoritative policy source)
  - Vendor evidence    → SOC 2 + other vendor docs (corroborating the vendor's claims)

The LLM prompt labels these separately so the model knows which is policy vs evidence.
"""

# Monkey patch sqlite3 with pysqlite3 for environments (like Streamlit Cloud) with older sqlite3 versions
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


def _embed_query(query: str) -> list[float]:
    return embed.embed_query(query)


def _query_collection(col_name: str, query_emb: list[float], top_k: int) -> list[dict]:
    client = _get_client()
    try:
        try:
            if col_name in _collections:
                col = _collections[col_name]
            else:
                col = client.get_collection(col_name)
                _collections[col_name] = col
        except Exception:
            return []   # collection not yet created — silently skip
        col_count = col.count()
        if col_count == 0:
            return []
        res = col.query(
            query_embeddings=[query_emb],
            n_results=min(top_k, col_count),
            include=["documents", "metadatas", "distances"],
        )
        results = []
        for doc, meta, dist in zip(res["documents"][0], res["metadatas"][0], res["distances"][0]):
            results.append({
                "text":       doc,
                "metadata":   meta,
                "collection": col_name,
                "similarity": round(1 - dist, 4),
            })
        return results
    except Exception as e:
        print(f"  [RAG] Warning: could not query '{col_name}': {e}")
        return []


def retrieve(query: str, top_k: int = None) -> dict:
    """
    Returns:
        {
          "policy_chunks":  [...],   # from internal_policies + hecvat_template
          "vendor_chunks":  [...],   # from soc2_controls (vendor evidence)
          "best_policy_similarity": float
        }
    """
    if top_k is None:
        top_k = config.TOP_K_RESULTS

    query_emb = _embed_query(query)

    # Policy context: internal org policies (what is required)
    policy_chunks = _query_collection(config.CHROMA_COLLECTION_POLICIES, query_emb, top_k)

    # Sort by similarity
    all_policy = policy_chunks
    all_policy.sort(key=lambda x: x["similarity"], reverse=True)
    all_policy = all_policy[:top_k]

    # Vendor evidence context (corroborating)
    vendor_chunks = _query_collection(config.CHROMA_COLLECTION_SOC2, query_emb, 3)
    vendor_chunks.sort(key=lambda x: x["similarity"], reverse=True)

    best_similarity = all_policy[0]["similarity"] if all_policy else 0.0

    return {
        "policy_chunks":           all_policy,
        "vendor_chunks":           vendor_chunks,
        "best_policy_similarity":  best_similarity,
    }


def has_sufficient_context(retrieval_result: dict) -> bool:
    """
    Gate on policy similarity only. Vendor evidence alone is not enough
    to assess a control — we need internal policy context.
    """
    return retrieval_result["best_policy_similarity"] >= config.MIN_SIMILARITY


def build_context_block(retrieval_result: dict) -> str:
    """
    Build the two-section context block passed to the LLM:
      CONTEXT A — Internal Policies (authoritative)
      CONTEXT B — Vendor Evidence   (corroborating)
    """
    lines = []

    # Context A: internal policies
    lines.append("=== CONTEXT A: Internal Policies (what your organisation requires) ===")
    policy_chunks = retrieval_result["policy_chunks"]
    if policy_chunks:
        for i, c in enumerate(policy_chunks, 1):
            src = c["metadata"].get("source", "unknown")
            sec = c["metadata"].get("section", "")
            label = f"[Policy {i}: {src}" + (f" | {sec}" if sec else "") + "]"
            lines.append(f"{label}\n{c['text']}")
    else:
        lines.append("NO INTERNAL POLICY CONTEXT FOUND.")

    lines.append("")
    lines.append("=== CONTEXT B: Vendor Evidence (SOC 2 / supporting docs) ===")
    vendor_chunks = retrieval_result["vendor_chunks"]
    if vendor_chunks:
        for i, c in enumerate(vendor_chunks, 1):
            src = c["metadata"].get("source", "unknown")
            dtype = c["metadata"].get("doc_type", "vendor")
            label = f"[Vendor Evidence {i}: {src} ({dtype})]"
            lines.append(f"{label}\n{c['text']}")
    else:
        lines.append("No vendor evidence documents ingested.")

    return "\n\n".join(lines)
