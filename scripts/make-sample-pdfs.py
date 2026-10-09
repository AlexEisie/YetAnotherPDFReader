"""Generate sample PDFs used for manual and automated UI testing (dev/samples/).

Requires PyMuPDF:  pip install pymupdf
Usage:             python scripts/make-sample-pdfs.py
"""

import math
import os
import sys

import fitz  # PyMuPDF

OUT = os.path.join(os.path.dirname(__file__), "..", "dev", "samples")

LOREM = (
    "Portable Document Format (PDF) is a file format developed by Adobe in 1992 to present documents, "
    "including text formatting and images, in a manner independent of application software, hardware, "
    "and operating systems. Based on the PostScript language, each PDF file encapsulates a complete "
    "description of a fixed-layout flat document, including the text, fonts, vector graphics, raster "
    "images and other information needed to display it. "
)
CHINESE = (
    "便携式文档格式（PDF）是一种用独立于应用程序、硬件、操作系统的方式呈现文档的文件格式。"
    "每个PDF文件包含固定布局的平面文档的完整描述，包括文本、字形、图形及其他需要显示的信息。"
)


def gradient_pixmap(w, h):
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, w, h), False)
    for y in range(h):
        for x in range(w):
            r = int(255 * x / w)
            g = int(128 + 127 * math.sin(y / 9))
            b = int(255 * (1 - y / h))
            pix.set_pixel(x, y, (r, g, b))
    return pix


def cjk_font_file():
    for name in ("msyh.ttc", "simsun.ttc", "msyh.ttf", "simhei.ttf"):
        path = os.path.join(os.environ.get("WINDIR", "C:\\Windows"), "Fonts", name)
        if os.path.exists(path):
            return path
    return None


