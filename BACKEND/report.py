"""
report.py — PDF + Excel report generation.
Updated for:
  - Murdoch RMF risk levels (LOW/MEDIUM/HIGH/EXTREME) instead of 0-100 score
  - Two-layer status (hecvat_compliance + policy_alignment + overall_status)
  - INSUFFICIENT_EVIDENCE shown as coverage metric, excluded from risk band
  - policy_clause_referenced column in Excel
"""

import os
from datetime import datetime
import config
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    HRFlowable, PageBreak
)

RMF_COLORS = {
    "EXTREME":   colors.HexColor("#7B241C"),
    "HIGH":      colors.HexColor("#C0392B"),
    "MEDIUM":    colors.HexColor("#E67E22"),
    "MINOR":     colors.HexColor("#F1C40F"),
    "LOW":       colors.HexColor("#27AE60"),
    "NOT_SCORED":colors.HexColor("#95A5A6"),
}
STATUS_COLORS = {
    "GAP":                   colors.HexColor("#C0392B"),
    "PARTIAL":               colors.HexColor("#E67E22"),
    "COMPLIANT":             colors.HexColor("#27AE60"),
    "INSUFFICIENT_EVIDENCE": colors.HexColor("#7F8C8D"),
    "NOT_ASSESSED":          colors.HexColor("#BDC3C7"),
}


def _styles():
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle("title", parent=base["Title"],
                                fontSize=20, textColor=colors.HexColor("#1A1A2E"), spaceAfter=6),
        "h1":    ParagraphStyle("h1", parent=base["Heading1"],
                                fontSize=14, textColor=colors.HexColor("#16213E"), spaceBefore=12, spaceAfter=4),
        "h2":    ParagraphStyle("h2", parent=base["Heading2"],
                                fontSize=11, textColor=colors.HexColor("#0F3460"), spaceBefore=8, spaceAfter=3),
        "body":  ParagraphStyle("body", parent=base["Normal"],
                                fontSize=9, leading=13, spaceAfter=4),
        "small": ParagraphStyle("small", parent=base["Normal"],
                                fontSize=8, leading=11, textColor=colors.HexColor("#555555")),
        "bold":  ParagraphStyle("bold", parent=base["Normal"],
                                fontSize=9, fontName="Helvetica-Bold"),
    }


