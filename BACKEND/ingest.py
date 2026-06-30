"""
ingest.py
Loads documents into ChromaDB knowledge base.

Three document types:
  policy  — YOUR org's internal policy/standard PDFs  → internal_policies collection
  hecvat  — HECVAT template xlsx (question guidance)  → hecvat_template collection
  soc2    — Vendor's SOC 2 Type 2 report              → soc2_controls collection
  vendor  — Any other vendor-provided PDF (internal policies, pen-test summary, etc.)
            These go into soc2_controls alongside SOC2 — all vendor evidence lives there.

IMPORTANT: The vendor's filled HECVAT is NEVER ingested. It is read at runtime only.
"""

import os
import sys
import fitz          # PyMuPDF

# Monkey patch sqlite3 with pysqlite3 for environments (like Streamlit Cloud) with older sqlite3 versions
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
from hecvat_parser import parse_hecvat_excel, hecvat_control_to_text, hecvat_control_to_metadata


# ── Chroma setup ─────────────────────────────────────────────────────────────

def get_chroma_client():
    return chromadb.PersistentClient(path=config.CHROMA_DIR)


def get_or_create_collection(client, name):
    return client.get_or_create_collection(
        name=name,
        metadata={"hnsw:space": "cosine"}
    )


# ── Embedding ─────────────────────────────────────────────────────────────────

def embed_texts(texts: list[str], batch_size: int = 64) -> list[list[float]]:
    """Embed document chunks in batches on the GPU embedding server."""
    return embed.embed_documents(texts, batch_size=batch_size)


# ── PDF parsing ───────────────────────────────────────────────────────────────

def parse_pdf(pdf_path: str) -> list[dict]:
    doc = fitz.open(pdf_path)
    pages = []
    for i, page in enumerate(doc):
        text = page.get_text("text").strip()
        if text:
            pages.append({"text": text, "page": i + 1, "source": os.path.basename(pdf_path)})
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


# ── Store chunks ──────────────────────────────────────────────────────────────

def ingest_chunks(collection, chunks: list[dict], doc_type: str):
    print(f"  Embedding {len(chunks)} chunks for [{doc_type}]...")
    texts      = [c["text"] for c in chunks]
    embeddings = embed_texts(texts)
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


# ── Public API ────────────────────────────────────────────────────────────────

def ingest_policy_pdf(pdf_path: str):
    """YOUR org's internal policy/standard → internal_policies collection."""
    print(f"\n📄 Ingesting internal policy: {pdf_path}")
    client     = get_chroma_client()
    collection = get_or_create_collection(client, config.CHROMA_COLLECTION_POLICIES)
    chunks     = chunk_pdf_pages(parse_pdf(pdf_path))
    ingest_chunks(collection, chunks, doc_type=f"policy_{os.path.basename(pdf_path)}")


def ingest_soc2_pdf(pdf_path: str):
    """
    Vendor's SOC 2 Type 2 report → soc2_controls collection.

    This is VENDOR EVIDENCE — it corroborates what the vendor claims in their HECVAT.
    It is NOT used as a policy source. The LLM is instructed to treat it as Context B.
    """
    print(f"\n📄 Ingesting vendor SOC 2: {pdf_path}")
    client     = get_chroma_client()
    collection = get_or_create_collection(client, config.CHROMA_COLLECTION_SOC2)
    chunks     = chunk_pdf_pages(parse_pdf(pdf_path))
    # Tag chunks so the LLM prompt can label them as vendor evidence
    for c in chunks:
        c["metadata"]["doc_role"] = "vendor_evidence"
        c["metadata"]["doc_type"] = "soc2"
    ingest_chunks(collection, chunks, doc_type=f"soc2_{os.path.basename(pdf_path)}")


def ingest_vendor_doc_pdf(pdf_path: str):
    """
    Any other vendor-provided document (pen-test summary, internal vendor policy, etc.)
    Also goes into soc2_controls — all vendor evidence lives in one collection.
    """
    print(f"\n📄 Ingesting vendor document: {pdf_path}")
    client     = get_chroma_client()
    collection = get_or_create_collection(client, config.CHROMA_COLLECTION_SOC2)
    chunks     = chunk_pdf_pages(parse_pdf(pdf_path))
    for c in chunks:
        c["metadata"]["doc_role"] = "vendor_evidence"
        c["metadata"]["doc_type"] = "vendor_doc"
    ingest_chunks(collection, chunks, doc_type=f"vendordoc_{os.path.basename(pdf_path)}")


def ingest_hecvat_template(excel_path: str):
    """
    HECVAT template (question guidance text) → hecvat_template collection.
    This gives the LLM richer context about what each control ID means.
    """
    print(f"\n📊 Ingesting HECVAT template: {excel_path}")
    client     = get_chroma_client()
    collection = get_or_create_collection(client, config.CHROMA_COLLECTION_HECVAT_TEMPLATE)
    controls   = parse_hecvat_excel(excel_path)
    chunks = [
        {"text": hecvat_control_to_text(c), "metadata": hecvat_control_to_metadata(c)}
        for c in controls if c["question"]
    ]
    ingest_chunks(collection, chunks, doc_type="hecvat_template")


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


# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    """
    python ingest.py policy   path/to/policy.pdf
    python ingest.py soc2     path/to/vendor_soc2.pdf
    python ingest.py vendor   path/to/vendor_other_doc.pdf
    python ingest.py hecvat   path/to/hecvat_template.xlsx
    python ingest.py stats
    """
    if len(sys.argv) < 2:
        print("Usage: python ingest.py [policy|soc2|vendor|hecvat|stats] [file_path]")
        sys.exit(1)

    cmd = sys.argv[1].lower()
    if cmd == "policy" and len(sys.argv) == 3:
        ingest_policy_pdf(sys.argv[2])
    elif cmd == "soc2" and len(sys.argv) == 3:
        ingest_soc2_pdf(sys.argv[2])
    elif cmd == "vendor" and len(sys.argv) == 3:
        ingest_vendor_doc_pdf(sys.argv[2])
    elif cmd == "hecvat" and len(sys.argv) == 3:
        ingest_hecvat_template(sys.argv[2])
    elif cmd == "stats":
        show_stats()
    else:
        print("Unknown command or missing file path.")
        sys.exit(1)
