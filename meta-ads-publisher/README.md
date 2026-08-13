# Meta Ads Publisher

Human-gated pipeline that turns Google Drive folders into PAUSED Meta campaigns.
Full pattern write-up: [docs/META-ADS-PIPELINE.md](../docs/META-ADS-PIPELINE.md).

**This tool cannot activate an ad.** Every object is created PAUSED; the code
path to ACTIVE does not exist. A human activates in Ads Manager.

## Quickstart

```bash
pip install -r requirements.txt
cp .env.example .env                          # fill in tokens
cp config/brands.example.json config/brands.json   # fill in brand IDs

# Bootstrap: find each brand's Drive root folder ID
python tools/drive_scan.py --list-brand-folders

# Safe default: scan + QC, stops at the report
python run_pipeline.py --brand expert-health

# Pre-flight the ad account too
python run_pipeline.py --brand expert-health --build-dry-run

# Human gate: create everything PAUSED on Meta
python run_pipeline.py --brand expert-health --build --yes
```

Then open Ads Manager, verify every object, and activate by hand.

## Layout

```
tools/drive_scan.py    Stage 1 - scan Drive intake → plan JSON
tools/qc_ads.py        Stage 2 - local QC: technical / structural / compliance / account gate
tools/build_meta.py    Stage 3 - create PAUSED objects + read-back verification
run_pipeline.py        one-command runner with the --build --yes gate
config/brands.json     per-brand registry (gitignored; see brands.example.json)
```

Claude subagents that drive these live in `../.claude/agents/`
(meta-ads-scanner, meta-ads-qc, meta-ads-publisher).
