import os
import re
import sys
import threading
import hashlib
import json
import fitz

# chromadb wants a newer sqlite3 than some hosts ship (e.g. Streamlit Cloud), so swap in pysqlite3 if available
try:
    __import__('pysqlite3')
    import sys
    sys.modules['sqlite3'] = sys.modules.pop('pysqlite3')
except ImportError:
    pass

import chromadb
from tqdm import tqdm
from langchain_text_splitters import RecursiveCharacterTextSplitter
import config
import embed
import soc2_parser
from hecvat_parser import parse_hecvat_excel, hecvat_control_to_text, hecvat_control_to_metadata


def get_chroma_client():
    return chromadb.PersistentClient(path=config.CHROMA_DIR)


def get_or_create_collection(client, name):
    return client.get_or_create_collection(
        name=name,
        metadata={"hnsw:space": "cosine"}
    )


# serialises every mutation of the vector store — concurrent upserts used to interleave
KB_LOCK = threading.RLock()

# chunk ids are "{doc_type}_{index}"; the part before the trailing _<int> is the only
# reliable per-document handle — "source" is a constant for HECVAT template ingests
_CHUNK_INDEX_SUFFIX = re.compile(r"_\d+$")
# strip the "<32-hex-uuid>_" upload prefix; anchored so it can't glue the kind prefix on
_UUID_IN_NAME = re.compile(r"^[0-9a-f]{32}_")

KB_COLLECTIONS = (
    config.CHROMA_COLLECTION_POLICIES,
    config.CHROMA_COLLECTION_HECVAT_TEMPLATE,
    config.CHROMA_COLLECTION_SOC2,
)


def _namespace_of(chunk_id: str) -> str:
    return _CHUNK_INDEX_SUFFIX.sub("", chunk_id)


def _display_name(namespace: str) -> str:
    name = namespace
    # longest first, so "hecvat_template_" isn't shadowed by a shorter match
    for prefix in ("hecvat_template_", "vendordoc_", "policy_", "soc2_"):
        if name.startswith(prefix):
            name = name[len(prefix):]
            break
    name = _UUID_IN_NAME.sub("", name, count=1)
    return name.replace("_", " ").strip() or namespace


def list_documents(collection_name: str) -> list[dict]:
    if collection_name not in KB_COLLECTIONS:
        raise ValueError(f"unknown collection '{collection_name}'")
    client = get_chroma_client()
    try:
        col = client.get_collection(collection_name)
    except Exception:
        return []  # not ingested yet
    ids = col.get(include=[]).get("ids") or []
    counts: dict[str, int] = {}
    for cid in ids:
        counts[_namespace_of(cid)] = counts.get(_namespace_of(cid), 0) + 1
    return [
        {
            "collection":   collection_name,
            "doc_id":       ns,
            "display_name": _display_name(ns),
            "chunk_count":  n,
        }
        for ns, n in sorted(counts.items(), key=lambda kv: _display_name(kv[0]).lower())
    ]


def delete_document(collection_name: str, doc_id: str) -> int:
    if collection_name not in KB_COLLECTIONS:
        raise ValueError(f"unknown collection '{collection_name}'")
    with KB_LOCK:
        client = get_chroma_client()
        try:
            col = client.get_collection(collection_name)
        except Exception:
            return 0
        ids = col.get(include=[]).get("ids") or []
        # exact namespace match, so deleting "policy_x" can't take "policy_x_v2" with it
        doomed = [cid for cid in ids if _namespace_of(cid) == doc_id]
        if doomed:
            col.delete(ids=doomed)
        return len(doomed)


def embed_texts(texts: list[str], batch_size: int = 64) -> list[list[float]]:
    return embed.embed_documents(texts, batch_size=batch_size)


def parse_pdf(pdf_path: str, source_filename: str | None = None) -> list[dict]:
    # the staged basename becomes the permanent chunk id, so prefer the caller's real filename
    source = _display_source(source_filename or pdf_path)
    doc = fitz.open(pdf_path)
    pages = []
    try:
        for i, page in enumerate(doc):
            text = page.get_text("text").strip()
            if text:
                pages.append({"text": text, "page": i + 1, "source": source})
    finally:
        doc.close()
    return pages


