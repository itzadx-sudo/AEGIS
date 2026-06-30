"""
assess.py — Core assessment engine.

Two-layer assessment per finding:
  Layer 1 (hecvat_compliance)  — vendor answer vs HECVAT compliant response
  Layer 2 (policy_alignment)   — vendor answer vs Murdoch internal policy

Risk scoring uses Murdoch RMF likelihood × impact matrix (6 levels).
INSUFFICIENT_EVIDENCE excluded from risk score — tracked as coverage metric.

Follow-up re-assessment uses original question/answer text, not LLM summaries.
"""

import json
import re
import os
from datetime import datetime
from collections import Counter, defaultdict

import urllib.request
import config
import rag
from hecvat_parser import parse_hecvat_excel


# ── Parse vendor HECVAT ───────────────────────────────────────────────────────

def parse_uploaded_hecvat(excel_path: str) -> list:
    raw = parse_hecvat_excel(excel_path, debug=False)
    controls = []
    skipped_na = 0
    for c in raw:
        if c.get("is_na_routed"):
            skipped_na += 1
            continue
        controls.append({
            "control_id":         c["control_id"],
            "section":            c["section"],
            "sheet":              c["sheet"],
            "question":           c["question"],           # original — preserved for re-assessment
            "response":           c["answer"] or "Not answered",  # original — preserved
            "evidence":           c.get("additional_info", "") or c.get("analyst_notes", "") or "",
            "guidance":           c.get("guidance", "") or "",
            "compliant_response": c.get("compliant_response", "") or "",  # Layer 1 reference
            "is_critical":        c.get("is_critical", False),
            "weight":             c.get("weight", 10),
        })
    if skipped_na:
        print(f"  Skipped {skipped_na} routing-excluded (N/A) controls")
    return controls


# ── Build prompt (two-layer) ──────────────────────────────────────────────────

def build_prompt(control: dict, context_block: str) -> str:
    compliant_response = control.get("compliant_response", "Not specified")
    return f"""{context_block}

=== CONTEXT C: HECVAT Compliant Response (Layer 1 reference) ===
The HECVAT framework considers the following as a compliant answer for this control:
{compliant_response if compliant_response else "Not specified in HECVAT template."}

=== CONTROL BEING ASSESSED ===
Control ID  : {control['control_id']}
Section     : {control['section']} (Sheet: {control.get('sheet', '')})
Requirement : {control['question']}

=== VENDOR RESPONSE ===
Response    : {control['response']}
Evidence    : {control['evidence'] or 'None provided'}

=== YOUR TASK ===
Perform a TWO-LAYER assessment:

LAYER 1 — HECVAT Compliance: Does vendor response match CONTEXT C (HECVAT compliant response)?
LAYER 2 — Policy Alignment: Does vendor response satisfy CONTEXT A (Murdoch internal policy)?
  - If CONTEXT A has no relevant policy for this control, set policy_alignment to NOT_ASSESSED.
  - If CONTEXT A has relevant policy, assess whether vendor satisfies it.

Then score likelihood and impact per Murdoch RMF:
  Likelihood: 1=Rare 2=Unlikely 3=Possible 4=Likely 5=Almost Certain
  Impact:     1=Insignificant 2=Minor 3=Moderate 4=Major 5=Extreme

Respond with a valid JSON object only. No markdown. No code fences.

{{
  "control_id": "{control['control_id']}",
  "section": "{control['section']}",
  "requirement_summary": "<one sentence: what this control requires>",
  "vendor_response_summary": "<one sentence: what the vendor claims>",
  "vendor_evidence_corroborated": <true|false>,
  "hecvat_compliance": "<COMPLIANT | PARTIAL | GAP>",
  "policy_alignment": "<COMPLIANT | PARTIAL | GAP | NOT_ASSESSED>",
  "overall_status": "<COMPLIANT | PARTIAL | GAP | INSUFFICIENT_EVIDENCE>",
  "likelihood": <1-5>,
  "impact": <1-5>,
  "gap_description": "<describe gap, or null if compliant>",
  "recommendation": "<actionable recommendation, or null if compliant>",
  "policy_clause_referenced": "<exact clause from Context A used, or null>",
  "evidence_quality": "<STRONG | WEAK | NONE>",
  "context_sources": ["<source doc names from Context A>"]
}}

RULES:
- overall_status = worst of hecvat_compliance and policy_alignment (INSUFFICIENT_EVIDENCE if policy_alignment=NOT_ASSESSED and hecvat_compliance=COMPLIANT, keep COMPLIANT)
- Do NOT reference external frameworks not in Context A
- Do NOT invent policy clauses — policy_clause_referenced must be verbatim from Context A or null
- If overall_status is COMPLIANT, gap_description and recommendation are null"""


# ── LLM call ─────────────────────────────────────────────────────────────────

