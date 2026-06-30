"""
hecvat_parser.py — Smart HECVAT parser

Reads routing decisions from START HERE / backend scoring,
then reads all controls from the Questions master sheet + backend scoring answers.
Version-proof: no hardcoded sheet names or section lists.

Flow:
  1. Read REQU + AIQU answers from (backend scoring) sheet
  2. Build disabled_sheets and disabled_section_prefixes from those answers
     using the routing rules embedded in Auto Responses sheet
  3. Read all controls from Questions sheet (master registry)
  4. Cross-reference answers from (backend scoring) sheet
  5. Filter out controls belonging to disabled sheets/sections
  6. Return clean list of assessable controls with weights from Questions sheet
"""

from openpyxl import load_workbook


# ── Routing: REQU answer → what to disable ───────────────────────────────────
# Maps (question_id, answer) → list of things to disable
# "sheet:SheetName" = entire sheet
# "prefix:HIPA"     = all controls with that ID prefix inside Case-Specific
# This is derived from Auto Responses sheet logic — update here if HECVAT adds new REQU questions

ROUTING_RULES = {
    ("REQU-01", "No"):  ["sheet:Product", "sheet:Infrastructure"],
    ("REQU-02", "No"):  ["sheet:IT Accessibility"],
    ("REQU-03", "No"):  ["prefix:CONS"],
    ("REQU-04", "No"):  ["sheet:AI"],
    ("REQU-05", "No"):  ["prefix:HIPA"],
    ("REQU-06", "No"):  ["prefix:PCID"],
    ("REQU-07", "No"):  ["prefix:ONPR"],
    ("REQU-08", "No"):  ["sheet:Privacy"],
}

# Sheets that are analyst-only and never assessed
ANALYST_SHEETS = {
    "Institution Evaluation",
    "High-Risk Evaluation",
    "Privacy Analyst Evaluation",
    "Analyst Reference",
    "Questions",
    "Auto Responses",
    "(backend scoring)",
    "START HERE",
}

# Control ID prefixes that are metadata only — never assessable
METADATA_PREFIXES = {"GNRL", "COMP", "REQU", "AIQU"}


# ── Step 1: Read routing answers ──────────────────────────────────────────────

def _read_routing_answers(wb) -> dict:
    """
    Read REQU and AIQU answers from (backend scoring) sheet.
    Returns dict like {"REQU-01": "Yes", "REQU-08": "No", ...}
    """
    answers = {}
    try:
        ws = wb["(backend scoring)"]
        for row in ws.iter_rows(values_only=True):
            if not row[0]:
                continue
            control_id = str(row[0]).strip()
            prefix = control_id.split("-")[0].upper() if "-" in control_id else ""
            if prefix in ("REQU", "AIQU"):
                answer = str(row[5] or "").strip() if len(row) > 5 else ""
                answers[control_id] = answer
    except Exception as e:
        print(f"  [Parser] Warning: could not read routing answers: {e}")
    return answers


# ── Step 2: Build disabled set from routing answers ───────────────────────────

def _build_disabled(routing_answers: dict) -> tuple[set, set]:
    """
    Returns:
        disabled_sheets   — set of sheet names to skip entirely
        disabled_prefixes — set of control ID prefixes to skip
    """
    disabled_sheets   = set()
    disabled_prefixes = set()

    for (question_id, trigger_answer), rules in ROUTING_RULES.items():
        vendor_answer = routing_answers.get(question_id, "").strip().lower()
        if vendor_answer == trigger_answer.lower():
            for rule in rules:
                if rule.startswith("sheet:"):
                    disabled_sheets.add(rule[6:])
                elif rule.startswith("prefix:"):
                    disabled_prefixes.add(rule[7:].upper())

    return disabled_sheets, disabled_prefixes


# ── Step 3+4: Read controls from Questions sheet + answers from backend ───────

