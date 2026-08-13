#!/usr/bin/env python3
"""Abundance carousel slide renderer.

Turns a deck JSON (from generate-carousel.js) into finished 1080x1350 JPEGs
in the Abundance brand system: near-black ground, cream ink, the signature
red gradient on emphasis words / numbers / bars, serif-italic accent type,
real wordmark rasterized from the brand SVG.

Design lives HERE, in templates — the generator only writes copy. Ported
from the proven EH social-engine renderer (wrap/measure/dots mechanics).

Usage:
  python content-engine/render_slides.py --deck queue/deck-<slug>.json [--out output/<dir>]
"""

import argparse
import json
import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ENGINE = Path(__file__).resolve().parent
ASSETS = ENGINE / "assets"
FONTS = ENGINE / "fonts"

W, H = 1080, 1350
M = 96                      # page margin
CW = W - 2 * M              # content width

# ── Abundance brand tokens (dark-locked; source: Oren proposal / itsryanfrost.com) ──
BG      = (10, 10, 10)      # #0A0A0A
SURFACE = (20, 20, 20)      # #141414
CREAM   = (245, 240, 232)   # #F5F0E8 ink
BODY    = (201, 194, 181)   # #C9C2B5
MUTED   = (128, 122, 112)   # #807A70
HAIRLINE = (38, 38, 38)     # rgba(255,255,255,.08) on black ≈ #262626

GRAD_STOPS = [               # signature red gradient, 3 stops
    (0.00, (255, 87, 51)),   # #FF5733
    (0.40, (237, 28, 36)),   # #ED1C24
    (0.85, (179, 14, 20)),   # #B30E14
    (1.00, (179, 14, 20)),
]
RED = (237, 28, 36)


def first_font(candidates, size):
    for c in candidates:
        p = Path(c)
        if p.exists():
            return ImageFont.truetype(str(p), size)
    raise SystemExit(f"No usable font found in: {candidates}")


HEAD_TTF  = [FONTS / "InterDisplay-ExtraBold.ttf", FONTS / "Inter-Bold.ttf",
             "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"]
BOLD_TTF  = [FONTS / "Inter-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"]
BODY_TTF  = [FONTS / "Inter-Medium.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]
SEMI_TTF  = [FONTS / "Inter-SemiBold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"]
SERIF_TTF = [FONTS / "LiberationSerif-BoldItalic.ttf",
             "/usr/share/fonts/truetype/liberation/LiberationSerif-BoldItalic.ttf",
             "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf"]


def head_font(s):  return first_font(HEAD_TTF, s)
def bold_font(s):  return first_font(BOLD_TTF, s)
def body_font(s):  return first_font(BODY_TTF, s)
def semi_font(s):  return first_font(SEMI_TTF, s)
def serif_font(s): return first_font(SERIF_TTF, int(s * 1.06))  # optical match to Inter


# ── gradient machinery ────────────────────────────────────────────────────────

def gradient(w, h):
    """Left-to-right red gradient strip (the brand's 135deg reads fine as horizontal at slide scale)."""
    if w < 1: w = 1
    if h < 1: h = 1
    strip = Image.new("RGB", (w, 1))
    for x in range(w):
        t = x / max(1, w - 1)
        for i in range(len(GRAD_STOPS) - 1):
            t0, c0 = GRAD_STOPS[i]
            t1, c1 = GRAD_STOPS[i + 1]
            if t0 <= t <= t1:
                k = 0 if t1 == t0 else (t - t0) / (t1 - t0)
                col = tuple(int(c0[j] + (c1[j] - c0[j]) * k) for j in range(3))
                break
        strip.putpixel((x, 0), col)
    return strip.resize((w, h))


def gradient_text(img, xy, text, fnt):
    """Draw text filled with the brand gradient (via alpha mask)."""
    d = ImageDraw.Draw(img)
    box = d.textbbox(xy, text, font=fnt)
    w, h = box[2] - box[0], box[3] - box[1]
    if w <= 0 or h <= 0:
        return
    mask = Image.new("L", (w + 4, h + 4), 0)
    ImageDraw.Draw(mask).text((2 - (box[0] - xy[0]), 2 - (box[1] - xy[1])), text, font=fnt, fill=255)
    img.paste(gradient(mask.width, mask.height), (box[0] - 2, box[1] - 2), mask)


def gradient_rect(img, box, radius=0):
    x0, y0, x1, y1 = [int(v) for v in box]
    w, h = x1 - x0, y1 - y0
    if w <= 0 or h <= 0:
        return
    grad = gradient(w, h)
    if radius:
        mask = Image.new("L", (w, h), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, h - 1], radius=radius, fill=255)
        img.paste(grad, (x0, y0), mask)
    else:
        img.paste(grad, (x0, y0))


