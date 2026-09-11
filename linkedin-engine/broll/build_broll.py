#!/usr/bin/env python3
"""Before/after and ground-up-build B-roll videos from REAL product screenshots.
No synthetic/AI-generated imagery — the point is proof, so every frame traces
back to an actual screenshot captured in capture.py. Reuses the exact brand
rendering toolkit (gradient, fonts, nameplate) proven in render_deck.py."""
import sys, subprocess, shutil, math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

HERE = Path(__file__).parent
CONTENT_ENGINE = HERE.parent.parent / "content-engine"
sys.path.insert(0, str(CONTENT_ENGINE))
import render_slides as rs  # noqa: E402

SHOTS = HERE / "shots"
FRAMES = HERE / "frames"
CLIPS = HERE / "clips"
W, H = 1080, 1350
FPS = 30
SITE = "itsryanfrost.com"
NAME = "Ryan Frost"


def ease_in_out(t):
    return t * t * (3 - 2 * t)


def vignette_overlay():
    """Precompute once: soft dark gradient top+bottom so white text stays legible over any screenshot."""
    ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    px = ov.load()
    top_h, bot_h = 210, 340
    for y in range(top_h):
        a = int(190 * (1 - y / top_h) ** 1.4)
        for x in range(0, W, 1):
            px[x, y] = (0, 0, 0, a)
    for y in range(bot_h):
        a = int(215 * (1 - (bot_h - y) / bot_h) ** 0.7) if y > 0 else 0
        yy = H - bot_h + y
        for x in range(0, W, 1):
            px[x, yy] = (0, 0, 0, a)
    return ov


VIGNETTE = vignette_overlay()


def text_overlay(eyebrow_txt=None, caption_txt=None, show_nameplate=True, page_label=None):
    """Nameplate + eyebrow + caption, rendered once per scene onto a transparent layer."""
    ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    if show_nameplate:
        r = 9
        y = rs.M + 12
        rs.gradient_rect(ov, (rs.M, y, rs.M + 2 * r, y + 2 * r), radius=r)
        d = ImageDraw.Draw(ov)
        d.text((rs.M + 2 * r + 16, rs.M), NAME, font=rs.semi_font(34), fill=rs.CREAM)
    if page_label:
        d = ImageDraw.Draw(ov)
        f = rs.semi_font(26)
        tw, _ = rs.measure(d, page_label, f)
        d.text((W - rs.M - tw, rs.M + 4), page_label, font=f, fill=(200, 195, 185, 235))
    if eyebrow_txt:
        rs.eyebrow(ov, eyebrow_txt, rs.M, H - 300)
    if caption_txt:
        rs.draw_rich_block(ov, caption_txt, None, rs.M, H - 250, W - 2 * rs.M, 46, gap=1.14)
    return ov


def crop_window(iw, ih, zoom, focus_y):
    """Return (x0,y0,x1,y1) source crop for a given zoom level and vertical focus (0=top,1=bottom)."""
    target_ar = W / H
    ch = ih / zoom
    cw = ch * target_ar
    if cw > iw:
        cw, ch = iw, iw / target_ar
    cx = (iw - cw) / 2
    max_cy = max(0, ih - ch)
    cy = max_cy * focus_y
    return int(cx), int(cy), int(cx + cw), int(cy + ch)


def render_shot_scene(name, img_path, duration, zoom_start, zoom_end, focus_start, focus_end,
                       eyebrow_txt=None, caption_txt=None, page_label=None):
    im = Image.open(img_path).convert("RGB")
    iw, ih = im.size
    n = max(1, int(duration * FPS))
    overlay = text_overlay(eyebrow_txt, caption_txt, page_label=page_label)
    paths = []
    for i in range(n):
        t = ease_in_out(i / max(1, n - 1))
        zoom = zoom_start + (zoom_end - zoom_start) * t
        focus = focus_start + (focus_end - focus_start) * t
        box = crop_window(iw, ih, zoom, focus)
        frame = im.crop(box).resize((W, H), Image.LANCZOS).convert("RGBA")
        frame = Image.alpha_composite(frame, VIGNETTE)
        frame = Image.alpha_composite(frame, overlay)
        p = FRAMES / f"{name}_{i:04d}.jpg"
        frame.convert("RGB").save(p, "JPEG", quality=92)
        paths.append(p)
    return paths


