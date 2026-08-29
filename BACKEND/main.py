import sys
import json
import os
import argparse

import config
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


# runs the whole assess -> report -> follow-up pipeline for one vendor HECVAT
def cmd_assess(args):
    path         = args.file
    service_name = args.service or "Unknown IT Service"
    output_dir   = args.output  or config.REPORTS_DIR

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
    print(f"  High risks         : {len(summary['high_risks'])}")
    print(f"  Not scored (no L/I): {summary.get('not_scored', 0)}")
    print(f"  ── Overall Risk Score : {summary['overall_rmf_score']} / 5 "
          f"({summary.get('scored_controls', 0)} scored controls"
          f"{', weighted' if summary.get('weighted_aggregation') else ''})")
    print(f"  ── Overall Risk Band  : {summary['overall_risk_band']}")
    print("="*60)

    os.makedirs(output_dir, exist_ok=True)
    json_path = os.path.join(output_dir, "findings_raw.json")
    with open(json_path, "w") as f:
        json.dump({"summary": summary, "findings": findings}, f, indent=2)
    print(f"\n  📁 Raw findings: {json_path}")

    pdf_path, pptx_path, csv_path = report.generate_all(findings, summary, service_name, output_dir)
    print(f"\n✅ Done.")
    print(f"   PDF    → {pdf_path}")
    print(f"   PPTX   → {pptx_path}")
    print(f"   CSV    → {csv_path}")
    print(f"   JSON   → {json_path}")

    # so gaps and partials don't just sit in the report — get them queued for follow-up right away
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
    parser = argparse.ArgumentParser(description="Sedona — IT Risk Assessment Tool (Local LLM)")
    sub    = parser.add_subparsers(dest="command")

    p_ingest = sub.add_parser("ingest", help="Ingest documents into knowledge base")
    p_ingest.add_argument("type", choices=["policy", "soc2", "vendor", "hecvat"])
    p_ingest.add_argument("file", help="Path to file")

    p_assess = sub.add_parser("assess", help="Run risk assessment on vendor HECVAT")
    p_assess.add_argument("file",      help="Path to vendor's filled HECVAT Excel")
    p_assess.add_argument("--service", default=None)
    p_assess.add_argument("--output",  default=None)

    sub.add_parser("stats", help="Show knowledge base stats")

    p_followup = sub.add_parser("followup", help="Answer follow-up questions and re-assess")
    p_followup.add_argument("--resolve", action="store_true",
                            help="Re-assess all answered controls and regenerate report")

    args = parser.parse_args()

    # only pay the gpu startup cost for commands that actually touch the llm/embedding models
    if args.command in ("ingest", "assess", "followup"):
        try:
            gpu_engine.ensure_started()
        except Exception as e:
            print(f"❌ GPU engine failed to start: {e}")
            sys.exit(1)

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