# ── text layout ───────────────────────────────────────────────────────────────

def measure(d, t, f):
    b = d.textbbox((0, 0), t, font=f)
    return b[2] - b[0], b[3] - b[1]


def line_h(f, gap=1.12):
    asc, desc = f.getmetrics()
    return int((asc + desc) * gap)


def wrap_words(d, words, fonts, maxw):
    """Wrap (word, font) pairs into lines that fit maxw. Returns list of lines."""
    space = measure(d, " ", fonts[0])[0]
    lines, cur, cur_w = [], [], 0
    for word, fnt in words:
        w = measure(d, word, fnt)[0]
        add = w if not cur else w + space
        if cur and cur_w + add > maxw:
            lines.append(cur)
            cur, cur_w = [(word, fnt)], w
        else:
            cur.append((word, fnt))
            cur_w += add
    if cur:
        lines.append(cur)
    return lines


def draw_rich_block(img, text, emphasis, x, y, maxw, size, gap=1.08, align="left"):
    """Headline block: normal words in ExtraBold cream, the emphasis phrase in
    serif bold-italic filled with the brand gradient."""
    d = ImageDraw.Draw(img)
    hf, sf = head_font(size), serif_font(size)

    emph_words = set()
    if emphasis:
        # mark the emphasis phrase's word positions in the headline
        toks = text.split()
        etoks = emphasis.split()
        for i in range(len(toks) - len(etoks) + 1):
            window = [t.strip(".,!?:;\"'()") for t in toks[i:i + len(etoks)]]
            target = [t.strip(".,!?:;\"'()") for t in etoks]
            if [w.lower() for w in window] == [w.lower() for w in target]:
                emph_words.update(range(i, i + len(etoks)))
                break

    words = [(w, sf if i in emph_words else hf) for i, w in enumerate(text.split())]
    lh = line_h(hf, gap)
    space = measure(d, " ", hf)[0]

    for line in wrap_words(d, words, [hf], maxw):
        total = sum(measure(d, w, f)[0] for w, f in line) + space * (len(line) - 1)
        cx = x if align == "left" else x + (maxw - total) // 2
        for w, f in line:
            if f is sf:
                gradient_text(img, (cx, y), w, f)
            else:
                d.text((cx, y), w, font=f, fill=CREAM)
            cx += measure(d, w, f)[0] + space
        y += lh
    return y


def draw_block(img, text, fnt, x, y, maxw, fill, gap=1.16):
    d = ImageDraw.Draw(img)
    lh = line_h(fnt, gap)
    words = text.split()
    space = measure(d, " ", fnt)[0]
    cur, cur_w = [], 0
    lines = []
    for w in words:
        ww = measure(d, w, fnt)[0]
        add = ww if not cur else ww + space
        if cur and cur_w + add > maxw:
            lines.append(" ".join(cur)); cur, cur_w = [w], ww
        else:
            cur.append(w); cur_w += add
    if cur:
        lines.append(" ".join(cur))
    for ln in lines:
        d.text((x, y), ln, font=fnt, fill=fill)
        y += lh
    return y


