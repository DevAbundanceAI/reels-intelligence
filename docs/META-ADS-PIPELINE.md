# Publishing Meta Ads with Claude - A Replicable, Human-Gated Pipeline

A pattern for letting an AI agent build Meta (Facebook/Instagram) campaigns end-to-end while keeping every dollar of spend behind a human decision.

Implementation lives in [`meta-ads-publisher/`](../meta-ads-publisher/) in this repo.

## The Idea in One Paragraph

Your team builds ad campaigns as ordinary Google Drive folders - images, videos, and simple text files with the ad copy. Claude then runs three small, predictable Python programs in sequence: one scans the folder into a structured plan, one quality-checks every ad against technical specs and a banned-words compliance list, and one uploads everything to Meta Ads Manager - with every campaign, ad set, and ad created switched off (PAUSED). The upload program literally cannot activate an ad; that ability was never built in. A human reviews everything in Ads Manager and flips the switch themselves. Spending money is always a human decision.

```
Google Drive folder  →  SCAN  →  QC  →  BUILD (paused)  →  Human activates in Ads Manager
   (your team)         (Claude runs 3 deterministic scripts)      (the operator)
```

Why it's built this way: the AI never touches Meta directly. It orchestrates and interprets; all the risky judgment (compliance rules, banned-account blocks, paused-only) is locked into code, so the AI can't be talked into breaking it.

## The Five Components

### 1. The content contract - a Drive folder convention

Campaigns are authored by dragging files into folders. Folder names become Meta object names. No forms, no spreadsheets - anyone on the team can do it.

```
<Brand Root Folder>/
  <Campaign Name>/                  → becomes the Meta campaign name
    _campaign.json                  → optional: {"objective", "daily_budget", "landing_page"}
    <Batch folder e.g. "2026-07-20">/   → one delivery; most recently modified batch wins
      <Ad Set Name>/                → becomes the Meta ad set name
        _adset.json                 → optional targeting override (merged onto brand defaults)
        hero-video.mp4              → one creative file = one ad
        hero-video.json             → sidecar copy: {"primary_text","headline","description","cta","link"}
        static-1.jpg
        static-1.txt                → plain .txt sidecar = primary text only
```

Only real `.json` / `.txt` files are parsed - native Google Docs are deliberately unsupported, keeping intake deterministic.

### 2. The per-brand registry - one JSON config file

