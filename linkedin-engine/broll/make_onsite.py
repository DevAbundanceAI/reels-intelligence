import sys
sys.path.insert(0, '.')
from build_broll import render_shot_scene, render_card_scene, encode
from pathlib import Path

scenes = []
scenes.append(render_shot_scene(
    "os1", "shots/onsite-before-home.png", duration=2.7,
    zoom_start=0.56, zoom_end=0.74, focus_start=0.0, focus_end=0.08,
    eyebrow_txt="BEFORE", caption_txt="The old site. Generic template, stock photography, no specifics.",
    page_label="on-site-rentals.com, before",
))
scenes.append(render_shot_scene(
    "os2", "shots/onsite-after-home.png", duration=2.9,
    zoom_start=0.58, zoom_end=0.78, focus_start=0.0, focus_end=0.1,
    eyebrow_txt="AFTER", caption_txt="Rebuilt from scratch. Real address, real fleet, real numbers.",
    page_label="on-site-rentals.com, after",
))
scenes.append(render_shot_scene(
    "os3", "shots/onsite-after-rentals.png", duration=2.7,
    zoom_start=0.56, zoom_end=0.72, focus_start=0.0, focus_end=0.12,
    eyebrow_txt="THE FLEET", caption_txt="Twenty-one machines, filterable by class, real specs.",
    page_label="/rentals",
))
scenes.append(render_shot_scene(
    "os4", "shots/onsite-after-quote.png", duration=2.7,
    zoom_start=0.56, zoom_end=0.72, focus_start=0.0, focus_end=0.1,
    eyebrow_txt="THE FUNNEL", caption_txt="No pricing shown, anywhere. The quote request is the lead.",
    page_label="/quote",
))
scenes.append(render_card_scene(
    "os5", 2.3, "BUILDING MY OWN", "Built by my team. Live today.", "Live today.", is_signoff=True,
))

out = Path("clips/onsite-before-after.mp4")
encode(scenes, out)
print("wrote", out)