def block_height(img, text, fnt, maxw, gap=1.16):
    d = ImageDraw.Draw(img)
    space = measure(d, " ", fnt)[0]
    cur_w, n = 0, 1
    first = True
    for w in text.split():
        ww = measure(d, w, fnt)[0]
        add = ww if first else ww + space
        if not first and cur_w + add > maxw:
            n += 1; cur_w = ww
        else:
            cur_w += add
        first = False
    return n * line_h(fnt, gap)


# ── furniture ─────────────────────────────────────────────────────────────────

_wordmark = None

def wordmark(color):
    """Rasterize the Abundance wordmark SVG once, recolor by alpha."""
    global _wordmark
    if _wordmark is None:
        svg = ASSETS / "abundance-wordmark.svg"
        try:
            import cairosvg, io
            png = cairosvg.svg2png(url=str(svg), output_width=1400,
                                   background_color="rgba(0,0,0,0)")
            _wordmark = Image.open(io.BytesIO(png)).convert("RGBA")
        except Exception as e:
            print(f"WARN: wordmark SVG rasterization failed ({e}) — falling back to typed mark")
            f = head_font(72)
            tmp = Image.new("RGBA", (900, 110), (0, 0, 0, 0))
            ImageDraw.Draw(tmp).text((0, 0), "ABUNDANCE", font=f, fill=(255, 255, 255, 255))
            _wordmark = tmp
    out = Image.new("RGBA", _wordmark.size, color + (0,))
    out.putalpha(_wordmark.getchannel("A"))
    return out


def paste_wordmark(img, color, height, xy=None, center=False):
    wm = wordmark(color)
    r = height / wm.height
    wm = wm.resize((max(1, int(wm.width * r)), height), Image.LANCZOS)
    x = (W - wm.width) // 2 if center else (xy[0] if xy else M)
    y = xy[1] if xy else M
    img.paste(wm, (x, y), wm)


def eyebrow(img, text, x, y):
    """Pill label: glowing gradient dot + uppercase letterspaced text."""
    d = ImageDraw.Draw(img)
    f = bold_font(30)
    label = " ".join(list(text.upper()))  # letterspacing
    r = 9
    gradient_rect(img, (x, y + 4, x + 2 * r, y + 4 + 2 * r), radius=r)
    d.text((x + 2 * r + 18, y), label, font=f, fill=MUTED)
    return y + 52


def draw_arrow(d, x, yc, length, color, head=9, width=4):
    d.line([(x, yc), (x + length, yc)], fill=color, width=width)
    d.polygon([(x + length, yc - head), (x + length + head, yc), (x + length, yc + head)], fill=color)


def draw_dots(img, i, total, arrow=True):
    d = ImageDraw.Draw(img)
    r, gap = 7, 28
    total_w = (total - 1) * gap
    cx0 = (W - total_w) // 2
    y = H - 78
    for k in range(total):
        x = cx0 + k * gap
        if (k + 1) == i:
            gradient_rect(img, (x - r, y - r, x + r, y + r), radius=r)
        else:
            d.ellipse([x - r, y - r, x + r, y + r], fill=HAIRLINE)
    if arrow:
        draw_arrow(d, cx0 + total_w + 34, y, 22, MUTED)


def base_slide():
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W - 1, H - 1], outline=HAIRLINE, width=1)
    paste_wordmark(img, CREAM, 42, (M, 96))
    return img


# ── slide types ───────────────────────────────────────────────────────────────