def chunk_pdf_pages(pages: list[dict]) -> list[dict]:
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=config.CHUNK_SIZE,
        chunk_overlap=config.CHUNK_OVERLAP,
        separators=["\n\n", "\n", ". ", " "]
    )
    chunks = []
    for page in pages:
        for j, split in enumerate(splitter.split_text(page["text"])):
            chunks.append({
                "text": split.strip(),
                "metadata": {
                    "source":      page["source"],
                    "page":        str(page["page"]),
                    "chunk_index": str(j),
                }
            })
    return chunks


def ingest_chunks(collection, chunks: list[dict], doc_type: str):
    print(f"  Embedding {len(chunks)} chunks for [{doc_type}]...")

    texts      = [c["text"] for c in chunks]
    # embed before mutating anything, and outside the lock — it's slow and touches no store state
    embeddings = embed_texts(texts)

    # everything below mutates the store, so it runs under KB_LOCK
    with KB_LOCK:
        # delete stale chunks from a prior ingest of this same source before upserting the fresh ones
        try:
            existing = collection.get(where={"source": {"$ne": "__never_matches__"}})
            stale_ids = [eid for eid in (existing.get("ids") or []) if eid.startswith(f"{doc_type}_")]
            if stale_ids:
                collection.delete(ids=stale_ids)
                print(f"  Deleted {len(stale_ids)} stale chunk(s) for [{doc_type}]")
        except Exception as e:
            print(f"  [ingest] Warning: could not delete stale chunks for [{doc_type}]: {e}")

        ids        = [f"{doc_type}_{i}" for i in range(len(chunks))]
        metadatas  = [c["metadata"] for c in chunks]

        batch = 100
        for start in tqdm(range(0, len(ids), batch), desc=f"  Storing {doc_type}"):
            end = start + batch
            collection.upsert(
                ids=ids[start:end],
                embeddings=embeddings[start:end],
                documents=texts[start:end],
                metadatas=metadatas[start:end],
            )
    print(f"  ✅ Done: {len(ids)} chunks → [{doc_type}]")
    return len(ids)


def ingest_policy_pdf(pdf_path: str, source_filename: str | None = None):
    name = _display_source(source_filename or pdf_path)
    print(f"\n📄 Ingesting internal policy: {name}")
    client     = get_chroma_client()
    collection = get_or_create_collection(client, config.CHROMA_COLLECTION_POLICIES)
    chunks     = chunk_pdf_pages(parse_pdf(pdf_path, name))
    ingest_chunks(collection, chunks, doc_type=f"policy_{name}")


# the document name to record, with any staged-upload prefix removed
def _display_source(name: str) -> str:
    return _UUID_IN_NAME.sub("", os.path.basename(str(name or ""))) or os.path.basename(str(name or ""))


def _safe_scope(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_.-]", "_", str(value or ""))[:120]


def _document_id(pdf_path: str) -> str:
    digest = hashlib.sha256()
    with open(pdf_path, "rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _scoped_vendor_chunks(
    pdf_path: str,
    *,
    document_id: str,
    document_kind: str,
    session_id: str,
    vendor_id: str,
    owner_user_id: str,
    evidence_state: str,
    source_filename: str,
) -> list[dict]:
    chunks = chunk_pdf_pages(parse_pdf(pdf_path, source_filename))
    for chunk in chunks:
        chunk["metadata"].update({
            "document_id": document_id,
            "filename": source_filename,
            "doc_role": "vendor_evidence",
            "doc_type": document_kind,
            "session_id": session_id,
            "vendor_id": vendor_id,
            "owner_user_id": owner_user_id,
            "evidence_state": evidence_state,
        })
    return chunks


def _write_extraction(session_id: str, document_id: str, payload: dict) -> str:
    directory = os.path.join(config.EVIDENCE_DIR, _safe_scope(session_id))
    os.makedirs(directory, mode=0o700, exist_ok=True)
    os.chmod(directory, 0o700)
    path = os.path.join(directory, f"{_safe_scope(document_id)}.json")
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as target:
        json.dump(payload, target, indent=2)
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
    return path


