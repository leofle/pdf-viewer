#!/usr/bin/env python3
"""Generate samples/sample.pdf, the demo document shown by default.

All text in the document is original and released under the project's MIT license.
Requires: pip install reportlab
"""
import os
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer,
                                Table, TableStyle, PageBreak, NextPageTemplate, ListFlowable,
                                ListItem)
from reportlab.graphics.shapes import Drawing, Rect, Circle, String, Line
from reportlab.graphics.charts.barcharts import VerticalBarChart

OUT = os.path.join(os.path.dirname(__file__), "..", "samples", "sample.pdf")
ACCENT = colors.HexColor("#4f46e5")

styles = getSampleStyleSheet()
H1 = ParagraphStyle("H1", parent=styles["Heading1"], textColor=ACCENT, fontSize=26, leading=32)
H2 = ParagraphStyle("H2", parent=styles["Heading2"], textColor=colors.HexColor("#111827"))
BODY = ParagraphStyle("Body", parent=styles["BodyText"], fontSize=11, leading=16)
SMALL = ParagraphStyle("Small", parent=BODY, fontSize=9, textColor=colors.grey)


def decorate(canvas, doc):
    canvas.saveState()
    w, h = canvas._pagesize
    canvas.setFillColor(ACCENT)
    canvas.rect(0, h - 8 * mm, w, 8 * mm, stroke=0, fill=1)
    canvas.setFillColor(colors.grey)
    canvas.setFont("Helvetica", 9)
    canvas.drawString(20 * mm, 10 * mm, "PDF Viewer sample document")
    canvas.drawRightString(w - 20 * mm, 10 * mm, f"Page {doc.page}")
    canvas.restoreState()


def para(text):
    return Paragraph(text, BODY)


def chart():
    d = Drawing(400, 200)
    bc = VerticalBarChart()
    bc.x, bc.y, bc.width, bc.height = 40, 30, 340, 150
    bc.data = [[12, 19, 7, 15, 22, 9], [8, 11, 14, 10, 17, 13]]
    bc.categoryAxis.categoryNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun"]
    bc.valueAxis.valueMin = 0
    bc.bars[0].fillColor = ACCENT
    bc.bars[1].fillColor = colors.HexColor("#10b981")
    d.add(bc)
    return d


def shapes():
    d = Drawing(450, 160)
    palette = ["#4f46e5", "#10b981", "#f59e0b", "#ef4444", "#06b6d4"]
    for i, c in enumerate(palette):
        d.add(Circle(45 + i * 90, 100, 35, fillColor=colors.HexColor(c), strokeColor=None))
        d.add(String(45 + i * 90, 40, c, textAnchor="middle", fontSize=9))
    d.add(Line(10, 20, 440, 20, strokeColor=colors.lightgrey))
    return d


def build():
    doc = BaseDocTemplate(os.path.abspath(OUT), pagesize=A4, title="PDF Viewer Sample",
                          author="L. Fleishman", subject="Demo document for the PDF viewer")
    pw, ph = A4
    portrait = Frame(20 * mm, 18 * mm, pw - 40 * mm, ph - 40 * mm, id="p")
    lw, lh = landscape(A4)
    land = Frame(20 * mm, 18 * mm, lw - 40 * mm, lh - 40 * mm, id="l")
    doc.addPageTemplates([
        PageTemplate("portrait", [portrait], onPage=decorate, pagesize=A4),
        PageTemplate("landscape", [land], onPage=decorate, pagesize=landscape(A4)),
    ])

    s = []
    s += [Spacer(1, 40 * mm), Paragraph("PDF Viewer", H1),
          Paragraph("A sample document for exercising the viewer", H2), Spacer(1, 8 * mm),
          para("Welcome! This document was generated with a small Python script so that the "
               "viewer has something to show the moment it opens. Try selecting this text, "
               "searching for a word such as <b>aurora</b> or <b>lighthouse</b>, zooming, "
               "rotating, and jumping between pages with the thumbnails on the left."),
          Spacer(1, 6 * mm),
          ListFlowable([ListItem(para(t)) for t in [
              "Open your own file with the folder button or by dropping it onto the window.",
              "Use the arrow keys, Page Up / Page Down, Home and End to move around.",
              "Press Ctrl/Cmd + F to search, Ctrl/Cmd + plus or minus to zoom.",
          ]], bulletType="bullet"),
          PageBreak()]

    s += [Paragraph("1. Navigating long documents", H2)]
    for i in range(6):
        s.append(para(
            f"Paragraph {i + 1}. A lighthouse keeper once kept a notebook of every ship that "
            "passed in the night, writing down the colour of its lamps and the direction of the "
            "wind. Over the years the notebook grew into a quiet record of the sea, and anyone "
            "reading it could follow the seasons simply by the names of the vessels. The viewer "
            "renders each page lazily, so even a very long notebook stays responsive."))
        s.append(Spacer(1, 3 * mm))
    s += [Paragraph("Shapes and colour", H2), shapes(), PageBreak()]

    s += [Paragraph("2. Tables and data", H2),
          para("Tables are drawn as vector graphics with real text, so the numbers below are "
               "selectable and searchable.")]
    data = [["Region", "Q1", "Q2", "Q3", "Q4", "Total"]]
    rows = [("North", 120, 135, 150, 170), ("South", 98, 110, 125, 140),
            ("East", 143, 150, 149, 160), ("West", 87, 95, 120, 133),
            ("Aurora Station", 12, 18, 25, 31)]
    for r in rows:
        data.append([r[0], *r[1:], sum(r[1:])])
    t = Table(data, hAlign="LEFT", colWidths=[45 * mm] + [22 * mm] * 5)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), ACCENT), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.whitesmoke, colors.white]),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"), ("GRID", (0, 0), (-1, -1), 0.25, colors.lightgrey),
        ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5)]))
    s += [Spacer(1, 4 * mm), t, Spacer(1, 8 * mm), Paragraph("Monthly totals", H2), chart(),
          NextPageTemplate("landscape"), PageBreak()]

    s += [Paragraph("3. A landscape page", H2),
          para("This page is landscape to show that the viewer handles mixed page sizes. "
               "The aurora is visible from the northern station on clear winter nights, "
               "and the observers there log every sighting with the time and its colour."),
          Spacer(1, 6 * mm)]
    wide = [["Night", "Start", "End", "Colour", "Intensity", "Notes"]] + [
        [f"#{n}", f"2{n % 4}:{(n * 7) % 60:02d}", f"0{n % 3}:{(n * 13) % 60:02d}",
         ["green", "violet", "red", "green"][n % 4], str(1 + n % 5),
         ["calm sky", "light cloud", "very bright aurora", "short burst"][n % 4]]
        for n in range(1, 9)]
    t2 = Table(wide, hAlign="LEFT", colWidths=[25 * mm, 30 * mm, 30 * mm, 35 * mm, 30 * mm, 80 * mm])
    t2.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#10b981")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("GRID", (0, 0), (-1, -1), 0.25, colors.lightgrey)]))
    s += [t2, NextPageTemplate("portrait"), PageBreak()]

    s += [Paragraph("4. The end", H2),
          para("That's it. Thanks for trying the viewer! Use the download button to save this "
               "file or the print button to print it."),
          Spacer(1, 4 * mm), Paragraph("Generated by scripts/make_sample.py", SMALL)]
    doc.build(s)
    print("wrote", os.path.abspath(OUT))


if __name__ == "__main__":
    build()