One entry per brand (or client, if you're an agency):

- `meta_ad_account_id`, `meta_page_id`, `pixel_id`, `instagram_account_id`
- `default_daily_budget`, `default_objective` (e.g. `OUTCOME_LEADS`)
- `default_targeting` - age, gender, geo, placements (feed / story / reels)
- `drive_root_folder_id` - which Drive folder is this brand's intake
- `compliance_dont_list` - the brand's banned angles, in plain English
- optional per-brand token env var - brands in different Business Portfolios use separate tokens

### 3. Stage 1 - Scanner (`tools/drive_scan.py`)

- Auth: a Google service account key with `drive.readonly` scope; each brand's root folder is shared with the service account's email as Viewer. (OAuth token fallback.)
- Walks the tree, downloads creatives locally, parses sidecars, and writes a `drive_scan_<brand>_<timestamp>.json` campaign plan.
- Anything odd - missing copy, empty folders, invalid JSON, multiple batch folders - lands in a warnings list. Flagged, never silently dropped.
- Bootstrap helper: a `--list-brand-folders` flag prints every folder shared with the service account so you can fill in the folder IDs.

### 4. Stage 2 - QC (`tools/qc_ads.py`)

Pure local checks, no API calls. Every ad gets PASS/FAIL with issues tagged FAIL / WARN / INFO:

| Check type | Examples |
|---|---|
| Technical | image ≤30MB and ≥600px; video ≤4GB, ≤60s recommended; aspect ratio vs Meta's standard ratios (probed with Pillow/moviepy) |
| Structural | ad copy present; landing page resolvable (ad → ad set → campaign fallback); 2-4 ads per ad set; `age_min ≥ 18` hard fail |
| Compliance | regex/keyword banks built from your industry's real rejection/ban history - e.g. a health brand might hard-fail numeric outcome claims, "guaranteed", before/after phrasing, shame language, prescription drug names; lower-risk brands get softer tone WARNs |
| Account gate | previously banned ad-account IDs are hardcoded in the tool, not just config - editing config alone cannot un-block them. Gate: BLOCKED / PASS / PARTIAL |

A QC pass is honest about its limits: keyword matching catches known-bad patterns but does not replace human judgment or guarantee Meta's own review approves the ad.

### 5. Stage 3 - Builder (`tools/build_meta.py`)

Raw HTTP calls against `graph.facebook.com/v21.0` (no SDK required). Token from `.env`. Per ad:

1. `POST /act_X/campaigns` - `status=PAUSED` hardcoded, legacy objectives normalized to ODAX (`OUTCOME_LEADS` etc.)
2. `POST /act_X/adsets` - merged targeting, `promoted_object` (page + pixel + LEAD event), EU DSA beneficiary/payor fields
3. `POST /act_X/adimages` (multipart; sniffs magic bytes and fixes wrong file extensions Meta would reject) or `/advideos` + poll until `video_status=ready` + fetch thumbnail
4. `POST /act_X/adcreatives` with the `object_story_spec`
5. `POST /act_X/ads` - `status=PAUSED` again

Safety and robustness features worth copying verbatim:

- **Idempotent by name** - reuses an existing campaign/ad set/ad with the same name, so reruns after a partial failure never duplicate.
- **Read-back verification** - after building, GETs every created object and confirms it is really PAUSED. Any mismatch → READ-BACK PROBLEMS → the build is reported as failed. The create response is never trusted alone.
- **Rate limits** - sleeps 90s and retries on Meta codes 4/17/32/613/429; clean hard-exit on token expiry (190) and quota exhaustion (80004).
- **`--dry-run`** pre-flight that only verifies the ad account is reachable.
- Refuses to build if the page/pixel is unset, the account is blocked, or - via a one-command runner script - without an explicit `--build --yes` human gate (the safe default stops at the QC report).

## The Claude layer

Three short subagent definitions in `.claude/agents/` - a scanner, a QC expert, and a publisher. Each is ~25 lines: a persona, numbered "do exactly this" steps naming the script to run, and hard rules:

- "Never set or imply `status=ACTIVE` anywhere, ever. Activation is a human-only action."
- "Never talk yourself into softening a FAIL."
- "A successful-looking create response is not proof of anything - only the read-back confirms."

Claude is the orchestrator and interpreter, not the executor. The operator triggers it conversationally - "scan the drive folder for brand X", "qc it", "build it paused" - Claude runs the scripts, reads the JSON outputs, and reports warnings and failures verbatim.

## Replication Checklist

**Meta side**

1. Business Manager → ad account, Facebook Page, Pixel.
2. Create a System User with `ads_management` + `business_management` scopes; generate a long-lived access token into `.env`.

**Google side**

3. GCP project → service account → enable the Drive API → download the key JSON (gitignore it).
4. Create each brand's Drive root folder; share it with the service account's email as Viewer.

**Code**

5. Write (or copy) the four Python tools - scanner, QC, builder, and a one-command pipeline runner - plus the config schema. Dependencies: `pip install google-auth requests pillow moviepy`.
6. Fill in your brand entries: account/page/pixel IDs, budget and targeting defaults.
7. Build the compliance keyword banks from your own vertical. Mine your past ad rejections and bans for the list - the rules that matter are the ones that have actually burned you (outcome claims, guarantees, before/after language, regulated product names, whatever applies).
8. Write the three agent .md files into `.claude/agents/` with the hard rules above.

**First run**

9. Run the scanner's `--list-brand-folders` → paste folder IDs into config.
10. Scan → QC → `--build-dry-run` → review the QC report → `--build --yes` → open Ads Manager, verify, activate by hand.

## Design Principles Worth Stealing

- **Paused-only by construction.** The code path to ACTIVE does not exist. The AI cannot spend money.
- **Deterministic tools, AI orchestration.** All mutations live in plain scripts; the AI runs and interprets them. Compliance can't be argued with.
- **Hard blocks live in code, not config.** Banned account IDs are constants in the tools - a config edit can't resurrect them.
- **Verify, don't trust.** Every build ends with an API read-back proving the objects exist and are paused.
- **Warnings over silence.** Every anomaly in intake is surfaced verbatim; nothing is silently skipped or guessed.
- **Human gates at the money moments.** `--build --yes` to create objects; a human click in Ads Manager to spend.
- **Content authoring stays no-code.** The "campaign brief format" is a folder anyone can drag files into.

## Known Limits

- The compliance layer is keyword matching, not judgment - it catches known-bad patterns but Meta's review can still reject an ad it passed.
- Meta's API drifts: the API version pin, ODAX objective map, and DSA fields need occasional maintenance.
- The pipeline publishes; it doesn't optimize. Performance review, budget shifts, and pause/scale decisions are a separate (also human-gated) loop.
