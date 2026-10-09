"""Generate the demo document used for the README screenshots (dev/samples/demo.pdf).

Requires PyMuPDF and Pillow:  pip install pymupdf pillow
Usage:                        python scripts/make-demo-pdf.py

Everything in the document (text, pictures, chart) is generated here, so the screenshots contain
no third-party content.
"""

import io
import math
import os
import random
import tempfile

import fitz  # PyMuPDF
from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = os.path.join(os.path.dirname(__file__), "..", "dev", "samples")
FONTS = os.path.join(os.environ.get("WINDIR", "C:\\Windows"), "Fonts")
random.seed(7)


# ---------------------------------------------------------------------------------- pictures


def night_sky(w=1600, h=900):
    """A starry sky over mountains with a moon, as a PNG."""
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        t = y / h
        r, g, b = int(8 + 40 * t), int(14 + 50 * t), int(40 + 90 * t)
        for x in range(w):
            px[x, y] = (r, g, b)
    d = ImageDraw.Draw(img)
    # Milky way glow
    glow = Image.new("L", (w, h), 0)
    gd = ImageDraw.Draw(glow)
    for i in range(160):
        x = int(w * 0.15 + i * w * 0.0045)
        y = int(h * 0.75 - i * h * 0.004)
        gd.ellipse((x - 90, y - 50, x + 90, y + 50), fill=18)
    glow = glow.filter(ImageFilter.GaussianBlur(40))
    img = Image.composite(Image.new("RGB", (w, h), (150, 140, 200)), img, glow)
    d = ImageDraw.Draw(img)
    for _ in range(1400):
        x, y = random.randrange(w), random.randrange(int(h * 0.8))
        s = random.choice([1, 1, 1, 1, 2, 2, 3])
        c = random.randint(170, 255)
        d.ellipse((x, y, x + s, y + s), fill=(c, c, min(255, c + 20)))
    # Moon
    d.ellipse((w * 0.76, h * 0.12, w * 0.76 + 110, h * 0.12 + 110), fill=(250, 240, 210))
    img = img.filter(ImageFilter.GaussianBlur(0.6))
    d = ImageDraw.Draw(img)
    # Mountains (two layers)
    for layer, (base, amp, col) in enumerate([(0.72, 90, (24, 30, 52)), (0.82, 60, (10, 12, 22))]):
        pts = [(0, h)]
        for x in range(0, w + 20, 20):
            y = h * base - amp * (0.5 + 0.5 * math.sin(x / (170 + layer * 60) + layer)) - random.randint(0, 18)
            pts.append((x, y))
        pts.append((w, h))
        d.polygon(pts, fill=col)
    return img


def sunset(w=1200, h=800):
    """A warm sunset over the sea."""
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        t = y / (h * 0.62)
        for x in range(w):
            if y < h * 0.62:
                px[x, y] = (int(250 - 60 * t), int(120 + 60 * (1 - t) * (1 - t) - 40 * t), int(90 + 80 * t))
            else:
                k = (y - h * 0.62) / (h * 0.38)
                px[x, y] = (int(150 - 90 * k), int(70 - 30 * k), int(110 - 40 * k))
    d = ImageDraw.Draw(img)
    d.ellipse((w * 0.42, h * 0.38, w * 0.58, h * 0.38 + w * 0.16), fill=(255, 214, 140))
    d.rectangle((0, h * 0.62, w, h), fill=None)
    for i in range(40):
        y = h * 0.64 + i * 7
        half = (40 - i) * 4 + 20
        d.line((w / 2 - half, y, w / 2 + half, y), fill=(255, 190, 120), width=2)
    return img.filter(ImageFilter.GaussianBlur(1.2))


def chart(w=1400, h=760):
    """Bar chart: average limiting magnitude per month."""
    img = Image.new("RGB", (w, h), "white")
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(os.path.join(FONTS, "Deng.ttf"), 30)
    small = ImageFont.truetype(os.path.join(FONTS, "Deng.ttf"), 26)
    left, top, right, bottom = 120, 70, w - 40, h - 90
    d.text((left, 10), "各月平均极限星等（城郊观测点）", fill=(30, 30, 60), font=font)
    for i in range(6):
        y = bottom - (bottom - top) * i / 5
        d.line((left, y, right, y), fill=(225, 228, 235), width=2)
        d.text((left - 60, y - 15), f"{3 + i * 0.5:.1f}", fill=(110, 110, 120), font=small)
    values = [4.6, 4.8, 5.1, 5.0, 4.4, 4.2, 4.1, 4.3, 4.9, 5.3, 5.4, 5.2]
    bw = (right - left) / len(values)
    for i, v in enumerate(values):
        x0 = left + i * bw + bw * 0.18
        x1 = left + (i + 1) * bw - bw * 0.18
        y = bottom - (bottom - top) * (v - 3) / 2.5
        col = (229, 72, 77) if v >= 5.2 else (70, 110, 200)
        d.rounded_rectangle((x0, y, x1, bottom), radius=8, fill=col)
        d.text(((x0 + x1) / 2 - 22, bottom + 14), f"{i + 1}月", fill=(80, 80, 90), font=small)
    return img