def _exec_summary_table(summary: dict, styles: dict):
    band  = summary.get("overall_risk_band", "N/A")
    score = summary.get("overall_rmf_score", 0)
    cov   = summary.get("coverage_pct", 0)
    data = [
        ["Metric", "Value"],
        ["Total Controls",           str(summary["total_controls"])],
        ["Assessed (policy match)",  str(summary.get("assessed_controls", 0))],
        ["Insufficient Evidence",    str(summary.get("insufficient_evidence", 0))],
        ["Coverage",                 f"{cov}%"],
        ["Compliant",                str(summary["status_breakdown"].get("COMPLIANT", 0))],
        ["Partial",                  str(summary["total_partial"])],
        ["Gaps",                     str(summary["total_gaps"])],
        ["Extreme Risks",            str(len(summary.get("extreme_risks", [])))],
        ["High Risks",               str(len(summary.get("high_risks", [])))],
        ["── RMF Score (assessed)",  str(score)],
        ["── Overall Risk Band",     band],
    ]
    t = Table(data, colWidths=[10*cm, 5*cm])
    t.setStyle(TableStyle([
        ("BACKGROUND",    (0, 0), (-1, 0),  colors.HexColor("#1A1A2E")),
        ("TEXTCOLOR",     (0, 0), (-1, 0),  colors.white),
        ("FONTNAME",      (0, 0), (-1, 0),  "Helvetica-Bold"),
        ("FONTSIZE",      (0, 0), (-1, -1), 9),
        ("ROWBACKGROUNDS",(0, 1), (-1, -1), [colors.HexColor("#F8F9FA"), colors.white]),
        ("GRID",          (0, 0), (-1, -1), 0.5, colors.HexColor("#DEE2E6")),
        ("FONTNAME",      (0, 10),(-1, -1), "Helvetica-Bold"),
        ("LEFTPADDING",   (0, 0), (-1, -1), 8),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 8),
        ("TOPPADDING",    (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return t


def _rmf_legend_table(styles: dict):
    data = [
        ["RMF Level", "Likelihood × Impact", "Action"],
        ["EXTREME",   "High L × High I",     "Immediate action required"],
        ["HIGH",      "High L × Med I",       "Senior management attention"],
        ["MEDIUM",    "Med L × Med I",        "Management responsibility"],
        ["MINOR",     "Low L × Med I",        "Monitor and review"],
        ["LOW",       "Low L × Low I",        "Routine procedures"],
    ]
    t = Table(data, colWidths=[3*cm, 6*cm, 6*cm])
    fills = [
        colors.HexColor("#7B241C"),
        colors.HexColor("#C0392B"),
        colors.HexColor("#E67E22"),
        colors.HexColor("#F1C40F"),
        colors.HexColor("#27AE60"),
    ]
    style_cmds = [
        ("BACKGROUND",  (0, 0), (-1, 0), colors.HexColor("#16213E")),
        ("TEXTCOLOR",   (0, 0), (-1, 0), colors.white),
        ("FONTNAME",    (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE",    (0, 0), (-1,-1), 8),
        ("GRID",        (0, 0), (-1,-1), 0.3, colors.HexColor("#DEE2E6")),
        ("TOPPADDING",  (0, 0), (-1,-1), 4),
        ("BOTTOMPADDING",(0,0), (-1,-1), 4),
        ("LEFTPADDING", (0, 0), (-1,-1), 6),
    ]
    for i, fill in enumerate(fills, 1):
        style_cmds.append(("BACKGROUND", (0, i), (0, i), fill))
        style_cmds.append(("TEXTCOLOR",  (0, i), (0, i), colors.white))
    t.setStyle(TableStyle(style_cmds))
    return t


def _section_scores_table(summary: dict, styles: dict):
    section_scores = summary.get("section_rmf_scores", {})
    if not section_scores:
        return None
    data = [["Section", "Avg RMF Score", "Band"]]
    for sec, score in sorted(section_scores.items(), key=lambda x: -x[1]):
        band = config.rmf_band_from_score(score)
        data.append([sec, str(round(score, 2)), band])
    t = Table(data, colWidths=[8*cm, 4*cm, 3*cm])
    style_cmds = [
        ("BACKGROUND",    (0, 0), (-1, 0), colors.HexColor("#0F3460")),
        ("TEXTCOLOR",     (0, 0), (-1, 0), colors.white),
        ("FONTNAME",      (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE",      (0, 0), (-1,-1), 9),
        ("ROWBACKGROUNDS",(0, 1), (-1,-1), [colors.HexColor("#F8F9FA"), colors.white]),
        ("GRID",          (0, 0), (-1,-1), 0.5, colors.HexColor("#DEE2E6")),
        ("LEFTPADDING",   (0, 0), (-1,-1), 8),
        ("TOPPADDING",    (0, 0), (-1,-1), 5),
        ("BOTTOMPADDING", (0, 0), (-1,-1), 5),
    ]
    for i, row in enumerate(data[1:], 1):
        band_col = RMF_COLORS.get(row[2], colors.white)
        style_cmds.append(("BACKGROUND", (2, i), (2, i), band_col))
        style_cmds.append(("TEXTCOLOR",  (2, i), (2, i),
                           colors.white if row[2] != "MEDIUM" else colors.black))
    t.setStyle(TableStyle(style_cmds))
    return t


def _findings_table(findings: list[dict], styles: dict):
    headers = ["ID", "Section", "HECVAT", "Policy", "Overall", "RMF", "L", "I",
               "Gap / Finding", "Policy Clause", "Recommendation"]
    rows = [headers]
    for f in findings:
        rows.append([
            Paragraph(f.get("control_id", ""), styles["small"]),
            Paragraph(f.get("section", "")[:30], styles["small"]),
            Paragraph(f.get("hecvat_compliance") or "", styles["small"]),
            Paragraph(f.get("policy_alignment") or "", styles["small"]),
            Paragraph(f.get("overall_status") or "", styles["small"]),
            Paragraph(f.get("rmf_level", ""), styles["small"]),
            Paragraph(str(f.get("likelihood", "")), styles["small"]),
            Paragraph(str(f.get("impact", "")), styles["small"]),
            Paragraph(str(f.get("gap_description") or ""), styles["small"]),
            Paragraph(str(f.get("policy_clause_referenced") or ""), styles["small"]),
            Paragraph(str(f.get("recommendation") or ""), styles["small"]),
        ])

    col_widths = [1.34*cm, 1.87*cm, 1.12*cm, 1.49*cm, 1.34*cm, 1.34*cm,
                  0.45*cm, 0.45*cm, 3.36*cm, 2.24*cm, 3.0*cm]
    t = Table(rows, colWidths=col_widths, repeatRows=1)
    style_cmds = [
        ("BACKGROUND",    (0, 0), (-1, 0), colors.HexColor("#16213E")),
        ("TEXTCOLOR",     (0, 0), (-1, 0), colors.white),
        ("FONTNAME",      (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE",      (0, 0), (-1,-1), 7),
        ("GRID",          (0, 0), (-1,-1), 0.3, colors.HexColor("#DEE2E6")),
        ("VALIGN",        (0, 0), (-1,-1), "TOP"),
        ("TOPPADDING",    (0, 0), (-1,-1), 3),
        ("BOTTOMPADDING", (0, 0), (-1,-1), 3),
        ("LEFTPADDING",   (0, 0), (-1,-1), 3),
    ]
    for i, f in enumerate(findings, 1):
        overall = f.get("overall_status", "")
        rmf     = f.get("rmf_level", "")
        sc = STATUS_COLORS.get(overall, colors.white)
        rc = RMF_COLORS.get(rmf, colors.white)
        style_cmds.append(("BACKGROUND", (4, i), (4, i), sc))
        style_cmds.append(("TEXTCOLOR",  (4, i), (4, i), colors.white))
        style_cmds.append(("BACKGROUND", (5, i), (5, i), rc))
        style_cmds.append(("TEXTCOLOR",  (5, i), (5, i),
                           colors.white if rmf not in ("MEDIUM", "NOT_SCORED") else colors.black))
        bg = (colors.HexColor("#FFF5F5") if overall == "GAP" else
              colors.HexColor("#FFFBF0") if overall == "PARTIAL" else colors.white)
        style_cmds.append(("BACKGROUND", (0, i), (3, i), bg))
    t.setStyle(TableStyle(style_cmds))
    return t


def generate_pdf(findings: list[dict], summary: dict, service_name: str, output_path: str):
    doc    = SimpleDocTemplate(output_path, pagesize=A4,
                               rightMargin=1.5*cm, leftMargin=1.5*cm,
                               topMargin=2*cm, bottomMargin=2*cm)
    styles = _styles()
    story  = []
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M")

    story.append(Paragraph("IT Vendor Risk Assessment Report", styles["title"]))
    story.append(Paragraph(f"Service: {service_name}", styles["h2"]))
    story.append(Paragraph(
        f"Generated: {now_str} | Classification: INTERNAL CONFIDENTIAL | "
        f"Framework: Murdoch University Risk Management Framework",
        styles["small"]
    ))
    story.append(HRFlowable(width="100%", thickness=1, color=colors.HexColor("#1A1A2E")))
    story.append(Spacer(1, 0.3*cm))
    story.append(Paragraph(
        "Assessment scope: Murdoch University internal policy documents and HECVAT template only. "
        "No external frameworks (NIST, ISO, GDPR etc.) applied. "
        "Risk scored via Murdoch RMF likelihood × impact matrix on assessed controls only. "
        "Controls marked INSUFFICIENT_EVIDENCE reflect policy knowledge-base coverage gaps, "
        "not vendor compliance status.",
        styles["body"]
    ))
    story.append(Spacer(1, 0.3*cm))

    story.append(Paragraph("1. Executive Summary", styles["h1"]))
    story.append(_exec_summary_table(summary, styles))
    story.append(Spacer(1, 0.5*cm))

    story.append(Paragraph("2. Murdoch RMF Risk Legend", styles["h1"]))
    story.append(_rmf_legend_table(styles))
    story.append(Spacer(1, 0.5*cm))

    sec_table = _section_scores_table(summary, styles)
    if sec_table:
        story.append(Paragraph("3. Risk by Section (Assessed Controls Only)", styles["h1"]))
        story.append(sec_table)
        story.append(Spacer(1, 0.5*cm))

    extreme = summary.get("extreme_risks", [])
    if extreme:
        story.append(Paragraph("🔴 EXTREME Risks — Immediate Action Required", styles["h2"]))
        for g in extreme:
            story.append(Paragraph(
                f"• [{g['control_id']}] {g.get('gap_description', '')[:200]}", styles["body"]
            ))
        story.append(Spacer(1, 0.3*cm))

    high = summary.get("high_risks", [])
    if high:
        story.append(Paragraph("🟠 HIGH Risks — Senior Management Attention", styles["h2"]))
        for g in high:
            story.append(Paragraph(
                f"• [{g['control_id']}] {g.get('gap_description', '')[:200]}", styles["body"]
            ))
        story.append(Spacer(1, 0.3*cm))

    story.append(PageBreak())
    story.append(Paragraph("4. Detailed Findings", styles["h1"]))
    story.append(Spacer(1, 0.2*cm))
    story.append(_findings_table(findings, styles))

    doc.build(story)
    print(f"  📄 PDF: {output_path}")


def generate_excel(findings: list[dict], summary: dict, service_name: str, output_path: str):
    from openpyxl import Workbook
    from openpyxl.styles import PatternFill, Font, Alignment, Border, Side
    from openpyxl.utils import get_column_letter

    wb = Workbook()
    ws = wb.active
    ws.title = "Risk Register"

    headers = [
        "Control ID", "Section", "Sheet", "Is Critical",
        "Requirement Summary", "Vendor Response Summary",
        "Vendor Evidence Corroborated",
        "HECVAT Compliance", "Policy Alignment", "Overall Status",
        "RMF Level", "Likelihood (1-5)", "Impact (1-5)",
        "Gap Description", "Policy Clause Referenced",
        "Recommendation", "Evidence Quality",
        "Follow-Up Applied", "Context Sources"
    ]

    hfill = PatternFill("solid", fgColor="1A1A2E")
    hfont = Font(color="FFFFFF", bold=True, size=9)
    thin  = Border(
        left=Side(style="thin"), right=Side(style="thin"),
        top=Side(style="thin"), bottom=Side(style="thin")
    )

    for col, h in enumerate(headers, 1):
        cell = ws.cell(row=1, column=col, value=h)
        cell.fill = hfill
        cell.font = hfont
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        cell.border = thin

    STATUS_FILLS = {
        "GAP":                   PatternFill("solid", fgColor="FFCCCC"),
        "PARTIAL":               PatternFill("solid", fgColor="FFE5CC"),
        "COMPLIANT":             PatternFill("solid", fgColor="CCFFCC"),
        "INSUFFICIENT_EVIDENCE": PatternFill("solid", fgColor="E5E5E5"),
        "NOT_ASSESSED":          PatternFill("solid", fgColor="F0F0F0"),
    }
    RMF_FILLS = {
        "EXTREME":    PatternFill("solid", fgColor="C0392B"),
        "HIGH":       PatternFill("solid", fgColor="E67E22"),
        "MEDIUM":     PatternFill("solid", fgColor="F1C40F"),
        "MINOR":      PatternFill("solid", fgColor="F9E79F"),
        "LOW":        PatternFill("solid", fgColor="27AE60"),
        "NOT_SCORED": PatternFill("solid", fgColor="BDC3C7"),
    }

    for row_i, f in enumerate(findings, 2):
        values = [
            f.get("control_id", ""),
            f.get("section", ""),
            f.get("sheet", ""),
            "Yes" if f.get("is_critical") else "No",
            f.get("requirement_summary", ""),
            f.get("vendor_response_summary", ""),
            "Yes" if f.get("vendor_evidence_corroborated") else "No",
            f.get("hecvat_compliance", ""),
            f.get("policy_alignment", ""),
            f.get("overall_status", ""),
            f.get("rmf_level", ""),
            f.get("likelihood", ""),
            f.get("impact", ""),
            f.get("gap_description", ""),
            f.get("policy_clause_referenced", ""),
            f.get("recommendation", ""),
            f.get("evidence_quality", ""),
            "Yes" if f.get("followup_applied") else "No",
            ", ".join(f.get("context_sources") or []),
        ]
        for col_i, val in enumerate(values, 1):
            cell = ws.cell(row=row_i, column=col_i, value=val)
            cell.alignment = Alignment(wrap_text=True, vertical="top")
            cell.border = thin
            if col_i == 10:  # Overall Status
                cell.fill = STATUS_FILLS.get(str(val), PatternFill())
            if col_i == 11:  # RMF Level
                fill = RMF_FILLS.get(str(val))
                if fill:
                    cell.fill = fill
                    cell.font = Font(
                        color="FFFFFF" if val in ("EXTREME","HIGH","LOW","NOT_SCORED") else "000000",
                        bold=True, size=9
                    )

    col_widths = [12, 20, 14, 10, 35, 35, 12, 16, 16, 18, 12, 8, 8, 45, 35, 45, 14, 10, 30]
    for i, w in enumerate(col_widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.row_dimensions[1].height = 35
    ws.freeze_panes = "A2"

    # ── Summary sheet ─────────────────────────────────────────────────────────
    ws2 = wb.create_sheet("Summary")
    ws2["A1"] = "IT Vendor Risk Assessment — Summary"
    ws2["A1"].font = Font(bold=True, size=14)
    ws2["A2"] = f"Service: {service_name}"
    ws2["A3"] = f"Date: {datetime.now().strftime('%Y-%m-%d %H:%M')}"
    ws2["A4"] = "Risk Framework: Murdoch University RMF (Likelihood × Impact)"
    ws2["A5"] = "Scope: Internal policies + HECVAT template. No external frameworks."
    ws2["A7"] = "Metric"; ws2["B7"] = "Value"
    ws2["A7"].font = Font(bold=True); ws2["B7"].font = Font(bold=True)

    summary_rows = [
        ("Total Controls",               summary["total_controls"]),
        ("Assessed (policy matched)",    summary.get("assessed_controls", 0)),
        ("Insufficient Evidence",        summary.get("insufficient_evidence", 0)),
        ("Coverage %",                   f"{summary.get('coverage_pct',0)}%"),
        ("Compliant",                    summary["status_breakdown"].get("COMPLIANT", 0)),
        ("Partial",                      summary["total_partial"]),
        ("Gaps",                         summary["total_gaps"]),
        ("Extreme Risks",                len(summary.get("extreme_risks", []))),
        ("High Risks",                   len(summary.get("high_risks", []))),
        ("── Avg RMF Score (assessed)",  summary.get("overall_rmf_score", 0)),
        ("── Overall Risk Band",         summary.get("overall_risk_band", "N/A")),
    ]
    for i, (label, val) in enumerate(summary_rows, 8):
        ws2[f"A{i}"] = label
        ws2[f"B{i}"] = val
    ws2["A17"].font = Font(bold=True)
    ws2["A18"].font = Font(bold=True)
    ws2.column_dimensions["A"].width = 35
    ws2.column_dimensions["B"].width = 20

    # ── Policy alignment breakdown ────────────────────────────────────────────
    ws2["A21"] = "Policy Alignment Breakdown"
    ws2["A21"].font = Font(bold=True)
    ws2["A22"] = "Status"; ws2["B22"] = "Count"
    for i, (k, v) in enumerate(summary.get("policy_alignment_breakdown", {}).items(), 23):
        ws2[f"A{i}"] = k; ws2[f"B{i}"] = v

    # ── Section RMF scores sheet ──────────────────────────────────────────────
    section_scores = summary.get("section_rmf_scores", {})
    if section_scores:
        ws3 = wb.create_sheet("Section RMF Scores")
        ws3["A1"] = "Section"; ws3["B1"] = "Avg RMF Score"; ws3["C1"] = "Band"
        ws3["A1"].font = Font(bold=True)
        ws3["B1"].font = Font(bold=True)
        ws3["C1"].font = Font(bold=True)
        for i, (sec, score) in enumerate(sorted(section_scores.items(), key=lambda x: -x[1]), 2):
            band = config.rmf_band_from_score(score)
            ws3[f"A{i}"] = sec
            ws3[f"B{i}"] = round(score, 2)
            ws3[f"C{i}"] = band
            fill = RMF_FILLS.get(band)
            if fill:
                ws3[f"C{i}"].fill = fill
                ws3[f"C{i}"].font = Font(
                    color="FFFFFF" if band in ("EXTREME","HIGH","LOW") else "000000", bold=True
                )
        ws3.column_dimensions["A"].width = 35
        ws3.column_dimensions["B"].width = 18
        ws3.column_dimensions["C"].width = 14

    wb.save(output_path)
    print(f"  📊 Excel: {output_path}")


def generate_all(findings: list[dict], summary: dict,
                 service_name: str, output_dir: str = "."):
    os.makedirs(output_dir, exist_ok=True)
    # Sanitize slashes + spaces for the filename only; keep service_name intact for display.
    safe = (service_name.replace("/", "_").replace("\\", "_")
            .replace(" ", "_").lower()[:40])
    ts   = datetime.now().strftime("%Y%m%d_%H%M")
    pdf_path   = os.path.join(output_dir, f"risk_assessment_{safe}_{ts}.pdf")
    excel_path = os.path.join(output_dir, f"risk_register_{safe}_{ts}.xlsx")
    generate_pdf(findings,   summary, service_name, pdf_path)
    generate_excel(findings, summary, service_name, excel_path)
    return pdf_path, excel_path