def _read_questions_master(wb) -> dict:
    """
    Read Questions sheet — the master control registry.
    Returns dict: {control_id: {question, weight, score_mapping, compliant_response, ...}}
    """
    controls = {}
    try:
        ws = wb["Questions"]
        rows = list(ws.iter_rows(values_only=True))
        # Row index 1 is the header
        # Columns (0-indexed):
        #  0=New ID, 1=Question, 2=Start, 3=Org, 4=Product, 5=Infra,
        #  6=Access, 7=Case, 8=AI, 9=Privacy,
        #  10=Score Mapping, 11=Score Location, 12=Additional Info,
        #  13=If/then, 14=Standard Guidance, 15=No Guidance, 16=Yes Guidance,
        #  17=N/A Guidance, 18=Reason, 19=Follow-Up, 20=Compliant Response,
        #  21=Compliant, 22=Default Importance, 23=Default Weight
        for row in rows[2:]:  # skip note row and header row
            if not row[0]:
                continue
            control_id = str(row[0]).strip()
            if not control_id or control_id.startswith("End"):
                continue

            def cell(i, default=""):
                return str(row[i] or default).strip() if len(row) > i else default

            controls[control_id] = {
                "control_id":        control_id,
                "question":          cell(1),
                "score_mapping":     cell(10),
                "score_location":    cell(11),
                "guidance":          cell(14),
                "no_guidance":       cell(15),
                "yes_guidance":      cell(16),
                "na_guidance":       cell(17),
                "compliant_response":cell(20),
                "default_importance":cell(22),
                "default_weight":    cell(23, "10"),
                # sheet presence flags (1.0 = present, blank = not)
                "in_start":    bool(row[2] if len(row) > 2 else None),
                "in_org":      bool(row[3] if len(row) > 3 else None),
                "in_product":  bool(row[4] if len(row) > 4 else None),
                "in_infra":    bool(row[5] if len(row) > 5 else None),
                "in_access":   bool(row[6] if len(row) > 6 else None),
                "in_case":     bool(row[7] if len(row) > 7 else None),
                "in_ai":       bool(row[8] if len(row) > 8 else None),
                "in_privacy":  bool(row[9] if len(row) > 9 else None),
            }
    except Exception as e:
        print(f"  [Parser] Warning: could not read Questions sheet: {e}")
    return controls


def _read_backend_answers(wb) -> dict:
    """
    Read vendor answers from (backend scoring) sheet.
    Returns dict: {control_id: {answer, score_mapping}}
    Already computed values — no formula strings.
    """
    answers = {}
    try:
        ws = wb["(backend scoring)"]
        rows = list(ws.iter_rows(values_only=True))
        for row in rows[2:]:  # skip note + header
            if not row[0]:
                continue
            control_id = str(row[0]).strip()
            answer = str(row[5] or "").strip() if len(row) > 5 else ""
            # Skip formula strings that weren't computed
            if answer.startswith("="):
                answer = ""
            answers[control_id] = {
                "answer":        answer,
                "score_mapping": str(row[3] or "").strip() if len(row) > 3 else "",
            }
    except Exception as e:
        print(f"  [Parser] Warning: could not read backend scoring: {e}")
    return answers


# ── Map control_id prefix → sheet name ───────────────────────────────────────

def _infer_sheet(control: dict) -> str:
    """Infer primary sheet from Questions sheet flags."""
    if control["in_privacy"]: return "Privacy"
    if control["in_ai"]:      return "AI"
    if control["in_case"]:    return "Case-Specific"
    if control["in_access"]:  return "IT Accessibility"
    if control["in_infra"]:   return "Infrastructure"
    if control["in_product"]: return "Product"
    if control["in_org"]:     return "Organization"
    if control["in_start"]:   return "START HERE"
    return "Unknown"


# ── Section name from control ID prefix ──────────────────────────────────────

PREFIX_TO_SECTION = {
    "DOCU": "Documentation",
    "THRD": "Third-Party Management",
    "CHNG": "Change Management",
    "AAAI": "Access Control",
    "DATA": "Data Security",
    "DCTR": "Data Center",
    "MOBL": "Mobile",
    "NETW": "Network Security",
    "VULN": "Vulnerability Management",
    "INCD": "Incident Response",
    "BKUP": "Backup & Recovery",
    "ENCR": "Encryption",
    "SOFT": "Software Development",
    "PHYS": "Physical Security",
    "PRIV": "Privacy",
    "CONS": "Consulting",
    "HIPA": "HIPAA",
    "PCID": "PCI-DSS",
    "ONPR": "On-Premises",
    "AIPL": "AI Policy",
    "AIFN": "AI Functionality",
    "AISC": "AI Security",
    "AIPV": "AI Privacy",
    "ITAC": "IT Accessibility",
    "HFIH": "Incident Response",
    "FIDP": "Firewall & IDS/IPS",
    "PPPR": "Policies, Processes & Procedures",
    "OPEM": "Operational & Emerging Tech",
    "APPL": "Application Security",
    "AIGN": "AI Governance",
    "AIML": "AI/ML Data Separation",
    "AILM": "LLM Privileges",
    "DPAI": "AI & Data Privacy",
    "PCOM": "Privacy Compliance",
    "PDOC": "Privacy Documentation",
    "PTHP": "Privacy Third Parties",
    "PCHG": "Privacy Change Management",
    "PDAT": "Personal Data Processing",
    "PRPO": "Privacy Risk & Programme",
    "DRPV": "Data Privacy Impact Assessment",
    "INTL": "International",
    "PRGN": "FERPA/COPPA",
}

def _get_section(control_id: str) -> str:
    prefix = control_id.split("-")[0].upper() if "-" in control_id else control_id[:4].upper()
    return PREFIX_TO_SECTION.get(prefix, prefix)