def ingest_soc2_pdf(
    pdf_path: str,
    *,
    session_id: str,
    vendor_id: str,
    owner_user_id: str,
    source_filename: str | None = None,
):
    print(f"\n📄 Ingesting vendor SOC 2: {pdf_path}")
    if not all((session_id, vendor_id, owner_user_id)):
        raise ValueError("session_id, vendor_id and owner_user_id are required for vendor evidence")
    extraction = soc2_parser.extract_soc2(pdf_path)
    source_filename = source_filename or os.path.basename(pdf_path)
    extraction["source_filename"] = source_filename
    document_id = _document_id(pdf_path)
    evidence_state = (
        "manual review required"
        if extraction["extraction_status"] == "NO_EXTRACTABLE_TEXT"
        else ("exception found" if extraction["exceptions"] else "insufficient evidence")
    )
    client     = get_chroma_client()
    collection = get_or_create_collection(client, config.CHROMA_COLLECTION_SOC2)
    chunks = _scoped_vendor_chunks(
        pdf_path,
        document_id=document_id,
        document_kind="soc2",
        session_id=session_id,
        vendor_id=vendor_id,
        owner_user_id=owner_user_id,
        evidence_state=evidence_state,
        source_filename=source_filename,
    )
    extraction_path = _write_extraction(session_id, document_id, extraction)
    if not chunks:
        return {
            "document_id": document_id,
            "chunk_count": 0,
            "extraction_path": extraction_path,
            "extraction": extraction,
            "evidence_state": evidence_state,
        }
    namespace = f"soc2_{_safe_scope(session_id)}_{document_id}"
    chunk_count = ingest_chunks(collection, chunks, doc_type=namespace)
    return {
        "document_id": document_id,
        "chunk_count": chunk_count,
        "extraction_path": extraction_path,
        "extraction": extraction,
        "evidence_state": evidence_state,
    }


def ingest_vendor_doc_pdf(
    pdf_path: str,
    *,
    session_id: str,
    vendor_id: str,
    owner_user_id: str,
    source_filename: str | None = None,
):
    # everything non-SOC2 that's vendor-supplied still lands in soc2_controls — one bucket for all vendor evidence
    print(f"\n📄 Ingesting vendor document: {pdf_path}")
    if not all((session_id, vendor_id, owner_user_id)):
        raise ValueError("session_id, vendor_id and owner_user_id are required for vendor evidence")
    document_id = _document_id(pdf_path)
    source_filename = source_filename or os.path.basename(pdf_path)
    client     = get_chroma_client()
    collection = get_or_create_collection(client, config.CHROMA_COLLECTION_SOC2)
    chunks = _scoped_vendor_chunks(
        pdf_path,
        document_id=document_id,
        document_kind="vendor_doc",
        session_id=session_id,
        vendor_id=vendor_id,
        owner_user_id=owner_user_id,
        evidence_state="insufficient evidence",
        source_filename=source_filename,
    )
    if not chunks:
        raise ValueError("document contains no extractable text; manual review is required")
    namespace = f"vendordoc_{_safe_scope(session_id)}_{document_id}"
    return {
        "document_id": document_id,
        "chunk_count": ingest_chunks(collection, chunks, doc_type=namespace),
        "evidence_state": "insufficient evidence",
    }