def png(img):
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=88)
    return buf.getvalue()


# ---------------------------------------------------------------------------------- document

CSS = """
@font-face { font-family: deng; src: url(Deng.ttf); }
@font-face { font-family: deng; src: url(Dengb.ttf); font-weight: bold; }
* { font-family: deng; }
body { font-size: 11pt; line-height: 1.75; color: #22242a; }
h1 { font-size: 22pt; color: #1d2b53; margin: 0 0 4pt 0; }
h2 { font-size: 15pt; color: #1d2b53; margin: 14pt 0 4pt 0; }
h3 { font-size: 12pt; color: #c0392b; margin: 10pt 0 2pt 0; }
p { text-align: justify; margin: 0 0 6pt 0; }
.lead { color: #555b66; font-size: 10.5pt; }
.caption { text-align: center; color: #6b7080; font-size: 9pt; margin-top: 2pt; }
table { border-collapse: collapse; width: 100%; font-size: 10pt; }
th { color: #1d2b53; border-bottom: 2px solid #1d2b53; padding: 4pt; text-align: left; }
td { border-bottom: 1px solid #d0d4dc; padding: 4pt; }
.note { border-left: 3pt solid #4a6ed0; padding: 6pt; color: #33415c; }
"""

SECTIONS = [
    ("1. 为什么要记录夜空亮度", [
        "城市的灯光让夜空变得越来越亮。对于业余天文爱好者来说，天空亮度直接决定了一晚能看到多少颗星：在光污染严重的市中心，肉眼往往只能看到几十颗亮星；而在远离城市的山区，银河清晰可见，肉眼可见的恒星超过两千颗。",
        "本手册整理了一年来在城郊观测点的记录方法和结果，希望帮助更多人用简单的工具持续记录身边的夜空，并把数据分享给社区。持续、规范的记录比单次的“好天气”更有价值。",
    ]),
    ("2. 观测前的准备", [
        "观测之前，需要让眼睛适应黑暗至少二十分钟。期间避免查看手机屏幕；如果必须使用，请把屏幕调到最暗并开启红光模式。记录本、红光手电和一张简易星图就足以完成大部分工作。",
        "选择观测时间时，应尽量避开满月前后一周，并在天文昏影终之后开始记录。每次记录都要写下时间、地点、云量、湿度和月相，这些信息决定了数据之后能否互相比较。",
    ]),
    ("3. 极限星等的估计方法", [
        "极限星等是指在当前条件下肉眼能看到的最暗恒星的星等，数值越大，代表夜空越暗、条件越好。最常用的方法是选择一个已知星等的天区，数出其中能看到的恒星数量，再对照参考表换算。",
        "为了减少主观误差，建议每次选取同样的两个天区，各计数三次取平均值。记录结果时保留一位小数即可，过于精确的数字反而会给人错误的信心。",
    ]),
]

SECTIONS_2 = [
    ("4. 一年的观测结果", [
        "下图汇总了十二个月的平均极限星等。秋冬季节空气干燥、透明度高，平均极限星等明显高于夏季；夏季湿度大，加上节假日夜间照明增加，天空背景偏亮。",
    ]),
    ("5. 拍摄夜空照片", [
        "如果有一台可以手动设置的相机，就能把肉眼看不到的暗星也记录下来。推荐使用广角镜头、最大光圈，曝光时间不超过“500 ÷ 焦距”秒，以免星点拖成短线。把相机固定在三脚架上，并使用两秒延时快门避免按动快门时的抖动。",
        "照片同样可以用于估计天空亮度：在相同参数下拍摄同一天区，比较背景的平均亮度，就能看出不同夜晚之间的差异。",
    ]),
]

TABLE = [
    ("观测点", "海拔", "平均极限星等", "最佳月份"),
    ("市中心公园", "45 m", "3.6", "11 月"),
    ("城郊观测点", "180 m", "4.8", "10 月"),
    ("水库大坝", "320 m", "5.5", "12 月"),
    ("山顶营地", "1 260 m", "6.4", "1 月"),
]


def section_html(sections):
    out = []
    for title, paras in sections:
        out.append(f"<h2>{title}</h2>")
        out.extend(f"<p>{p}</p>" for p in paras)
    return "".join(out)


