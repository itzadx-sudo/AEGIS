# drives the interactive follow-up loop for GAP/PARTIAL findings, backed by a persisted session file
import json
import os
import sys
import urllib.request
from datetime import datetime
import config
import rag
from assess import (build_prompt, call_llm, parse_llm_response, compute_rmf_risk,
                    summarize_findings, verify_policy_clause, enforce_evidence_claims,
                    normalize_finding, _chunk_references)


SESSION_FILE = os.path.join(config.REPORTS_DIR, "session.json")


def generate_followup_question(finding: dict) -> str:
    prompt = f"""A vendor risk assessment found the following issue:

Control  : {finding['control_id']} — {finding.get('requirement_summary', '')}
Status   : {finding['overall_status']}
Gap      : {finding.get('gap_description', '')}
Vendor said: {finding.get('vendor_response_summary', '')}
Policy clause: {finding.get('policy_clause_referenced') or 'No verified clause available'}
Evidence state: {finding.get('vendor_evidence_state') or 'insufficient evidence'}
Consistency: {finding.get('consistency_status') or 'not recorded'}

Write ONE short, specific follow-up question to ask the vendor or assessor
that would provide the missing information or documentary evidence needed to
resolve this finding. Do not ask for evidence that is already cited above.

IMPORTANT RULES:
- The question must be answerable in 1-3 typed sentences.
- Do NOT ask the vendor to upload, attach, or provide any files or documents.
- Do NOT ask for screenshots, certificates, reports, or any file attachments.
- Ask only for information that can be described or confirmed in plain text.
- For example, instead of "Please provide your encryption policy document", ask
  "Can you describe the encryption standards and algorithms used to protect data at rest?"

Reply with only the question. No preamble."""

    url = config.LLM_SERVER_URL
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
        with urllib.request.urlopen(req, timeout=120) as response:
            res_body = response.read().decode("utf-8")
            res_data = json.loads(res_body)
            if "choices" in res_data and len(res_data["choices"]) > 0:
                message = res_data["choices"][0].get("message", {})
                content = message.get("content")
                if content is not None:
                    return content.strip()
            raise ValueError(f"Unexpected response format from LLM server: {res_body}")
    except Exception as e:
        # log the failure so a persistent LLM outage isn't invisible (M12)
        print(f"  [followup] LLM call failed for {finding.get('control_id', '?')}: {e}", file=sys.stderr)
        # LLM server down or malformed reply — fall back to a generic question rather than blocking the whole run
        return f"Can you describe in more detail how your organisation addresses the following requirement: {finding.get('requirement_summary', finding['control_id'])}?"


def save_session(session: dict, path: str = None):
    target = path or session.get("_session_path") or SESSION_FILE
    # old session files carry a cwd-relative _session_path; anchor it to REPORTS_DIR
    if not os.path.isabs(target):
        target = os.path.join(config.REPORTS_DIR, os.path.basename(target))
    os.makedirs(os.path.dirname(os.path.abspath(target)), exist_ok=True)
    with open(target, "w") as f:
        json.dump(session, f, indent=2)


def load_session(path: str = None) -> dict:
    target = path or SESSION_FILE
    if not os.path.exists(target):
        print("❌ No session found. Run assessment first: python main.py assess ...")
        return None
    with open(target) as f:
        return json.load(f)


# split from the save so a caller holding a lock can generate the questions before taking it
def build_session_payload(findings: list, summary: dict, service_name: str, session_path: str = None) -> dict:
    target_path = session_path or SESSION_FILE

    # INSUFFICIENT_EVIDENCE needs a follow-up too — GAP/PARTIAL alone stranded 24 controls in one run
    needs_followup = [
        f for f in findings
        if (
            f.get("overall_status") in ("GAP", "PARTIAL", "INSUFFICIENT_EVIDENCE")
            or f.get("consistency_status") == "NO_CONSENSUS"
        )
    ]

    session = {
        "_session_path":      target_path,
        "service_name":       service_name,
        "findings":           findings,
        "summary":            summary,
        "followup_questions": {},
        "followup_answers":   {},
        "followup_skips":     {},
        "followup_history":   [],
        "resolved_findings":  {},
    }

    if not needs_followup:
        print("\n✅ No GAPs or PARTIALs — no follow-up questions needed.")
        return session

    print(f"\n⚙️  Generating follow-up questions for {len(needs_followup)} findings...")
    questions = {}
    for f in needs_followup:
        cid = f["control_id"]
        print(f"  [{cid}] generating question...")
        questions[cid] = generate_followup_question(f)

    session["followup_questions"] = questions
    return session


def build_session(findings: list, summary: dict, service_name: str, session_path: str = None) -> str:
    target_path = session_path or SESSION_FILE
    session = build_session_payload(findings, summary, service_name, target_path)
    save_session(session, target_path)
    print(f"\n📁 Session saved: {target_path}")
    if session.get("followup_questions"):
        print(f"   Run follow-up: python main.py followup")
    return target_path


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

    session["followup_answers"].update(answered_now)
    save_session(session)
    print(f"\n💾 {len(answered_now)} answers saved.")
    print("   Now re-assessing affected controls...")

    _resolve(session, answered_now.keys())