def call_llm(prompt: str) -> str:
    url = "http://localhost:8000/v1/chat/completions"
    payload = {
        "model": config.LLM_MODEL,
        "messages": [
            {"role": "system", "content": config.SYSTEM_PROMPT},
            {"role": "user",   "content": prompt},
        ],
        "temperature": 0.0,
    }
    
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    
    try:
        with urllib.request.urlopen(req) as response:
            res_body = response.read().decode("utf-8")
            res_data = json.loads(res_body)
            if "choices" in res_data and len(res_data["choices"]) > 0:
                message = res_data["choices"][0].get("message", {})
                content = message.get("content")
                if content is not None:
                    return content.strip()
            raise ValueError(f"Unexpected response format from LLM server: {res_body}")
    except Exception as e:
        raise RuntimeError(f"Error during LLM call: {e}")


def _extract_first_json_object(text: str) -> str | None:
    """
    Bracket-balanced extraction of the first complete JSON object from text.
    Unlike a greedy `\\{.*\\}` regex, this stops at the matching closing brace,
    so trailing commentary containing braces doesn't corrupt the match.
    """
    start = text.find("{")
    if start == -1:
        return None
    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if escape:
            escape = False
            continue
        if ch == "\\":
            if in_string:
                escape = True
            continue
        if ch == '"' and not escape:
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return None


def parse_llm_response(raw: str, control: dict) -> dict:
    raw = re.sub(r"```json|```", "", raw).strip()
    json_str = _extract_first_json_object(raw)
    if json_str:
        try:
            parsed = json.loads(json_str)
            parsed.setdefault("vendor_evidence_corroborated", False)
            parsed.setdefault("hecvat_compliance", "INSUFFICIENT_EVIDENCE")
            parsed.setdefault("policy_alignment",  "NOT_ASSESSED")
            parsed.setdefault("overall_status",    parsed.get("hecvat_compliance", "INSUFFICIENT_EVIDENCE"))
            parsed.setdefault("likelihood", 3)
            parsed.setdefault("impact",     3)
            parsed.setdefault("policy_clause_referenced", None)
            return parsed
        except json.JSONDecodeError:
            pass
    return _fallback_finding(control, reason="LLM response could not be parsed.")

def verify_policy_clause(finding: dict, policy_chunks: list) -> dict:
    """
    Check if policy_clause_referenced actually exists in retrieved chunks.
    If not found via fuzzy match — set to null and flag as unverified.
    """
    clause = finding.get("policy_clause_referenced")
    if not clause or clause == "null":
        return finding

    # Build full text of all retrieved policy chunks
    all_policy_text = " ".join(c["text"] for c in policy_chunks).lower()
    
    # Take first 60 chars of clause as search key — enough to verify
    search_key = clause.strip().lower()[:60]
    
    # Remove common LLM preamble like "Policy 1:" or "§" before checking
    import re
    search_key = re.sub(r'^(policy\s*\d+\s*:|§[\d.]+\s*)', '', search_key).strip()
    
    # Normalize text (strip punctuation, lower case) for both search_key and all_policy_text
    all_policy_text = re.sub(r'[^\w\s]', '', all_policy_text.lower())
    search_key = re.sub(r'[^\w\s]', '', search_key.lower())

    # Fuzzy: check if at least 80% of 6-word windows from clause appear in chunks
    words = search_key.split()
    if len(words) < 4:
        return finding  # too short to verify meaningfully
    
    windows = [" ".join(words[i:i+4]) for i in range(len(words)-3)]
    matches = sum(1 for w in windows if w in all_policy_text)
    match_ratio = matches / len(windows) if windows else 0
    
    if match_ratio < 0.4:
        finding["policy_clause_referenced"] = None
        finding["clause_verification"] = "FAILED — not found in retrieved chunks"
    else:
        finding["clause_verification"] = "PASSED"
    
    return finding


def _fallback_finding(control: dict, reason: str = "") -> dict:
    return {
        "control_id":                   control["control_id"],
        "section":                      control["section"],
        "requirement_summary":          control["question"][:120],
        "vendor_response_summary":      control["response"][:120],
        "vendor_evidence_corroborated": False,
        "hecvat_compliance":            "INSUFFICIENT_EVIDENCE",
        "policy_alignment":             "NOT_ASSESSED",
        "overall_status":               "INSUFFICIENT_EVIDENCE",
        "likelihood":                   0,
        "impact":                       0,
        "gap_description":              reason or "No relevant policy found.",
        "recommendation":               "Add relevant policy document and re-assess.",
        "policy_clause_referenced":     None,
        "evidence_quality":             "NONE",
        "context_sources":              [],
    }


# ── RMF risk scoring ──────────────────────────────────────────────────────────

def compute_rmf_risk(finding: dict) -> dict:
    """
    Maps likelihood × impact to Murdoch RMF level.
    Only called for assessed controls (not INSUFFICIENT_EVIDENCE).
    Returns {rmf_level, rmf_score, likelihood, impact}
    """
    likelihood = int(finding.get("likelihood", 0))
    impact     = int(finding.get("impact",     0))

    if likelihood == 0 or impact == 0:
        return {"rmf_level": "NOT_SCORED", "rmf_score": 0,
                "likelihood": likelihood, "impact": impact}

    l = max(1, min(5, likelihood))
    i = max(1, min(5, impact))
    rmf_level = config.RMF_MATRIX.get((l, i), "MEDIUM")
    rmf_score = config.RMF_LEVEL_SCORE.get(rmf_level, 0)

    # Critical flag bumps likelihood by 1 (capped at 5)
    if finding.get("is_critical") and l < 5:
        l = l + 1
        rmf_level = config.RMF_MATRIX.get((l, i), rmf_level)
        rmf_score = config.RMF_LEVEL_SCORE.get(rmf_level, rmf_score)

    return {"rmf_level": rmf_level, "rmf_score": rmf_score,
            "likelihood": l, "impact": i}


