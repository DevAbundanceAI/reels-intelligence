# Content Engine — research → organic content in brand voice

Closes the loop: the repo's competitor research becomes the brand's OWN
Instagram content — carousels rendered in code + short-form video scripts.
Brand: Abundance/AN first (whatever `BRAND_DNA_BASE_ID` points at).

## Flow

```
mine-angles.js         reads HIGH/MID-fit reels + OUTLIERS (3x+ creator median)
                       + latest research Raw JSON per mode
                       → Claude proposes original angles in brand voice
                       → Content Ideas rows (Status: Idea) + queue/angles-<date>.json

generate-carousel.js   one angle → deck JSON (≤5 slides, copy only, no pixels)
render_slides.py       deck JSON → 1080x1350 JPEGs, Abundance brand system
                       (dark / cream / red gradient, real wordmark, chart slides)
generate-script.js     one reel angle → teleprompter script + shot list markdown

stage.js               → Content Calendar row (Status: In Production), Brief has
                       caption/hashtags/first-comment/paths, slides attached to
                       the "Preview" field

run.js                 all of the above: node content-engine/run.js --angles 5
```

## Hard rules

- **Nothing auto-posts.** This engine generates and stages only. Posting is
  a human, native, by-hand action. Do not wire any posting API.
- **Voice comes from Brand DNA only** (`renderBrandDnaGenerationPrompt`).
  Never imitate the competitor a signal came from — model structure, not
  substance. BANNED-fit sources are excluded from modeling.
- **Design lives in render_slides.py templates.** Claude writes copy and
  picks slide types; it never chooses colors, fonts, or layout. New looks =
  new template functions, iterated with Ryan, then frozen.
- **No em/en dashes in any output copy** (brand rule) — generators enforce.
- **Never invent statistics.** Chart slides only carry numbers that came
  from the Brand DNA credibility section or the research corpus.
- Research tables (Reels/Analyses/etc.) are READ-ONLY here.

## Rail compatibility (so auto-posting can be added later without re-rendering)

Outputs already respect the proven EH VistaSocial/Make rail limits:
≤5 slides per carousel, .jpg only (IG rejects webp), NO inline links in
captions (link-preview hijack kills carousels) — link goes in first comment.

## Outliers

`mine-angles.js` computes each reel's views vs its own creator's median
(needs ≥4 reels per creator). ≥3x = outlier, the strongest "model this
structure" signal. Tune via OUTLIER_MULTIPLE in mine-angles.js.

## Ops

- On-demand only for now (run from Claude Code). v2: Trigger.dev worker on
  the proven Airtable-flag watcher pattern once output quality is trusted.
- Python deps: `pip install -r content-engine/requirements.txt`
  (pillow + cairosvg; fonts are committed in fonts/).
- If Preview attachments fail: add a "Preview" multipleAttachments field to
  Content Calendar in Airtable, rerun stage.js.