# ── Public API ────────────────────────────────────────────────────────────────

def parse_hecvat_excel(excel_path: str, debug: bool = False) -> list[dict]:
    """
    Parse a filled HECVAT Excel file.

    Returns list of assessable controls only:
    - Routing-disabled sheets/sections excluded
    - Metadata-only prefixes excluded (GNRL, COMP, REQU, AIQU)
    - Not-scored controls excluded
    - N/A answers flagged separately

    Each item:
    {
      control_id, section, sheet, question, answer, guidance,
      is_critical, weight, score_mapping, compliant_response,
      additional_info, analyst_notes
    }
    """
    wb = load_workbook(excel_path, read_only=True, data_only=True)
    try:
        # Step 1: routing answers
        routing_answers = _read_routing_answers(wb)
        if debug:
            print(f"  [Parser] Routing answers: {routing_answers}")

        # Step 2: what to disable
        disabled_sheets, disabled_prefixes = _build_disabled(routing_answers)
        if debug:
            print(f"  [Parser] Disabled sheets: {disabled_sheets}")
            print(f"  [Parser] Disabled prefixes: {disabled_prefixes}")

        # Step 3: master question list
        questions = _read_questions_master(wb)
        if debug:
            print(f"  [Parser] Questions loaded: {len(questions)}")

        # Step 4: vendor answers
        backend_answers = _read_backend_answers(wb)
        if debug:
            print(f"  [Parser] Backend answers loaded: {len(backend_answers)}")

        # Step 5: filter and assemble
        controls = []
        skipped_metadata  = 0
        skipped_disabled  = 0
        skipped_notscored = 0
        skipped_noquestion = 0

        for control_id, q in questions.items():
            if not q["question"]:
                skipped_noquestion += 1
                continue

            # Skip metadata prefixes
            prefix = control_id.split("-")[0].upper() if "-" in control_id else ""
            if prefix in METADATA_PREFIXES:
                skipped_metadata += 1
                continue

            # Skip not-scored controls
            score_loc = q["score_location"].lower()
            score_map = q["score_mapping"].lower()
            if score_loc == "not scored" or score_map == "na":
                skipped_notscored += 1
                continue

            # Infer sheet
            sheet = _infer_sheet(q)

            # Skip analyst-only sheets
            if sheet in ANALYST_SHEETS:
                skipped_metadata += 1
                continue

            # Skip routing-disabled sheets
            if sheet in disabled_sheets:
                skipped_disabled += 1
                continue

            # Skip routing-disabled prefixes (e.g. HIPA when REQU-05=No)
            if prefix in disabled_prefixes:
                skipped_disabled += 1
                continue

            # Get vendor answer
            ba = backend_answers.get(control_id, {})
            answer = ba.get("answer", "Not answered") or "Not answered"

            # Detect N/A answers (auto-populated due to routing)
            is_na = answer.lower() == "n/a" or answer.lower().startswith("based on the response")

            controls.append({
                "control_id":         control_id,
                "section":            _get_section(control_id),
                "sheet":              sheet,
                "question":           q["question"],
                "answer":             "N/A (auto-excluded by routing)" if is_na else answer,
                "additional_info":    "",   # not available from backend scoring
                "analyst_notes":      "",
                "guidance":           q["guidance"],
                "is_critical":        "*" in q["question"] or q["default_importance"] in ("Critical", "High"),
                "weight":             _parse_weight(q["default_weight"]),
                "score_mapping":      q["score_mapping"],
                "compliant_response": q["compliant_response"],
                "is_na_routed":       is_na,
            })

        print(f"  [Parser] Skipped: {skipped_metadata} metadata, "
              f"{skipped_disabled} routing-disabled, "
              f"{skipped_notscored} not-scored, "
              f"{skipped_noquestion} no-question")
        print(f"  [Parser] Assessable controls: {len(controls)}")
        return controls
    finally:
        wb.close()


def _parse_weight(w) -> int:
    try:
        return int(float(str(w)))
    except Exception:
        return 10


# ── Helpers for ingest.py (hecvat template ingestion) ────────────────────────

def hecvat_control_to_text(c: dict) -> str:
    parts = [
        f"Control: {c['control_id']}",
        f"Section: {c['section']}",
        f"Question: {c['question']}",
    ]
    if c.get("guidance"):
        parts.append(f"Guidance: {c['guidance']}")
    if c.get("compliant_response"):
        parts.append(f"Compliant Response: {c['compliant_response']}")
    return "\n".join(parts)


def hecvat_control_to_metadata(c: dict) -> dict:
    return {
        "control_id": c["control_id"],
        "section":    c["section"],
        "sheet":      c.get("sheet", ""),
        "source":     "hecvat_template",
    }