def list_scoped_evidence(session_id: str) -> list[dict]:
    client = get_chroma_client()
    try:
        collection = client.get_collection(config.CHROMA_COLLECTION_SOC2)
    except Exception:
        return []
    rows = collection.get(where={"session_id": session_id}, include=["metadatas"])
    documents: dict[str, dict] = {}
    for metadata in rows.get("metadatas") or []:
        metadata = metadata or {}
        document_id = metadata.get("document_id")
        if not document_id:
            continue
        record = documents.setdefault(document_id, {
            "document_id": document_id,
            "filename": metadata.get("filename"),
            "kind": metadata.get("doc_type"),
            "evidence_state": metadata.get("evidence_state"),
            "chunk_count": 0,
        })
        record["chunk_count"] += 1
    directory = os.path.join(config.EVIDENCE_DIR, _safe_scope(session_id))
    if os.path.isdir(directory):
        for filename in os.listdir(directory):
            if not filename.endswith(".json"):
                continue
            path = os.path.join(directory, filename)
            try:
                with open(path, encoding="utf-8") as source:
                    extraction = json.load(source)
            except Exception as exc:
                print(f"  [ingest] Warning: unreadable evidence sidecar {filename}: {exc}")
                continue
            document_id = filename[:-5]
            documents.setdefault(document_id, {
                "document_id": document_id,
                "filename": extraction.get("source_filename"),
                "kind": "soc2",
                "evidence_state": (
                    "manual review required"
                    if extraction.get("extraction_status") == "NO_EXTRACTABLE_TEXT"
                    else (
                        "exception found"
                        if extraction.get("exceptions")
                        else "insufficient evidence"
                    )
                ),
                "chunk_count": 0,
            })
    return sorted(documents.values(), key=lambda item: (item.get("filename") or "").lower())


def delete_scoped_evidence(session_id: str) -> int:
    removed = 0
    with KB_LOCK:
        client = get_chroma_client()
        try:
            collection = client.get_collection(config.CHROMA_COLLECTION_SOC2)
            ids = collection.get(where={"session_id": session_id}, include=[]).get("ids") or []
            if ids:
                collection.delete(ids=ids)
                removed = len(ids)
        except Exception as exc:
            print(f"  [ingest] Warning: could not delete scoped evidence for {session_id}: {exc}")
    directory = os.path.join(config.EVIDENCE_DIR, _safe_scope(session_id))
    if os.path.isdir(directory):
        for filename in os.listdir(directory):
            path = os.path.join(directory, filename)
            if os.path.isfile(path):
                os.remove(path)
        os.rmdir(directory)
    return removed


def ingest_hecvat_template(excel_path: str, source_filename: str | None = None):
    # this is the blank template for guidance text only — the vendor's filled-in HECVAT never gets ingested, just read at assessment time
    print(f"\n📊 Ingesting HECVAT template: {excel_path}")
    client     = get_chroma_client()
    collection = get_or_create_collection(client, config.CHROMA_COLLECTION_HECVAT_TEMPLATE)
    controls   = parse_hecvat_excel(excel_path, require_answers=False)
    chunks = [
        {"text": hecvat_control_to_text(c), "metadata": hecvat_control_to_metadata(c)}
        for c in controls if c["question"]
    ]
    # include the basename so two different template files get distinct id namespaces (avoids H2 silent overwrite)
    ingest_chunks(collection, chunks,
                  doc_type=f"hecvat_template_{_display_source(source_filename or excel_path)}")


def show_stats():
    client = get_chroma_client()
    print("\n📦 Knowledge Base Stats:")
    for name in [
        config.CHROMA_COLLECTION_POLICIES,
        config.CHROMA_COLLECTION_HECVAT_TEMPLATE,
        config.CHROMA_COLLECTION_SOC2,
    ]:
        try:
            col = client.get_collection(name)
            print(f"  {name}: {col.count()} chunks")
        except Exception:
            print(f"  {name}: (not found — run ingest first)")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python ingest.py [policy|soc2|vendor|hecvat|stats] [file_path]")
        sys.exit(1)

    cmd = sys.argv[1].lower()
    if cmd == "policy" and len(sys.argv) == 3:
        ingest_policy_pdf(sys.argv[2])
    elif cmd in ("soc2", "vendor"):
        print("Vendor evidence must be uploaded through an authorized assessment session.")
        sys.exit(2)
    elif cmd == "hecvat" and len(sys.argv) == 3:
        ingest_hecvat_template(sys.argv[2])
    elif cmd == "stats":
        show_stats()
    else:
        print("Unknown command or missing file path.")
        sys.exit(1)