def render_card_scene(name, duration, eyebrow_txt, headline, emphasis, sub=None, is_signoff=False):
    n = max(1, int(duration * FPS))
    paths = []
    for i in range(n):
        t = i / max(1, n - 1)
        # gentle hold with a very subtle fade-in on the first 12 frames
        fade = min(1.0, (i + 1) / 12)
        img = Image.new("RGB", (W, H), rs.BG)
        d = ImageDraw.Draw(img)
        d.rectangle([0, 0, W - 1, H - 1], outline=rs.HAIRLINE, width=1)
        r = 9
        y0 = rs.M + 12
        rs.gradient_rect(img, (rs.M, y0, rs.M + 2 * r, y0 + 2 * r), radius=r)
        d.text((rs.M + 2 * r + 16, rs.M), NAME, font=rs.semi_font(34), fill=rs.CREAM)
        y = 480
        if eyebrow_txt:
            y = rs.eyebrow(img, eyebrow_txt, rs.M, y) + 30
        if is_signoff:
            y = rs.draw_rich_block(img, headline, emphasis, rs.M, y, W - 2 * rs.M, 108)
            d.text((rs.M, y + 20), SITE, font=rs.semi_font(38), fill=rs.CREAM)
        else:
            y = rs.draw_rich_block(img, headline, emphasis, rs.M, y, W - 2 * rs.M, 66)
            if sub:
                rs.draw_block(img, sub, rs.body_font(38), rs.M, y + 30, W - 2 * rs.M, rs.BODY, gap=1.3)
        if fade < 1.0:
            black = Image.new("RGB", (W, H), (0, 0, 0))
            img = Image.blend(black, img, fade)
        p = FRAMES / f"{name}_{i:04d}.jpg"
        img.save(p, "JPEG", quality=92)
        paths.append(p)
    return paths


def encode(scene_frame_lists, out_path, crossfade_s=0.35):
    """Concat scenes with a short crossfade between each, via ffmpeg's xfade filter chain."""
    clip_paths = []
    for i, frames in enumerate(scene_frame_lists):
        prefix = frames[0].stem.rsplit("_", 1)[0]
        clip = CLIPS / f"{prefix}.mp4"
        subprocess.run([
            "ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS),
            "-i", str(FRAMES / f"{prefix}_%04d.jpg"),
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
            str(clip),
        ], check=True)
        clip_paths.append(clip)

    if len(clip_paths) == 1:
        shutil.copy(clip_paths[0], out_path)
        return

    # Chain xfade filters pairwise, tracking cumulative offset.
    durations = []
    for c in clip_paths:
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(c)],
            capture_output=True, text=True, check=True)
        durations.append(float(probe.stdout.strip()))

    inputs = []
    for c in clip_paths:
        inputs += ["-i", str(c)]

    filter_parts = []
    prev_label = "0:v"
    cum = durations[0]
    for i in range(1, len(clip_paths)):
        offset = cum - crossfade_s
        out_label = f"v{i}" if i < len(clip_paths) - 1 else "vout"
        filter_parts.append(
            f"[{prev_label}][{i}:v]xfade=transition=fade:duration={crossfade_s}:offset={offset:.3f}[{out_label}]"
        )
        prev_label = out_label
        cum += durations[i] - crossfade_s

    filter_complex = ";".join(filter_parts)
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error", *inputs,
        "-filter_complex", filter_complex,
        "-map", "[vout]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
        "-r", str(FPS),
        str(out_path),
    ], check=True)


if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "both"
    print(f"build target: {which}")