# ── Main assessment loop ──────────────────────────────────────────────────────

def run_assessment(excel_path: str, service_name: str = "IT Service") -> list:
    print(f"\nStarting risk assessment for: {service_name}")
    print(f"HECVAT file: {excel_path}")

    controls = parse_uploaded_hecvat(excel_path)
    print(f"Controls found: {len(controls)}")

    findings = []

    for i, control in enumerate(controls, 1):
        print(f"\n  [{i}/{len(controls)}] {control['control_id']} — {control['question'][:60]}...")

        # Query uses original question + original response
        query  = f"{control['question']} {control['response']}"
        result = rag.retrieve(query)

        if not rag.has_sufficient_context(result):
            print(f"    Low similarity ({result['best_policy_similarity']:.2f}) → INSUFFICIENT_EVIDENCE")
            finding = _fallback_finding(control)
        else:
            context_block = rag.build_context_block(result)
            prompt  = build_prompt(control, context_block)
            raw_out = call_llm(prompt)
            finding = parse_llm_response(raw_out, control)
            finding = verify_policy_clause(finding, result["policy_chunks"])
            print(f"    HECVAT: {finding.get('hecvat_compliance')} | "
                  f"Policy: {finding.get('policy_alignment')} | "
                  f"Overall: {finding.get('overall_status')}")

        # Attach control metadata
        finding["is_critical"]       = control.get("is_critical", False)
        finding["weight"]            = control.get("weight", 10)
        finding["policy_similarity"] = result["best_policy_similarity"]
        finding["sheet"]             = control.get("sheet", "")
        # Preserve original text for re-assessment (fix issue #7)
        finding["_original_question"] = control["question"]
        finding["_original_response"] = control["response"]
        finding["_compliant_response"]= control.get("compliant_response", "")

        # RMF scoring — only for assessed controls
        rmf = compute_rmf_risk(finding)
        finding.update(rmf)

        findings.append(finding)

    print(f"\nAssessment complete. {len(findings)} controls assessed.")
    return findings


# ── Summary ───────────────────────────────────────────────────────────────────

def summarize_findings(findings: list) -> dict:
    statuses = Counter(f["overall_status"] for f in findings)
    gaps     = [f for f in findings if f["overall_status"] == "GAP"]
    partial  = [f for f in findings if f["overall_status"] == "PARTIAL"]

    # INSUFFICIENT_EVIDENCE excluded from risk score — it is a coverage metric
    assessed = [f for f in findings if f["overall_status"] != "INSUFFICIENT_EVIDENCE"]

    rmf_counts = Counter(f.get("rmf_level", "NOT_SCORED") for f in assessed)

    # Overall RMF band based on assessed controls only.
    # Banding is centralized in config.rmf_band_from_score so CLI/PDF/Excel agree.
    if assessed:
        avg_rmf = sum(f.get("rmf_score", 0) for f in assessed) / len(assessed)
        overall_band = config.rmf_band_from_score(avg_rmf)
        overall_rmf_score = round(avg_rmf, 2)
    else:
        overall_band      = "NOT_ASSESSED"
        overall_rmf_score = 0.0

    # Policy alignment breakdown
    policy_breakdown = Counter(f.get("policy_alignment", "NOT_ASSESSED") for f in findings)

    # Section-level breakdown
    section_rmf = defaultdict(list)
    for f in assessed:
        section_rmf[f.get("section", "Unknown")].append(f.get("rmf_score", 0))
    section_summary = {
        sec: round(sum(scores)/len(scores), 2)
        for sec, scores in section_rmf.items()
    }

    return {
        "total_controls":          len(findings),
        "assessed_controls":       len(assessed),
        "insufficient_evidence":   statuses.get("INSUFFICIENT_EVIDENCE", 0),
        "coverage_pct":            round(len(assessed)/len(findings)*100, 1) if findings else 0,
        "status_breakdown":        dict(statuses),
        "policy_alignment_breakdown": dict(policy_breakdown),
        "rmf_breakdown":           dict(rmf_counts),
        "total_gaps":              len(gaps),
        "total_partial":           len(partial),
        "overall_rmf_score":       overall_rmf_score,   # avg RMF score (assessed only)
        "overall_risk_band":       overall_band,
        "section_rmf_scores":      section_summary,
        "extreme_risks":           [f for f in gaps if f.get("rmf_level") == "EXTREME"],
        "high_risks":              [f for f in gaps if f.get("rmf_level") == "HIGH"],
        "critical_gaps":           [f for f in gaps if f.get("rmf_level") in ("EXTREME","HIGH")],
        "high_gaps":               [f for f in gaps if f.get("rmf_level") == "HIGH"],
    }
