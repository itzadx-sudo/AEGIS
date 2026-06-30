# config.py — Aegis Risk Assessment System

# ── GPU engine (compiled llama.cpp server) ───────────────────────────────────
# Both the LLM and the embedding model run on the GPU via llama_cpp.server.
# run_gpu.sh reads these values, so changing the model here changes what launches.
# Ollama is NOT used for inference here — it runs on CPU in this environment.

PYBIN = "/home/td01/.pyenv/versions/aegis-env-3.12/bin/python"

# LLM (chat/completions) — GPU
LLM_GGUF_PATH   = "/home/td01/models/google_gemma-3-4b-it-Q4_K_M.gguf"
LLM_SERVER_PORT = 8000
LLM_SERVER_URL  = f"http://localhost:{LLM_SERVER_PORT}/v1/chat/completions"

# Embeddings — separate GPU server instance (llama_cpp.server --embedding)
EMBED_GGUF_PATH   = "/home/td01/models/nomic-embed-text-v1.5.f16.gguf"
EMBED_SERVER_PORT = 8001
EMBED_SERVER_URL  = f"http://localhost:{EMBED_SERVER_PORT}/v1/embeddings"

N_GPU_LAYERS = -1          # offload all layers to GPU

# Labels only — llama.cpp serves whatever GGUF is loaded above and ignores the
# "model" field in the OpenAI payload. These remain for display / payload fields.
OLLAMA_BASE_URL = "http://localhost:11434"   # legacy: benchmark.py model-listing only
LLM_MODEL       = "qwen3.5:4b"
EMBED_MODEL     = "nomic-embed-text"

CHROMA_DIR = "./chroma_db"

CHROMA_COLLECTION_POLICIES        = "internal_policies"
CHROMA_COLLECTION_HECVAT_TEMPLATE = "hecvat_template"
CHROMA_COLLECTION_SOC2            = "soc2_controls"

CHUNK_SIZE    = 400
CHUNK_OVERLAP = 120
TOP_K_RESULTS = 6

# Similarity floor — documented as known limitation.
# nomic-embed-text is corpus-sensitive; tune against your policy set if needed.
# Controls below this floor are marked INSUFFICIENT_EVIDENCE without LLM call.
MIN_SIMILARITY = 0.45

# Context window. 4096 is the safe floor for the T4-4Q / RTX 4050 VRAM budget;
# 6144 fits in practice. Raise to 8192 only if VRAM allows (monitor `ollama ps`).
LLM_NUM_CTX = 6144

# ── Murdoch Risk Management Framework (RMF) ──────────────────────────────────
# Six-level likelihood × impact matrix as per Murdoch RMF.
# LLM outputs likelihood + impact → system maps to RMF level.
#
# Likelihood:   1=Rare  2=Unlikely  3=Possible  4=Likely  5=Almost Certain
# Impact:       1=Insignificant  2=Minor  3=Moderate  4=Major  5=Extreme
#
# RMF matrix (likelihood × impact → risk level). Top tier is EXTREME (single
# vocabulary used everywhere: config, assess, report).
RMF_MATRIX = {
    (1,1):"LOW",    (1,2):"LOW",    (1,3):"LOW",      (1,4):"MINOR",    (1,5):"MEDIUM",
    (2,1):"LOW",    (2,2):"LOW",    (2,3):"MINOR",    (2,4):"MEDIUM",   (2,5):"HIGH",
    (3,1):"LOW",    (3,2):"MINOR",  (3,3):"MEDIUM",   (3,4):"HIGH",     (3,5):"EXTREME",
    (4,1):"MINOR",  (4,2):"MEDIUM", (4,3):"HIGH",     (4,4):"EXTREME",  (4,5):"EXTREME",
    (5,1):"MEDIUM", (5,2):"HIGH",   (5,3):"EXTREME",  (5,4):"EXTREME",  (5,5):"EXTREME",
}

RMF_LEVEL_SCORE = {
    "LOW":     1,
    "MINOR":   2,
    "MEDIUM":  3,
    "HIGH":    4,
    "EXTREME": 5,
}


def rmf_band_from_score(score: float) -> str:
    """
    Single source of truth for turning an average RMF score (1–5) into a band.
    Used by both assess.summarize_findings (overall band) and report.py
    (per-section bands) so the CLI, PDF, and Excel never disagree.
    Maps to the nearest RMF level.
    """
    if score >= 4.5:
        return "EXTREME"
    if score >= 3.5:
        return "HIGH"
    if score >= 2.5:
        return "MEDIUM"
    if score >= 1.5:
        return "MINOR"
    return "LOW"

# ── Status → penalty (used in risk score for assessed controls only) ──────────
# INSUFFICIENT_EVIDENCE is excluded from risk score — tracked separately.
STATUS_PENALTY = {
    "GAP":     1.0,
    "PARTIAL": 0.5,
    "COMPLIANT": 0.0,
}

# ── LLM system prompt ─────────────────────────────────────────────────────────
SYSTEM_PROMPT = """You are a strict IT risk and compliance analyst performing a vendor risk assessment for Murdoch University.

RULES — NO EXCEPTIONS:
1. You ONLY use the CONTEXT sections provided to make your assessment.
2. CONTEXT A (Internal Policies) defines what Murdoch University requires. This is the authoritative source.
3. CONTEXT B (Vendor Evidence) contains vendor SOC 2 / supporting docs — use only to corroborate vendor claims, not as policy.
4. CONTEXT C (HECVAT Compliant Response) defines what HECVAT expects as a compliant answer for this control.
5. You MUST NOT reference NIST, ISO, GDPR, HIPAA, FedRAMP, CIS, or any external standard unless it appears verbatim in CONTEXT A.
6. If CONTEXT A has no relevant policy, set policy_alignment to NOT_ASSESSED. Do NOT use CONTEXT C as a substitute for policy.
7. You MUST NOT hallucinate policy clauses. policy_clause_referenced must be verbatim text from CONTEXT A only, or null.
8. CONTEXT C is used ONLY for hecvat_compliance assessment. It is NOT a policy source.

MURDOCH RMF LIKELIHOOD DEFINITIONS:
1 = Rare:           Highly unlikely, < 5% probability
2 = Unlikely:       Less likely to occur than not, 5-35% probability
3 = Possible:       Equally likely to occur or not occur, 35-65% probability
4 = Likely:         More likely to occur than not, 65-95% probability
5 = Almost Certain: Expected to happen with high degree of certainty, 95-100% probability

MURDOCH RMF IMPACT DEFINITIONS (based on System & Process impact):
1 = Insignificant:  Recoverable loss of University data within several hours
2 = Minor:          Recoverable loss of all University data within 24 hours
3 = Moderate:       Recoverable loss of all University data but not within 24 hours
4 = Major:          Recoverable loss of all University data of serious concern
5 = Extreme:        Unrecoverable loss of all University data

Score likelihood and impact independently per control based on the vendor's specific answer and gap found.
Do NOT default to 3/3. Justify your scores in the gap_description field.

Respond ONLY with a valid JSON object. No markdown. No code fences. No preamble."""