def story_pages(doc, html, archive, rect=fitz.Rect(64, 64, 531, 790)):
    """Lay out `html` on new A4 pages appended to `doc`; returns those pages."""
    story = fitz.Story(html=html, user_css=CSS, archive=archive)
    buf = io.BytesIO()
    writer = fitz.DocumentWriter(buf)
    more = True
    while more:
        dev = writer.begin_page(fitz.Rect(0, 0, 595, 842))
        more, _ = story.place(rect)
        story.draw(dev)
        writer.end_page()
    writer.close()
    first = doc.page_count
    doc.insert_pdf(fitz.open("pdf", buf.getvalue()))
    return [doc[i] for i in range(first, doc.page_count)]


def main():
    os.makedirs(OUT, exist_ok=True)
    archive = fitz.Archive(FONTS)
    sky, sea, bars = night_sky(), sunset(), chart()
    doc = fitz.open()

    # Cover
    cover = doc.new_page(width=595, height=842)
    cover.insert_image(fitz.Rect(0, 0, 595, 520), stream=png(sky.crop((150, 0, 1450, 1137 * 900 // 1137))), keep_proportion=False)
    cover.insert_font(fontname="deng", fontfile=os.path.join(FONTS, "Deng.ttf"))
    cover.insert_font(fontname="dengb", fontfile=os.path.join(FONTS, "Dengb.ttf"))
    cover.insert_text((56, 590), "城市夜空观测手册", fontsize=34, fontname="dengb", color=(0.11, 0.17, 0.33))
    cover.insert_text((56, 622), "A Field Guide to Urban Night Skies", fontsize=15, fontname="deng", color=(0.42, 0.44, 0.5))
    cover.draw_line((56, 645), (200, 645), color=(0.9, 0.28, 0.3), width=3)
    cover.insert_textbox(
        fitz.Rect(56, 660, 540, 760),
        "记录方法 · 一年的观测数据 · 夜空摄影入门\n本文档由 YetAnotherPDFReader 项目生成，用于界面演示。",
        fontsize=11.5, fontname="deng", color=(0.3, 0.32, 0.38), lineheight=1.6,
    )
    cover.insert_text((56, 800), "2026 年版", fontsize=10, fontname="deng", color=(0.5, 0.5, 0.55))

    # Body: pictures are part of the HTML flow (served from a temporary folder).
    pics = tempfile.mkdtemp(prefix="yapr-demo-")
    for name, img in (("sky.jpg", sky), ("sea.jpg", sea), ("chart.jpg", bars)):
        with open(os.path.join(pics, name), "wb") as f:
            f.write(png(img))
    archive.add(pics)
    rows = "".join(
        ("<tr>" + "".join(f"<th>{c}</th>" for c in r) + "</tr>") if i == 0 else ("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>")
        for i, r in enumerate(TABLE)
    )
    html = (
        "<h1>城市夜空观测手册</h1><p class='lead'>用肉眼、一支红光手电和一本记录本，持续记录身边的夜空。</p>"
        + section_html(SECTIONS[:2])
        + "<img src='sky.jpg' width='467'/><p class='caption'>图 1  山区观测点的夜空（生成图像）</p>"
        + section_html(SECTIONS[2:])
        + "<p class='note'>小提示：每次观测结束后当天整理记录，并拍下记录本的照片备份，可以避免数据丢失。</p>"
        + section_html(SECTIONS_2[:1])
        + "<img src='chart.jpg' width='467'/><p class='caption'>图 2  各月平均极限星等</p>"
        + f"<h3>各观测点对比</h3><table>{rows}</table>"
        + section_html(SECTIONS_2[1:])
        + "<img src='sea.jpg' width='400'/><p class='caption'>图 3  海边的日落（生成图像）</p>"
    )
    body = story_pages(doc, html, archive)

    for i, p in enumerate(doc):
        if i:
            p.insert_font(fontname="deng", fontfile=os.path.join(FONTS, "Deng.ttf"))
            p.insert_text((290, 820), str(i + 1), fontsize=9, fontname="deng", color=(0.5, 0.5, 0.55))

    toc = [[1, "封面", 1]]
    for title, _ in SECTIONS + SECTIONS_2:
        for page in body:
            if page.search_for(title):
                toc.append([1, title, page.number + 1])
                break
    doc.set_toc(toc)
    doc.set_metadata({"title": "城市夜空观测手册", "author": "YetAnotherPDFReader", "subject": "Demo document", "creator": "make-demo-pdf.py"})
    doc.subset_fonts()
    path = os.path.join(OUT, "demo.pdf")
    doc.save(path, garbage=3, deflate=True)
    print(path, doc.page_count, "pages")


if __name__ == "__main__":
    main()
