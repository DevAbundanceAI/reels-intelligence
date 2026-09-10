#!/usr/bin/env python3
"""Ryan Frost LinkedIn carousel renderer.

Forks content-engine/render_slides.py: same 1080x1350 dark/cream/red-gradient
Abundance/Ryan brand system (same fonts, same gradient machinery), but
re-skinned for Ryan's personal profile — a "Ryan Frost" nameplate instead of
the Abundance wordmark, an itsryanfrost.com footer instead of carousel dots,
and a `signoff` slide (name + site, no ask) instead of `cta`. Also emits a
multi-page PDF, because LinkedIn removed native multi-image carousels —
a PDF document post is the only way to get a swipeable carousel there.

Design lives HERE, in templates. Claude only writes copy
(linkedin-engine/generate-posts.js) — it never chooses colors, fonts, or
layout. New looks = new template functions, iterated with Ryan, then frozen.

Usage:
  python3 linkedin-engine/render_deck.py --deck linkedin-engine/queue/deck-<slug>.json [--out linkedin-engine/output/<dir>]
"""

import argparse
import json
import sys
from pathlib import Path

ENGINE = Path(__file__).resolve().parent
CONTENT_ENGINE = ENGINE.parent / "content-engine"
sys.path.insert(0, str(CONTENT_ENGINE))
import render_slides as rs  # noqa: E402  (the module we re-skin)

from PIL import Image, ImageDraw

SITE = "itsryanfrost.com"
NAME = "Ryan Frost"

MIN_SLIDES, MAX_SLIDES = 6, 10
MAX_PDF_BYTES = 4_900_000  # Airtable's 5MB attachment cap, with headroom


# ── re-skin: nameplate replaces the Abundance wordmark ──────────────────────

def ryan_base_slide():
    """Black ground + hairline frame + 'Ryan Frost' nameplate (gradient dot
    + name), replacing render_slides.base_slide's Abundance wordmark."""
    img = Image.new("RGB", (rs.W, rs.H), rs.BG)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, rs.W - 1, rs.H - 1], outline=rs.HAIRLINE, width=1)
    r = 9
    y = rs.M + 12
    rs.gradient_rect(img, (rs.M, y, rs.M + 2 * r, y + 2 * r), radius=r)
    f = rs.semi_font(34)
    d.text((rs.M + 2 * r + 16, rs.M), NAME, font=f, fill=rs.CREAM)
    return img


def ryan_footer(img, i, total, arrow=True):
    """Footer: itsryanfrost.com (left) + n / N (right) + a thin gradient
    progress bar, replacing render_slides.draw_dots's dot row. `arrow` is
    accepted for call-signature compatibility with every RENDERERS caller
    but unused — the progress bar is the swipe affordance here."""
    d = ImageDraw.Draw(img)
    f = rs.semi_font(28)
    y_text = rs.H - 108
    d.text((rs.M, y_text), SITE, font=f, fill=rs.MUTED)
    counter = f"{i} / {total}"
    cw, _ = rs.measure(d, counter, f)
    d.text((rs.W - rs.M - cw, y_text), counter, font=f, fill=rs.MUTED)
    bar_y, bar_h = rs.H - 66, 4
    d.rounded_rectangle([rs.M, bar_y, rs.W - rs.M, bar_y + bar_h], radius=2, fill=rs.HAIRLINE)
    filled_w = int(rs.CW * (i / total))
    if filled_w > 0:
        rs.gradient_rect(img, (rs.M, bar_y, rs.M + filled_w, bar_y + bar_h), radius=2)


# Python resolves `base_slide()` / `draw_dots()` calls inside hook_slide,
# point_slide, etc. against the render_slides MODULE namespace at call time
# (not def time), so patching these two module attributes re-skins every
# existing slide type below without copying their bodies.
rs.base_slide = ryan_base_slide
rs.draw_dots = ryan_footer


# ── new slide types: signoff (replaces cta), stat, before_after ─────────────

def signoff_slide(s, i, total):
    """Closing slide: optional one-line wrap, then the name (Frost in the
    serif gradient) and the site. No ask — this batch runs with zero CTAs."""
    img = rs.base_slide()
    y = 420
    if s.get("headline"):
        y = rs.draw_block(img, s["headline"], rs.body_font(40), rs.M, y, rs.CW, rs.BODY, gap=1.3)
        y += 70
    else:
        y += 40
    y = rs.draw_rich_block(img, NAME, "Frost", rs.M, y, rs.CW, 120)
    d = ImageDraw.Draw(img)
    d.text((rs.M, y + 24), SITE, font=rs.semi_font(40), fill=rs.CREAM)
    rs.draw_dots(img, i, total, arrow=False)
    return img


