from __future__ import annotations

import os
import re
from datetime import datetime, timezone

import fitz


_REPORT_TYPE = re.compile(r"\b(type\s*(?:1|2|i|ii))\b", re.I)
_PERIOD = re.compile(
    r"\b(?:period|from)\s+([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})\s+"
    r"(?:through|to|-)\s+([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})",
    re.I,
)
_TSC = re.compile(
    r"\b(security|availability|processing integrity|confidentiality|privacy)\b",
    re.I,
)
_EXCEPTION = re.compile(r"\b(exception|deviation|test failure|not operating effectively)\b", re.I)
_OPINION = re.compile(r"\b(?:in our opinion|we believe that)\b.{0,700}", re.I | re.S)
_CONTROL = re.compile(
    r"(?m)^\s*((?:CC|A|C|P|PI)\d{1,2}(?:\.\d{1,2})+)\s*[-:–]?\s*(.{10,500})$",
    re.I,
)
# match a labelled field only — prose mentioning "service organization" is not a name
_SERVICE_ORG = re.compile(
    r"(?:system provided by[:\s]+|service organization\s*:\s*)([^\n]{3,160})",
    re.I,
)
_AUDITOR = re.compile(
    r"(?:independent service auditor|independent auditor)\s*:\s*([^\n]{3,160})",
    re.I,
)
_SUBSERVICE = re.compile(r"\bsubservice organizations?\s*:\s*([^\n]{3,200})", re.I)

# a capture starting mid-sentence is prose, not a name
_PROSE_START = re.compile(
    r"^(?:may|might|is|are|was|were|has|have|had|will|would|can|could|should|shall|that|which|"
    r"who|whose|and|or|of|in|on|to|for|with|by|as|its|their|the|a|an|described|detailed|"
    r"controls?|means?|includes?)\b",
    re.I,
)


def _stated_value(match: re.Match | None) -> str | None:
    if not match:
        return None
    value = " ".join(match.group(1).split()).strip(" .;:,")
    if not value or _PROSE_START.match(value):
        return None
    return value
_CUEC = re.compile(
    r"(?im)^\s*(?:CUEC[-\s]*)?(\d+(?:\.\d+)*)\s*[-:–]\s*(.{10,500})$"
)


def _matches_with_pages(pattern: re.Pattern, pages: list[dict], limit: int = 50) -> list[dict]:
    matches: list[dict] = []
    for page in pages:
        for match in pattern.finditer(page["text"]):
            matches.append({
                "page": page["page"],
                "excerpt": " ".join(match.group(0).split())[:500],
            })
            if len(matches) >= limit:
                return matches
    return matches


def extract_soc2(pdf_path: str) -> dict:
    pages: list[dict] = []
    with fitz.open(pdf_path) as document:
        for index, page in enumerate(document):
            text = page.get_text("text").strip()
            if text:
                pages.append({"page": index + 1, "text": text})
        page_count = document.page_count

    combined = "\n".join(page["text"] for page in pages)
    report_type_match = _REPORT_TYPE.search(combined)
    period_match = _PERIOD.search(combined)
    opinion_match = _OPINION.search(combined)
    exception_matches = _matches_with_pages(_EXCEPTION, pages)
    criteria = sorted({match.group(1).title() for match in _TSC.finditer(combined)})
    controls = [
        {
            "control_id": match.group(1).upper(),
            "description": " ".join(match.group(2).split())[:500],
        }
        for match in _CONTROL.finditer(combined)
    ][:500]
    service_org_match = _SERVICE_ORG.search(combined)
    auditor_match = _AUDITOR.search(combined)
    subservices = sorted({
        value[:200] for value in (
            _stated_value(match) for match in _SUBSERVICE.finditer(combined)
        ) if value
    })
    cuecs = [
        {
            "control_id": match.group(1),
            "description": " ".join(match.group(2).split())[:500],
        }
        for match in _CUEC.finditer(combined)
    ][:200]

    if not pages:
        status = "NO_EXTRACTABLE_TEXT"
        review_reason = "The PDF contains no extractable text and may be scanned or malformed."
    else:
        status = "PARTIAL"
        review_reason = (
            "Automated extraction is advisory; verify report scope, auditor opinion, "
            "control tests, exceptions, and page references against the source PDF."
        )

    return {
        "schema_version": 1,
        "extracted_at": datetime.now(timezone.utc).isoformat(),
        "source_filename": os.path.basename(pdf_path),
        "page_count": page_count,
        "pages_with_extractable_text": len(pages),
        "extraction_status": status,
        "manual_review_required": True,
        "manual_review_reason": review_reason,
        "report_type": (
            report_type_match.group(1).upper().replace(" ", "")
            if report_type_match else None
        ),
        "service_organization": _stated_value(service_org_match),
        "auditor": _stated_value(auditor_match),
        "opinion": " ".join(opinion_match.group(0).split())[:700] if opinion_match else None,
        "testing_period": {
            "start": period_match.group(1) if period_match else None,
            "end": period_match.group(2) if period_match else None,
        },
        "scope": None,
        "trust_services_criteria": criteria,
        "controls": controls,
        "test_procedures": [],
        "results": [],
        "exceptions": exception_matches,
        "management_responses": [],
        "complementary_user_entity_controls": cuecs,
        "subservice_organizations": subservices,
        "page_references": sorted({item["page"] for item in exception_matches}),
    }
