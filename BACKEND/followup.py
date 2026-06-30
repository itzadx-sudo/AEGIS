"""
followup.py
Stateful follow-up question loop for GAP and PARTIAL findings.

Session file: reports/session.json
  - findings: all findings from initial run
  - summary: initial summary
  - service_name: str
  - followup_questions: {control_id: question_text}
  - followup_answers:   {control_id: answer_text}
  - resolved_findings:  {control_id: updated_finding}
"""

import json
import os
import urllib.request
import config
import rag
from assess import build_prompt, call_llm, parse_llm_response, compute_rmf_risk, summarize_findings


SESSION_FILE = "reports/session.json"


# ── Question generation ───────────────────────────────────────────────────────

def generate_followup_question(finding: dict) -> str:
    """Ask LLM to generate one targeted follow-up question for a GAP/PARTIAL."""
    prompt = f"""A vendor risk assessment found the following issue:

Control  : {finding['control_id']} — {finding.get('requirement_summary', '')}
Status   : {finding['overall_status']}
Gap      : {finding.get('gap_description', '')}
Vendor said: {finding.get('vendor_response_summary', '')}

Write ONE short, specific follow-up question to ask the vendor or assessor
that would provide the missing information needed to resolve this finding.
The question must be answerable in 1-3 sentences.
Reply with only the question. No preamble."""

    url = "http://localhost:8000/v1/chat/completions"
    payload = {
        "model": config.LLM_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.2,
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
    except Exception:
        return f"Can you provide additional evidence or documentation for: {finding.get('requirement_summary', finding['control_id'])}?"


# ── Session management ────────────────────────────────────────────────────────

def save_session(session: dict):
    os.makedirs("reports", exist_ok=True)
    with open(SESSION_FILE, "w") as f:
        json.dump(session, f, indent=2)


def load_session() -> dict:
    if not os.path.exists(SESSION_FILE):
        print("❌ No session found. Run assessment first: python main.py assess ...")
        return None
    with open(SESSION_FILE) as f:
        return json.load(f)


# ── Build session after initial assessment ────────────────────────────────────

def build_session(findings: list, summary: dict, service_name: str):
    """
    Called at end of assess run. Generates follow-up questions for
    GAP and PARTIAL findings and saves session file.
    """
    needs_followup = [
        f for f in findings
        if f.get("overall_status") in ("GAP", "PARTIAL")
    ]

    if not needs_followup:
        print("\n✅ No GAPs or PARTIALs — no follow-up questions needed.")
        return

    print(f"\n⚙️  Generating follow-up questions for {len(needs_followup)} findings...")
    questions = {}
    for f in needs_followup:
        cid = f["control_id"]
        print(f"  [{cid}] generating question...")
        questions[cid] = generate_followup_question(f)

    session = {
        "service_name":       service_name,
        "findings":           findings,
        "summary":            summary,
        "followup_questions": questions,
        "followup_answers":   {},
        "resolved_findings":  {},
    }
    save_session(session)
    print(f"\n📁 Session saved: {SESSION_FILE}")
    print(f"   Run follow-up: python main.py followup")


# ── Interactive follow-up loop ────────────────────────────────────────────────

def run_followup():
    session = load_session()
    if not session:
        return

    questions        = session["followup_questions"]
    existing_answers = session.get("followup_answers", {})
    findings_map     = {f["control_id"]: f for f in session["findings"]}

    unanswered = {
        cid: q for cid, q in questions.items()
        if cid not in existing_answers
    }

    if not unanswered:
        print("✅ All follow-up questions already answered.")
        print("   Run: python main.py followup --resolve  to re-assess and update report")
        return

    print(f"\n{'='*60}")
    print(f"FOLLOW-UP QUESTIONS — {session['service_name']}")
    print(f"{'='*60}")
    print(f"  {len(unanswered)} questions remaining. Type answer and press Enter.")
    print(f"  Type 'skip' to skip a question. Type 'done' to stop and resolve now.\n")

    answered_now = {}
    for i, (cid, question) in enumerate(unanswered.items(), 1):
        finding = findings_map.get(cid, {})
        print(f"[{i}/{len(unanswered)}] {cid} — {finding.get('overall_status','')} | Risk: {finding.get('rmf_level','')}")
        print(f"  Context : {finding.get('requirement_summary','')[:100]}")
        print(f"  Gap     : {finding.get('gap_description','')[:120]}")
        print(f"  ❓ {question}")
        answer = input("  Your answer: ").strip()

        if answer.lower() == "done":
            break
        if answer.lower() == "skip" or not answer:
            print("  ⏭  Skipped.\n")
            continue

        answered_now[cid] = answer
        print("  ✅ Recorded.\n")

    if not answered_now:
        print("No answers recorded.")
        return

    # Merge answers into session
    session["followup_answers"].update(answered_now)
    save_session(session)
    print(f"\n💾 {len(answered_now)} answers saved.")
    print("   Now re-assessing affected controls...")

    _resolve(session, answered_now.keys())


def _resolve(session: dict, control_ids=None):
    """Re-assess controls that now have follow-up answers."""
    findings_map      = {f["control_id"]: f for f in session["findings"]}
    resolved_map      = session.get("resolved_findings", {})
    followup_answers  = session.get("followup_answers", {})
    followup_questions= session.get("followup_questions", {})

    to_resolve = control_ids or followup_answers.keys()
    updated = 0

    for cid in to_resolve:
        if cid not in followup_answers:
            continue

        original = findings_map.get(cid)
        if not original:
            continue

        question_text = followup_questions.get(cid, "")
        answer_text   = followup_answers[cid]

        print(f"\n  Re-assessing {cid}...")

        # Build enriched control context with follow-up answer baked in
        enriched_control = {
            "control_id": cid,
            "section":    original.get("section", ""),
            "sheet":      original.get("sheet", ""),
            "question":   original.get("_original_question", ""),
            "response":   original.get("_original_response", ""),
            "compliant_response": original.get("_compliant_response", ""),
            "evidence":   (
                f"[ORIGINAL EVIDENCE]\n{original.get('_original_response','')}\n\n"
                f"[FOLLOW-UP QUESTION]\n{question_text}\n\n"
                f"[FOLLOW-UP ANSWER]\n{answer_text}"
            ),
            "guidance":   "",
        }

        query  = f"{enriched_control['question']} {enriched_control['response']} {answer_text}"
        result = rag.retrieve(query)
        context_block = rag.build_context_block(result)
        prompt  = build_prompt(enriched_control, context_block)
        raw_out = call_llm(prompt)
        finding = parse_llm_response(raw_out, enriched_control)

        finding["is_critical"]       = original.get("is_critical", False)
        finding["weight"]            = original.get("weight", 10)
        finding["sheet"]             = original.get("sheet", "")
        finding["_original_question"] = original.get("_original_question", "")
        finding["_original_response"] = original.get("_original_response", "")
        finding["_compliant_response"]= original.get("_compliant_response", "")

        finding.update(compute_rmf_risk(finding))
        finding["policy_similarity"] = result["best_policy_similarity"]
        finding["followup_applied"]  = True

        resolved_map[cid] = finding
        updated += 1
        print(f"    {original['overall_status']} → {finding['overall_status']} | {original.get('rmf_level','?')} → {finding.get('rmf_level','?')}")

    session["resolved_findings"] = resolved_map
    save_session(session)

    # Merge resolved findings back into full findings list
    final_findings = []
    for f in session["findings"]:
        cid = f["control_id"]
        final_findings.append(resolved_map.get(cid, f))

    final_summary = summarize_findings(final_findings)

    # Regenerate report
    import report
    service_name = session.get("service_name", "IT Service")
    pdf_path, excel_path = report.generate_all(
        final_findings, final_summary, service_name + " (Post Follow-Up)", "./reports"
    )

    print(f"\n{'='*60}")
    print("UPDATED RISK SUMMARY (Post Follow-Up)")
    print(f"{'='*60}")
    orig_summary = session.get("summary", {})
    print(f"  Gaps     : {orig_summary.get('total_gaps','?')} → {final_summary['total_gaps']}")
    print(f"  Partial  : {orig_summary.get('total_partial','?')} → {final_summary['total_partial']}")
    print(f"  Score    : {orig_summary.get('overall_rmf_score','?')} → {final_summary['overall_rmf_score']} / 100")
    print(f"  Band     : {orig_summary.get('overall_risk_band','?')} → {final_summary['overall_risk_band']}")
    print(f"\n✅ Updated report: {pdf_path}")
    print(f"   Updated Excel : {excel_path}")

    session["final_summary"] = final_summary
    save_session(session)
