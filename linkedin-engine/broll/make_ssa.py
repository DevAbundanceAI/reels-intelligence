import sys
sys.path.insert(0, '.')
from build_broll import render_shot_scene, render_card_scene, encode
from pathlib import Path

scenes = []
scenes.append(render_card_scene(
    "ssa1", 2.5, "BEFORE", "KPIs scattered across three tools.", "scattered",
    sub="GHL. Meta. Typeform. No single number anyone trusted.",
))
scenes.append(render_shot_scene(
    "ssa2", "shots/ssa-overview.png", duration=3.1,
    zoom_start=0.56, zoom_end=0.72, focus_start=0.0, focus_end=0.1,
    eyebrow_txt="AFTER", caption_txt="One warehouse, ingested hourly, self-healing.",
    page_label="Show rate",
))
scenes.append(render_shot_scene(
    "ssa3", "shots/ssa-kpis.png", duration=2.9,
    zoom_start=0.56, zoom_end=0.72, focus_start=0.0, focus_end=0.1,
    eyebrow_txt="FUNNEL ECONOMICS", caption_txt="Every stage of the funnel, in one place.",
    page_label="KPIs",
))
scenes.append(render_shot_scene(
    "ssa4", "shots/ssa-monthly.png", duration=2.9,
    zoom_start=0.56, zoom_end=0.72, focus_start=0.0, focus_end=0.08,
    eyebrow_txt="THE SCORECARD", caption_txt="Ad spend, cost per lead, closers active. Month by month.",
    page_label="Monthly",
))
scenes.append(render_shot_scene(
    "ssa5", "shots/ssa-funnel.png", duration=2.9,
    zoom_start=0.56, zoom_end=0.72, focus_start=0.0, focus_end=0.12,
    eyebrow_txt="WHERE IT LEAKS", caption_txt="The biggest drop-off in the funnel, flagged automatically.",
    page_label="Funnel",
))
scenes.append(render_card_scene(
    "ssa6", 2.3, "BUILDING MY OWN", "One dashboard. Every number in one place.", "One dashboard.", is_signoff=True,
))

out = Path("clips/ssa-ground-up.mp4")
encode(scenes, out)
print("wrote", out)