def stat_slide(s, i, total):
    """One huge gradient number + a label. For receipts (totals, durations)."""
    img = rs.base_slide()
    y = 300
    if s.get("eyebrow"):
        y = rs.eyebrow(img, s["eyebrow"], rs.M, y) + 40
    d = ImageDraw.Draw(img)
    value = s.get("value", "")
    vf = rs.head_font(148)
    rs.gradient_text(img, (rs.M, y), value, vf)
    _, vh = rs.measure(d, value, vf)
    y += int(vh * 1.25)
    if s.get("label"):
        rs.draw_block(img, s["label"], rs.body_font(44), rs.M, y, rs.CW, rs.BODY, gap=1.3)
    rs.draw_dots(img, i, total)
    return img


def before_after_slide(s, i, total):
    """Two surface cards side by side: Before items, After items."""
    img = rs.base_slide()
    y = 260
    if s.get("headline"):
        y = rs.draw_rich_block(img, s["headline"], s.get("emphasis"), rs.M, y, rs.CW, 60) + 40
    d = ImageDraw.Draw(img)
    col_w = (rs.CW - 40) // 2
    panel_top, panel_bot = y, rs.H - 220
    x2 = rs.M + col_w + 40
    d.rounded_rectangle([rs.M, panel_top, rs.M + col_w, panel_bot], radius=20,
                        outline=rs.HAIRLINE, width=1, fill=rs.SURFACE)
    d.rounded_rectangle([x2, panel_top, x2 + col_w, panel_bot], radius=20,
                        outline=rs.HAIRLINE, width=1, fill=rs.SURFACE)

    def fill_panel(x0, label, items, accent):
        py = panel_top + 32
        d.text((x0 + 28, py), label.upper(), font=rs.bold_font(30), fill=accent)
        py += 56
        itf = rs.body_font(32)
        for it in items:
            py = rs.draw_block(img, "- " + it, itf, x0 + 28, py, col_w - 56, rs.BODY, gap=1.25) + 18

    before = s.get("before", {}) or {}
    after = s.get("after", {}) or {}
    fill_panel(rs.M, before.get("label", "Before"), before.get("items", []), rs.MUTED)
    fill_panel(x2, after.get("label", "After"), after.get("items", []), rs.RED)
    rs.draw_dots(img, i, total)
    return img


rs.RENDERERS = {**rs.RENDERERS, "signoff": signoff_slide, "stat": stat_slide, "before_after": before_after_slide}
rs.RENDERERS.pop("cta", None)  # not a valid LinkedIn-profile slide type


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--deck", required=True)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    deck = json.loads(Path(args.deck).read_text())
    slides = deck.get("slides", [])
    if not slides:
        sys.exit("Deck has no slides")
    if not (MIN_SLIDES <= len(slides) <= MAX_SLIDES):
        sys.exit(f"Deck has {len(slides)} slides — need {MIN_SLIDES}-{MAX_SLIDES} for a LinkedIn document post. Regenerate.")
    if slides[0].get("type") != "hook":
        sys.exit("Slide 1 must be type 'hook'")
    if slides[-1].get("type") != "signoff":
        sys.exit("Last slide must be type 'signoff'")

    slug = deck.get("slug") or deck.get("id") or "deck"
    out_dir = Path(args.out) if args.out else ENGINE / "output" / slug
    out_dir.mkdir(parents=True, exist_ok=True)

    total = len(slides)
    written, imgs = [], []
    for idx, s in enumerate(slides, 1):
        fn = rs.RENDERERS.get(s.get("type"))
        if not fn:
            sys.exit(f"Unknown slide type: {s.get('type')} (valid: {sorted(rs.RENDERERS)})")
        img = fn(s, idx, total).convert("RGB")
        p = out_dir / f"{slug}-{idx:02d}.jpg"
        img.save(p, "JPEG", quality=90)
        written.append(str(p))
        imgs.append(img)
        print(f"wrote {p}")

    pdf_path = out_dir / f"{slug}.pdf"
    quality = 85
    while True:
        imgs[0].save(pdf_path, "PDF", save_all=True, append_images=imgs[1:],
                     resolution=72.0, quality=quality)
        size = pdf_path.stat().st_size
        if size <= MAX_PDF_BYTES or quality <= 40:
            break
        quality -= 10
        print(f"PDF {size/1e6:.2f}MB over the Airtable cap, re-saving at quality {quality}")

    size = pdf_path.stat().st_size
    if size > MAX_PDF_BYTES:
        sys.exit(f"PDF still {size/1e6:.2f}MB after quality reduction to {quality} — trim slide count or content.")
    print(f"wrote {pdf_path} ({size/1024:.0f}KB, {len(imgs)} pages, 1080x1350 pt)")

    manifest = {
        "slug": slug, "slides": written, "pdf": str(pdf_path),
        "pdfBytes": size, "pages": len(imgs), "deck": str(args.deck),
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"done — {len(written)} slides + PDF in {out_dir}")


if __name__ == "__main__":
    main()