def make_main():
    doc = fitz.open()
    toc = []
    cjk = cjk_font_file()
    image = gradient_pixmap(320, 200)
    chapters = ["Introduction", "History", "Technical details", "Annotations", "Forms", "Appendix"]
    for i in range(12):
        landscape = i == 7
        page = doc.new_page(width=842 if landscape else 595, height=595 if landscape else 842)
        ch = chapters[min(i // 2, len(chapters) - 1)]
        if i % 2 == 0:
            toc.append([1, f"{i // 2 + 1}. {ch}", i + 1])
            toc.append([2, f"{i // 2 + 1}.1 Overview", i + 1])
        else:
            toc.append([2, f"{i // 2 + 1}.2 Details", i + 1])
        page.insert_text((56, 70), f"{ch} — page {i + 1}", fontsize=22, fontname="helv", color=(0.1, 0.1, 0.35))
        rect = fitz.Rect(56, 90, page.rect.width - 56, 420)
        page.insert_textbox(rect, (LOREM * 3), fontsize=11, fontname="helv", align=fitz.TEXT_ALIGN_JUSTIFY)
        if cjk:
            page.insert_font(fontname="cjk", fontfile=cjk)
            page.insert_textbox(fitz.Rect(56, 430, page.rect.width - 56, 520), CHINESE, fontsize=12, fontname="cjk")
        page.insert_image(fitz.Rect(56, 540, 56 + 240, 540 + 150), pixmap=image)
        page.draw_rect(fitz.Rect(320, 540, 520, 690), color=(0.8, 0.2, 0.2), fill=(1, 0.9, 0.8), width=2)
        page.insert_text((330, 620), "Vector graphics", fontsize=14, color=(0.6, 0, 0))
        page.insert_text((page.rect.width / 2 - 10, page.rect.height - 30), str(i + 1), fontsize=10)

    # Links (targets must exist first)
    first = doc[0]
    first.insert_link({"kind": fitz.LINK_GOTO, "from": fitz.Rect(56, 760, 300, 780), "page": 5, "to": fitz.Point(0, 0)})
    first.insert_text((56, 775), "Internal link: jump to page 6", fontsize=12, color=(0, 0, 0.8))
    first.insert_link({"kind": fitz.LINK_URI, "from": fitz.Rect(320, 760, 540, 780), "uri": "https://mozilla.github.io/pdf.js/"})
    first.insert_text((320, 775), "External link: pdf.js website", fontsize=12, color=(0, 0, 0.8))

    # Existing annotations (rendered by pdf.js, editable by the app)
    p = doc[1]
    hits = p.search_for("Portable Document Format")
    if hits:
        hl = p.add_highlight_annot(hits[0])
        hl.set_info(title="Alice", content="Key definition")
        hl.update()
    note = p.add_text_annot((520, 100), "Please double-check this paragraph.", icon="Comment")
    note.set_info(title="Bob")
    note.update()
    ink = p.add_ink_annot([[(100, 300), (140, 330), (180, 300), (220, 330)]])
    ink.set_colors(stroke=(0, 0.4, 1))
    ink.set_border(width=2)
    ink.update()
    ft = p.add_freetext_annot(fitz.Rect(330, 690, 540, 740), "Existing free text annotation", fontsize=11, text_color=(0, 0, 0))
    ft.update()
    p2 = doc[2]
    sq = p2.add_rect_annot(fitz.Rect(60, 100, 260, 200))
    sq.set_colors(stroke=(0, 0.6, 0.2))
    sq.set_border(width=2)
    sq.update()
    ul = p2.search_for("hardware")
    if ul:
        u = p2.add_underline_annot(ul[0])
        u.update()

    # Form fields on page 9
    fp = doc[8]
    fp.insert_text((56, 470), "Form fields:", fontsize=14)
    w = fitz.Widget()
    w.field_name = "name"
    w.field_label = "Name"
    w.field_type = fitz.PDF_WIDGET_TYPE_TEXT
    w.rect = fitz.Rect(56, 480, 300, 500)
    w.field_value = ""
    fp.add_widget(w)
    cb = fitz.Widget()
    cb.field_name = "agree"
    cb.field_type = fitz.PDF_WIDGET_TYPE_CHECKBOX
    cb.rect = fitz.Rect(320, 480, 338, 498)
    fp.add_widget(cb)

    doc[10].set_rotation(90)
    doc.set_toc(toc)
    doc.set_page_labels([{"startpage": 0, "prefix": "", "style": "r", "firstpagenum": 1}, {"startpage": 2, "prefix": "", "style": "D", "firstpagenum": 1}])
    doc.set_metadata({"title": "YAPR sample document", "author": "YAPR test suite", "subject": "Sample", "keywords": "pdf, sample, test", "creator": "make-sample-pdfs.py"})
    doc.embfile_add("notes.txt", b"Attached file content\n", filename="notes.txt", desc="A small text attachment")
    doc.subset_fonts()
    doc.save(os.path.join(OUT, "sample.pdf"), garbage=3, deflate=True)


def make_large(pages=300):
    doc = fitz.open()
    image = gradient_pixmap(200, 120)
    for i in range(pages):
        page = doc.new_page(width=595, height=842)
        page.insert_text((56, 70), f"Large document page {i + 1}", fontsize=20)
        page.insert_textbox(fitz.Rect(56, 90, 539, 700), LOREM * 4, fontsize=10)
        if i % 3 == 0:
            page.insert_image(fitz.Rect(56, 700, 256, 820), pixmap=image)
    doc.set_toc([[1, f"Section {s + 1}", s * 30 + 1] for s in range(pages // 30)])
    doc.save(os.path.join(OUT, "large.pdf"), garbage=3, deflate=True)


def make_encrypted():
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 100), "This document is password protected (password: secret).", fontsize=14)
    doc.save(
        os.path.join(OUT, "encrypted.pdf"),
        encryption=fitz.PDF_ENCRYPT_AES_256,
        user_pw="secret",
        owner_pw="owner",
        permissions=fitz.PDF_PERM_PRINT | fitz.PDF_PERM_COPY | fitz.PDF_PERM_ANNOTATE,
    )


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    make_main()
    make_large(int(sys.argv[1]) if len(sys.argv) > 1 else 300)
    make_encrypted()
    print("samples written to", os.path.abspath(OUT))
