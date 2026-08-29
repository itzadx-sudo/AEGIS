#!/usr/bin/env python3
# one-time repair tool for sessions that finished before the completion-persistence fix existed, so they never got a "complete" marker or report paths written back
# matching is best-effort by vendor name + closest timestamp, since old report filenames don't carry the session id — dry run by default, pass --apply to actually write
import os
import re
import sys
import json
import glob
import shutil
import argparse
from datetime import datetime

# NOTE: this script was written for a now-obsolete filename scheme (risk_register_*.xlsx).
# Reports are now risk_briefing_*.pptx (with an optional session-id segment).
# The regexes and key names below have been updated accordingly.
PDF_RE  = re.compile(r"^risk_assessment_(?P<name>.+?)(?:_[0-9a-f]{32})?_(?P<ts>\d{8}_\d{4})\.pdf$")
PPTX_RE = re.compile(r"^risk_briefing_(?P<name>.+?)(?:_[0-9a-f]{32})?_(?P<ts>\d{8}_\d{4})\.pptx$")


def _safe(service_name: str) -> str:
    # has to mirror report.generate_all's sanitisation exactly, or the vendor-name matching below silently fails
    return (service_name.replace("/", "_").replace("\\", "_")
            .replace(" ", "_").lower()[:40])


def _parse_ts(ts: str) -> datetime:
    return datetime.strptime(ts, "%Y%m%d_%H%M")


def _report_pairs(reports_dir: str):
    pdfs, pptxs = {}, {}
    for fn in os.listdir(reports_dir):
        m = PDF_RE.match(fn)
        if m:
            pdfs[(m["name"], m["ts"])] = fn
        m = PPTX_RE.match(fn)
        if m:
            pptxs[(m["name"], m["ts"])] = fn
    pairs = {}
    for (name, ts), pdf in pdfs.items():
        pptx = pptxs.get((name, ts))
        if not pptx:
            continue  # a genuinely completed run always produced both files, so a lone pdf means a half-finished run
        pairs.setdefault(name, []).append({
            "ts": _parse_ts(ts), "ts_raw": ts, "pdf": pdf, "pptx": pptx,
        })
    return pairs


def _sessions(reports_dir: str):
    out = []
    for path in sorted(glob.glob(os.path.join(reports_dir, "session_*.json"))):
        try:
            with open(path) as f:
                data = json.load(f)
        except Exception as e:
            print(f"  ! skip unreadable {os.path.basename(path)}: {e}")
            continue
        out.append({
            "path": path,
            "sid": os.path.basename(path)[len("session_"):-len(".json")],
            "service_name": data.get("service_name", "Unknown Vendor"),
            "safe": _safe(data.get("service_name", "Unknown Vendor")),
            "mtime": datetime.fromtimestamp(os.path.getmtime(path)),
            "has_findings": bool(data.get("findings")),
            "status": data.get("status"),
            "data": data,
        })
    return out


def main():
    ap = argparse.ArgumentParser()
    # read the location from config rather than assuming ./reports next to this file — the store moved to
    # the project root so the API and CLI stop keeping two separate copies
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "BACKEND"))
    import config
    ap.add_argument("--reports", default=config.REPORTS_DIR, help=f"reports dir (default: {config.REPORTS_DIR})")
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry run)")
    args = ap.parse_args()

    reports_dir = os.path.abspath(args.reports)
    if not os.path.isdir(reports_dir):
        print(f"reports dir not found: {reports_dir}")
        sys.exit(1)

    pairs = _report_pairs(reports_dir)
    sessions = _sessions(reports_dir)

    # greedy-assign each session to its closest-in-time same-vendor report run, so nothing gets claimed twice
    candidates = []
    for s in sessions:
        if s["status"] == "complete":
            continue
        if not s["has_findings"]:
            continue
        for run in pairs.get(s["safe"], []):
            dist = abs((s["mtime"] - run["ts"]).total_seconds())
            candidates.append((dist, s, run))
    candidates.sort(key=lambda c: c[0])

    used_sessions, used_runs, plan = set(), set(), []
    for dist, s, run in candidates:
        run_key = (s["safe"], run["ts_raw"])
        if s["sid"] in used_sessions or run_key in used_runs:
            continue
        used_sessions.add(s["sid"])
        used_runs.add(run_key)
        plan.append((s, run, dist))

    print(f"\nreports dir : {reports_dir}")
    print(f"sessions    : {len(sessions)}   report runs (pdf+pptx): {sum(len(v) for v in pairs.values())}")
    print(f"mode        : {'APPLY' if args.apply else 'DRY RUN (use --apply to write)'}\n")

    if not plan:
        print("Nothing to backfill — no unclaimed same-vendor report matched an incomplete session.")
    else:
        print("Will mark COMPLETE and attach reports:")
        print(f"  {'session':10} {'vendor':22} {'report run':14} {'Δ mtime':>10}")
        for s, run, dist in sorted(plan, key=lambda p: p[0]["service_name"].lower()):
            dm = f"{dist/60:.0f}m" if dist < 36000 else f"{dist/86400:.1f}d"
            print(f"  {s['sid'][:8]:10} {s['service_name'][:22]:22} {run['ts_raw']:14} {dm:>10}")

    matched = {s["sid"] for s, _, _ in plan}
    skipped = [s for s in sessions
               if s["status"] != "complete" and s["has_findings"] and s["sid"] not in matched]
    if skipped:
        print("\nNo report available (left unchanged):")
        for s in sorted(skipped, key=lambda x: x["service_name"].lower()):
            print(f"  {s['sid'][:8]:10} {s['service_name'][:22]:22} (no unclaimed '{s['safe']}' report)")

    if not args.apply:
        print("\nDry run only — re-run with --apply to write these changes.")
        return

    written = 0
    for s, run, _ in plan:
        bak = s["path"] + ".bak"
        if not os.path.exists(bak):
            shutil.copy2(s["path"], bak)  # only back up once, so re-running --apply doesn't overwrite an already-good backup
        data = s["data"]
        data["status"] = "complete"
        data["report_pdf"]  = run["pdf"]
        data["report_pptx"] = run["pptx"]
        with open(s["path"], "w") as f:
            json.dump(data, f, indent=2)
        written += 1
    print(f"\nApplied: {written} session file(s) updated (backups: <file>.bak).")
    print("Restart the API and the startup log should show 'status=complete' for these.")


if __name__ == "__main__":
    main()
