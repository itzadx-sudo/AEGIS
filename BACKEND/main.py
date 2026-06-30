"""
main.py — Aegis Risk Assessment CLI

Step 1: Build knowledge base (run once, re-run when docs change)
  python main.py ingest policy  path/to/your_policy.pdf
  python main.py ingest hecvat  path/to/hecvat_template.xlsx
  python main.py ingest soc2    path/to/vendor_soc2.pdf
  python main.py ingest vendor  path/to/vendor_other_doc.pdf

Step 2: Run assessment on vendor's submitted HECVAT
  python main.py assess path/to/vendor_filled_hecvat.xlsx --service "ServiceName"

Check knowledge base:
  python main.py stats
"""

import sys
import json
import os
import argparse

import ingest
import assess
import report
import followup
import gpu_engine


def cmd_ingest(args):
    doc_type = args.type.lower()
    path     = args.file

    if not os.path.exists(path):
        print(f"❌ File not found: {path}")
        sys.exit(1)

    if doc_type == "policy":
        ingest.ingest_policy_pdf(path)
    elif doc_type == "soc2":
        ingest.ingest_soc2_pdf(path)
    elif doc_type == "vendor":
        ingest.ingest_vendor_doc_pdf(path)
    elif doc_type == "hecvat":
        ingest.ingest_hecvat_template(path)
    else:
        print(f"❌ Unknown type: {doc_type}. Use: policy | soc2 | vendor | hecvat")
        sys.exit(1)


def cmd_assess(args):
    path         = args.file
    service_name = args.service or "Unknown IT Service"
    output_dir   = args.output  or "./reports"

    if not os.path.exists(path):
        print(f"❌ File not found: {path}")
        sys.exit(1)

    findings = assess.run_assessment(path, service_name)
    summary  = assess.summarize_findings(findings)

    print("\n" + "="*60)
    print("RISK ASSESSMENT SUMMARY")
    print("="*60)
    print(f"  Service            : {service_name}")
    print(f"  Total controls     : {summary['total_controls']}")
    print(f"  Compliant          : {summary['status_breakdown'].get('COMPLIANT', 0)}")
    print(f"  Partial            : {summary['total_partial']}")
    print(f"  Gaps               : {summary['total_gaps']}")
    print(f"  Insufficient Evid. : {summary['status_breakdown'].get('INSUFFICIENT_EVIDENCE', 0)}")
    print(f"  Critical risks     : {len(summary['critical_gaps'])}")
    print(f"  High risks         : {len(summary['high_gaps'])}")
    print(f"  ── Overall Risk Score : {summary['overall_rmf_score']} / 100")
    print(f"  ── Overall Risk Band  : {summary['overall_risk_band']}")
    print("="*60)

    os.makedirs(output_dir, exist_ok=True)
    json_path = os.path.join(output_dir, "findings_raw.json")
    with open(json_path, "w") as f:
        json.dump({"summary": summary, "findings": findings}, f, indent=2)
    print(f"\n  📁 Raw findings: {json_path}")

    pdf_path, excel_path = report.generate_all(findings, summary, service_name, output_dir)
    print(f"\n✅ Done.")
    print(f"   PDF    → {pdf_path}")
    print(f"   Excel  → {excel_path}")
    print(f"   JSON   → {json_path}")

    # Build follow-up session for GAP + PARTIAL findings
    followup.build_session(findings, summary, service_name)


def cmd_followup(args):
    if getattr(args, "resolve", False):
        session = followup.load_session()
        if session:
            followup._resolve(session, session.get("followup_answers", {}).keys())
    else:
        followup.run_followup()


def cmd_stats(args):
    ingest.show_stats()


def main():
    parser = argparse.ArgumentParser(description="Aegis — IT Risk Assessment Tool (Local LLM)")
    sub    = parser.add_subparsers(dest="command")

    p_ingest = sub.add_parser("ingest", help="Ingest documents into knowledge base")
    p_ingest.add_argument("type", choices=["policy", "soc2", "vendor", "hecvat"])
    p_ingest.add_argument("file", help="Path to file")

    p_assess = sub.add_parser("assess", help="Run risk assessment on vendor HECVAT")
    p_assess.add_argument("file",      help="Path to vendor's filled HECVAT Excel")
    p_assess.add_argument("--service", default="IT Service")
    p_assess.add_argument("--output",  default="./reports")

    sub.add_parser("stats", help="Show knowledge base stats")

    p_followup = sub.add_parser("followup", help="Answer follow-up questions and re-assess")
    p_followup.add_argument("--resolve", action="store_true",
                            help="Re-assess all answered controls and regenerate report")

    args = parser.parse_args()

    # Commands that touch the LLM / embedding models need the GPU engines.
    # ensure_started() launches run_gpu.sh and registers teardown on exit.
    if args.command in ("ingest", "assess", "followup"):
        gpu_engine.ensure_started()

    if args.command == "ingest":
        cmd_ingest(args)
    elif args.command == "assess":
        cmd_assess(args)
    elif args.command == "stats":
        cmd_stats(args)
    elif args.command == "followup":
        cmd_followup(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