def _resolve(session: dict, control_ids=None, generate_report: bool = True):
    # re-runs the RAG+LLM assessment per control, feeding back the original evidence plus the new Q&A
    findings_map      = {f["control_id"]: f for f in session["findings"]}
    resolved_map      = session.get("resolved_findings", {})
    followup_answers  = session.get("followup_answers", {})
    followup_questions= session.get("followup_questions", {})
    session_path      = session.get("_session_path")

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
        prior_exchanges = []
        for event in (session.get("followup_history") or [])[-30:]:
            if event.get("control_id") == cid or event.get("action") in (
                "answer_saved", "answer_edited", "question_skipped",
            ):
                prior_exchanges.append(
                    f"{event.get('timestamp', 'time unavailable')} | "
                    f"{event.get('control_id', 'unknown')} | "
                    f"{event.get('action', 'event')}: {event.get('value', '')}"
                )
        history_text = "\n".join(prior_exchanges[-20:]) or "No prior exchanges recorded."

        print(f"\n  Re-assessing {cid}...")

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
                f"[FOLLOW-UP ANSWER — UNVERIFIED CLAIM]\n{answer_text}\n\n"
                f"[RELEVANT PRIOR FOLLOW-UP HISTORY — UNVERIFIED CLAIMS]\n{history_text}"
            ),
            "guidance":   "",
        }

        query  = f"{enriched_control['question']} {enriched_control['response']} {answer_text}"
        result = rag.retrieve(
            query,
            session_id=session.get("session_id"),
            vendor_id=session.get("service_name"),
        )

        # same policy gate, clause check and trusted control id as the main path
        if not rag.has_sufficient_context(result):
            print(f"    Low similarity ({result['best_policy_similarity']:.2f}) -> keeping original finding")
            continue

        context_block = rag.build_context_block(result)
        prompt  = build_prompt(enriched_control, context_block)
        raw_out = call_llm(prompt)
        finding = parse_llm_response(raw_out, enriched_control)
        finding = verify_policy_clause(finding, result["policy_chunks"])
        finding = enforce_evidence_claims(finding, result["vendor_chunks"])
        # the model can echo or truncate these; the workbook is the authority
        finding["control_id"] = cid
        finding["section"]    = original.get("section", "")

        finding["is_critical"]        = original.get("is_critical", False)
        finding["weight"]             = original.get("weight", 10)
        finding["sheet"]              = original.get("sheet", "")
        for field in (
            "source_workbook", "source_worksheet", "source_row", "source_cell",
            "requirement_cell", "requirement", "vendor_response", "vendor_routed_na",
        ):
            finding[field] = original.get(field)
        finding["_original_question"] = original.get("_original_question", "")
        finding["_original_response"] = original.get("_original_response", "")
        finding["_compliant_response"]= original.get("_compliant_response", "")

        finding.update(compute_rmf_risk(finding))
        finding["evidence_references"] = _chunk_references(result)
        finding["vendor_soc2_evidence"] = [
            ref for ref in finding["evidence_references"]
            if ref.get("document_role") == "vendor_evidence"
        ]
        finding["assessment_status"] = finding.get("overall_status")
        finding["consistency_status"] = "NOT_RUN"
        finding["manual_review_status"] = (
            "REQUIRED" if finding.get("overall_status") == "INSUFFICIENT_EVIDENCE" else "NOT_REQUIRED"
        )
        finding["audit_metadata"] = {
            "schema_version": 2,
            "reassessed_after_followup": True,
        }
        finding["policy_similarity"] = result["best_policy_similarity"]
        finding["followup_applied"]  = True
        finding["decision_change"] = {
            "changed_at": datetime.now().astimezone().isoformat(),
            "before": {
                "overall_status": original.get("overall_status"),
                "initial_risk_rating": original.get("initial_risk_rating"),
                "residual_risk_rating": original.get("residual_risk_rating"),
            },
            "after": {
                "overall_status": finding.get("overall_status"),
                "initial_risk_rating": finding.get("initial_risk_rating"),
                "residual_risk_rating": finding.get("residual_risk_rating"),
            },
            "followup_control_id": cid,
            "documentary_evidence_rechecked": True,
        }

        resolved_map[cid] = normalize_finding(finding)
        updated += 1
        print(f"    {original['overall_status']} → {finding['overall_status']} | {original.get('rmf_level','?')} → {finding.get('rmf_level','?')}")

    session["resolved_findings"] = resolved_map
    save_session(session, session_path)

    final_findings = []
    for f in session["findings"]:
        cid = f["control_id"]
        final_findings.append(resolved_map.get(cid, f))

    final_summary = summarize_findings(final_findings)

    # H8: only generate the report when the caller asks for it; api.py passes False and generates it itself
    if generate_report:
        import report
        service_name = session.get("service_name", "IT Service")
        pdf_path, pptx_path, csv_path = report.generate_all(
            final_findings, final_summary, service_name + " (Post Follow-Up)", config.REPORTS_DIR
        )

        print(f"\n{'='*60}")
        print("UPDATED RISK SUMMARY (Post Follow-Up)")
        print(f"{'='*60}")
        orig_summary = session.get("summary", {})
        print(f"  Gaps     : {orig_summary.get('total_gaps','?')} → {final_summary['total_gaps']}")
        print(f"  Partial  : {orig_summary.get('total_partial','?')} → {final_summary['total_partial']}")
        print(f"  Score    : {orig_summary.get('overall_rmf_score','?')} → {final_summary['overall_rmf_score']} / 5")
        print(f"  Band     : {orig_summary.get('overall_risk_band','?')} → {final_summary['overall_risk_band']}")
        print(f"\n✅ Updated report: {pdf_path}")
        print(f"   Updated PPTX  : {pptx_path}")

    session["final_summary"] = final_summary
    save_session(session, session_path)