def hook_slide(s, i, total):
    img = base_slide()
    y = 300
    if s.get("eyebrow"):
        y = eyebrow(img, s["eyebrow"], M, y) + 26
    size = 96 if len(s["headline"]) < 60 else 80
    hb = block_height(img, s["headline"], head_font(size), CW, gap=1.08)
    y = max(y, (H - hb) // 2 - 110)
    y = draw_rich_block(img, s["headline"], s.get("emphasis"), M, y, CW, size)
    if s.get("sub"):
        y = draw_block(img, s["sub"], body_font(40), M, y + 34, CW, BODY)
    d = ImageDraw.Draw(img)
    f = semi_font(36)
    label = "Swipe"
    d.text((M, y + 52), label, font=f, fill=CREAM)
    draw_arrow(d, M + measure(d, label, f)[0] + 16, y + 52 + 22, 28, RED)
    draw_dots(img, i, total)
    return img


def point_slide(s, i, total):
    img = base_slide()
    y = 260
    n = s.get("number")
    if n:
        r = 56
        cx, cy = M + r, y + r
        gradient_rect(img, (cx - r, cy - r, cx + r, cy + r), radius=r)
        d = ImageDraw.Draw(img)
        f = head_font(56)
        tw, th = measure(d, str(n), f)
        d.text((cx - tw / 2, cy - th / 2 - 8), str(n), font=f, fill=CREAM)
        y += 2 * r + 56
    if s.get("eyebrow"):
        y = eyebrow(img, s["eyebrow"], M, y) + 20
    y = draw_rich_block(img, s["headline"], s.get("emphasis"), M, y, CW, 72)
    if s.get("body"):
        draw_block(img, s["body"], body_font(42), M, y + 40, CW, BODY, gap=1.3)
    draw_dots(img, i, total)
    return img


def list_slide(s, i, total):
    img = base_slide()
    y = 260
    if s.get("eyebrow"):
        y = eyebrow(img, s["eyebrow"], M, y) + 20
    y = draw_rich_block(img, s["headline"], s.get("emphasis"), M, y, CW, 64) + 44
    d = ImageDraw.Draw(img)
    f = semi_font(42)
    for item in s.get("items", []):
        gradient_rect(img, (M, y + 14, M + 16, y + 30), radius=8)
        y = draw_block(img, item, f, M + 44, y, CW - 44, CREAM, gap=1.2) + 26
    draw_dots(img, i, total)
    return img


def quote_slide(s, i, total):
    img = base_slide()
    d = ImageDraw.Draw(img)
    quote = f"“{s['quote']}”"
    f = serif_font(64)
    panel_top = 300
    qh = block_height(img, quote, f, CW - 80, gap=1.22)
    panel_bot = min(H - 220, panel_top + qh + 200)
    d.rounded_rectangle([M - 24, panel_top, W - M + 24, panel_bot], radius=24,
                        fill=SURFACE, outline=HAIRLINE, width=1)
    gradient_rect(img, (M - 24, panel_top + 24, M - 16, panel_bot - 24), radius=4)
    y = panel_top + 84
    y = draw_block(img, quote, f, M + 40, y, CW - 80, CREAM, gap=1.22)
    if s.get("attribution"):
        draw_block(img, s["attribution"], bold_font(34), M + 40, y + 36, CW - 80, MUTED)
    draw_dots(img, i, total)
    return img


def chart_slide(s, i, total):
    img = base_slide()
    y = 240
    if s.get("eyebrow"):
        y = eyebrow(img, s["eyebrow"], M, y) + 16
    y = draw_rich_block(img, s["headline"], s.get("emphasis"), M, y, CW, 60) + 40
    chart = s.get("chart") or {}
    bottom = H - 240
    draw_chart(img, chart, (M, y, W - M, bottom))
    if s.get("insight"):
        draw_block(img, s["insight"], body_font(36), M, bottom + 36, CW, BODY)
    draw_dots(img, i, total)
    return img


def draw_chart(img, chart, box):
    """Brand-styled chart drawn directly with PIL. kinds: bar, line."""
    d = ImageDraw.Draw(img)
    x0, y0, x1, y1 = box
    labels = [str(l) for l in chart.get("labels", [])]
    values = [float(v) for v in chart.get("values", [])]
    if not labels or not values or len(labels) != len(values):
        d.text((x0, y0), "chart data missing", font=body_font(36), fill=MUTED)
        return
    unit = chart.get("unit", "")
    vmax = max(values) or 1
    label_f, value_f = semi_font(30), bold_font(34)
    axis_y = y1 - 56  # room for labels
    d.line([(x0, axis_y), (x1, axis_y)], fill=HAIRLINE, width=2)

    if chart.get("kind") == "line":
        n = len(values)
        step = (x1 - x0 - 40) / max(1, n - 1)
        pts = [(x0 + 20 + k * step,
                axis_y - (values[k] / vmax) * (axis_y - y0 - 60)) for k in range(n)]
        for a, b in zip(pts, pts[1:]):
            d.line([a, b], fill=RED, width=6)
        for k, (px, py) in enumerate(pts):
            gradient_rect(img, (px - 10, py - 10, px + 10, py + 10), radius=10)
            vt = f"{values[k]:g}{unit}"
            tw, _ = measure(d, vt, value_f)
            d.text((px - tw / 2, py - 58), vt, font=value_f, fill=CREAM)
            tw, _ = measure(d, labels[k], label_f)
            d.text((px - tw / 2, axis_y + 16), labels[k], font=label_f, fill=MUTED)
        return

    # default: bar
    n = len(values)
    slot = (x1 - x0) / n
    bar_w = min(150, int(slot * 0.56))
    for k, v in enumerate(values):
        cx = x0 + slot * k + slot / 2
        bh = (v / vmax) * (axis_y - y0 - 70)
        top = axis_y - bh
        gradient_rect(img, (cx - bar_w / 2, top, cx + bar_w / 2, axis_y), radius=10)
        vt = f"{v:g}{unit}"
        tw, _ = measure(d, vt, value_f)
        d.text((cx - tw / 2, top - 50), vt, font=value_f, fill=CREAM)
        tw, _ = measure(d, labels[k], label_f)
        d.text((cx - tw / 2, axis_y + 16), labels[k], font=label_f, fill=MUTED)


def cta_slide(s, i, total):
    img = base_slide()
    y = 460
    y = draw_rich_block(img, s["headline"], s.get("emphasis"), M, y, CW, 88)
    gradient_rect(img, (M, y + 30, M + 180, y + 40), radius=5)
    if s.get("body"):
        draw_block(img, s["body"], body_font(44), M, y + 90, CW, BODY, gap=1.3)
    draw_dots(img, i, total, arrow=False)
    return img


RENDERERS = {
    "hook": hook_slide, "point": point_slide, "list": list_slide,
    "quote": quote_slide, "chart": chart_slide, "cta": cta_slide,
}


def render_chart_overlay(chart, out_path):
    """Standalone transparent chart PNG for video overlays."""
    ow, oh = 2000, 1200
    img = Image.new("RGBA", (ow, oh), (0, 0, 0, 0))
    draw_chart(img, chart, (80, 80, ow - 80, oh - 80))
    img.save(out_path, "PNG")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--deck", required=True)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    deck = json.loads(Path(args.deck).read_text())
    slides = deck.get("slides", [])
    if not slides:
        sys.exit("Deck has no slides")
    if len(slides) > 5:
        sys.exit(f"Deck has {len(slides)} slides — max 5 (VistaSocial rail cap). Regenerate.")

    slug = deck.get("slug", "deck")
    out_dir = Path(args.out) if args.out else ENGINE / "output" / slug
    out_dir.mkdir(parents=True, exist_ok=True)

    total = len(slides)
    written = []
    for idx, s in enumerate(slides, 1):
        fn = RENDERERS.get(s.get("type"))
        if not fn:
            sys.exit(f"Unknown slide type: {s.get('type')}")
        img = fn(s, idx, total)
        p = out_dir / f"{slug}-{idx:02d}.jpg"
        img.convert("RGB").save(p, "JPEG", quality=90)
        written.append(str(p))
        print(f"wrote {p}")
        if s.get("type") == "chart" and s.get("chart"):
            op = out_dir / f"{slug}-chart-{idx:02d}.png"
            render_chart_overlay(s["chart"], op)
            print(f"wrote {op} (video overlay)")

    manifest = {"slug": slug, "slides": written, "deck": str(args.deck)}
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"done — {len(written)} slides in {out_dir}")


if __name__ == "__main__":
    main()
