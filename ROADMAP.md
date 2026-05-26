# Implementation Roadmap — Reels Intelligence
# Complete guide: from zero to fully running system

> **Brand DNA is cross-base.** It lives in a per-client Airtable base
> registered in `Brand OS Master` → `Clients`. This pipeline reads it on
> every run via `BRAND_DNA_BASE_ID`. Phase 0.5 below covers pointing the
> repo at the right base — not building DNA inside this repo.

---

## PHASE 0 — Prerequisites (Do this before opening Claude Code)
**Time: ~30 minutes**

### Accounts to create / API keys to grab

1. **Apify** — apify.com
   - Sign up — free tier gives ~$5/month credit (~200–300 reels)
   - Go to: Settings → Integrations → API Tokens → Create token
   - Copy: `apify_api_xxxx`

2. **Anthropic** — console.anthropic.com
   - Add billing — $10 is enough to start
   - Go to: API Keys → Create Key
   - Copy: `sk-ant-xxxx`

3. **Airtable** — airtable.com
   - Create a new Base — name it "Reels Intelligence"
   - Go to: airtable.com/account → API → Generate token
   - Copy: `patxxxx`
   - Copy your Base ID from the URL: airtable.com/appXXXXXX/...
   - Copy: `appXXXXXX`

4. **Trigger.dev** — trigger.dev
   - Sign up — create a new Project — name it "reels-intelligence"
   - Copy your Project ID (shown after creation)
   - You'll connect this in Phase 2

### Software on your machine
```bash
node --version   # needs 20+
npm --version    # comes with node
```
If not installed: nodejs.org → download LTS

---

## PHASE 1 — Setup (Claude Code session #1)
**Time: ~45 minutes**
**Goal: Project running locally, Airtable schema created, first test scrape working**

### Step 1.1 — Open Claude Code in your project folder
```bash
cd reels-intelligence    # the folder with CLAUDE.md
claude                   # opens Claude Code
```

Claude Code reads CLAUDE.md automatically. You will see it confirm the project context.

### Step 1.2 — First prompt to Claude Code
```
Read CLAUDE.md and confirm you understand the full project structure.
Then create the .env file from .env.example and tell me what values I need to fill in.
```

### Step 1.3 — Install dependencies
```
Run npm install and confirm all dependencies installed correctly.
```

### Step 1.4 — Create Airtable schema
```
Connect the Airtable MCP and use it to create all 3 tables (Reels, Creators, Runs)
with all fields exactly as defined in src/airtable/schema.js and docs/airtable-schema.md.
Include all single-select options.
```

### Step 1.5 — Test connections
```
Run npm run test-apify and npm run test-airtable and fix any errors.
```

Expected result:
```
[2025-01-15 08:00:01] ✓ Apify connection OK — got 3 reels
[2025-01-15 08:00:02] ✓ Airtable connection OK — table exists
```

---

## PHASE 0.5 — Point at the right Brand DNA base
**Time: 5 minutes**
**Goal: `.env` points at the client's Brand DNA base so every analyzer
loads it on startup.**

Do this BEFORE Phase 1 Step 1.6.

### Step 0.5.1 — Find the base ID
Open `Brand OS Master` → `Clients`. Pick the client row. The
`Brand DNA Base ID` field holds the target base ID (starts with `app...`).

If the client hasn't been onboarded yet:
- **Quickest path:** point at Abundance's base (`appKg5KqW82kOucCL`) as a
  placeholder. Brand-fit scores won't be relevant to this client, but the
  pipeline will run end-to-end.
- **Proper path:** duplicate Abundance's Brand DNA base structure, register
  the new base in `Clients`, then have the client fill the onboarding form.

### Step 0.5.2 — Set the env vars
In `.env`:
```env
BRAND_DNA_BASE_ID=appXXXXXXXXXXXXXX
# These default to the table IDs in Abundance's base — only change if the
# new base uses different IDs (it shouldn't if you duplicated structure):
BRAND_DNA_PROFILE_TABLE_ID=tbl1tkPkABIqyJjrF
BRAND_DNA_VOICE_TABLE_ID=tbl7ZSgUKZFpiI2I6
BRAND_DNA_ICPS_TABLE_ID=tblioaRLaLEQSwQ1x
```

### Step 0.5.3 — Verify
Run any analyzer command from Phase 1.6 onwards. On startup it logs:
```
Brand DNA loaded: "Abundance.AI" from base appKg5KqW82kOucCL
Claude: analyzing N reels in batches of 10 (brand-aware)
```
If you see `Brand DNA not loaded — running generic analysis`, fix
BRAND_DNA_BASE_ID or check the base has a Brand Profile record.

---

### Step 1.6 — Add your first creator and run a test scrape
```
Add alexhormozi to config/targets.json with reelsLimit: 5.
Then run: node agents/daily-run.js --creator alexhormozi --limit 5
Fix any errors that come up.
```

Expected result in Airtable:
- 5 new rows in the Reels table
- AI Analyzed = ✓ on all rows
- Main Topic, Hook, Topics all populated
- Engagement Score and Tier calculated

---

## PHASE 2 — Trigger.dev Deployment (Claude Code session #2)
**Time: ~30 minutes**
**Goal: Automated daily scraping running in the cloud**

### Step 2.1
```
Set up Trigger.dev in this project. Install the SDK, create trigger.config.ts,
and implement trigger/daily-scrape.ts and trigger/scrape-creator.ts
based on docs/TRIGGER_DEV.md.
```

### Step 2.2
```
Run: npx trigger.dev@latest login
Then: npx trigger.dev@latest init
Then: npx trigger.dev@latest dev
```

### Step 2.3 — Set environment variables in Trigger.dev dashboard
Go to: trigger.dev → your project → Environment Variables
Add the same 4 API keys + all AIRTABLE_ variables from your .env

### Step 2.4 — Test a manual trigger
```
Trigger the scrape-creator task manually for alexhormozi with limit 5.
Confirm it runs successfully in the Trigger.dev dashboard.
```

### Step 2.5 — Deploy to production
```
Run: npx trigger.dev@latest deploy
Then confirm the daily-scrape cron is scheduled correctly in the dashboard.
```

---

## PHASE 3 — Add All Creators (Claude Code session #3)
**Time: ~20 minutes**
**Goal: All target creators in the system, first full run complete**

### Step 3.1
```
Add these creators to config/targets.json: [your list]
Each with appropriate niche and reelsLimit 20.
Then run the full daily scrape for all creators.
```

Expected result after first full run:
```
─────────── RUN COMPLETE ───────────
✓ Creators run:   5
✓ Reels fetched:  98
✓ Reels new:      98
```

### Step 3.2 — Set up Airtable views
In the Airtable UI, create these views in the Reels table:
- Top Performers (filter: Engagement Tier = HIGH, sort: Engagement Score DESC)
- By Creator (group by Username)
- By Topic (group by Main Topic)
- Unanalyzed Queue (filter: AI Analyzed = false)
- This Week (filter: Published At >= 7 days ago)

---

## PHASE 4 — Research Agent (Claude Code session #4)
**Time: ~30 minutes**
**Goal: First gap analysis and trending report generated**

### Step 4.1
```
node agents/research-agent.js --mode gap --creator alexhormozi
```

Output file: `reports/gap-alexhormozi-YYYY-MM-DD.md`
Contains: hard gaps, weak spots, 5 content opportunities with hook suggestions, strengths.

### Step 4.2
```
node agents/research-agent.js --mode trending --days 14
```

Output file: `reports/trending-YYYY-MM-DD.md`
Contains: top 10 rising topics, emerging gems, declining topics.

### Step 4.3
```
node agents/research-agent.js --mode hooks --creator alexhormozi
```

Output file: `reports/hooks-alexhormozi-YYYY-MM-DD.md`
Contains: winning hook patterns, 5 ready-to-use formulas, hook type performance table.

### Step 4.4 — Poppy Deep Analysis
```
node agents/research-agent.js --mode deep --creator alexhormozi --icp "coaches and consultants"
```

Output file: `reports/deep-alexhormozi-YYYY-MM-DD.md`
Contains: hook analysis, title formulas, video arc, engagement correlation, synthesis.

---

## PHASE 5 — Ongoing (Weekly routine)
**Time: ~10 minutes/week**

### What runs automatically
- Daily scrape at 8am UTC — new reels scraped and analyzed
- Trigger.dev dashboard shows run history and any failures

### Weekly manual actions
```bash
node agents/research-agent.js --mode gap --creator [your creator]
node agents/research-agent.js --mode trending --days 7
```

### When to run deep analysis (Poppy Protocol)
- When adding a new competitor creator
- When a creator's engagement suddenly spikes or drops
- When you want to model a creator for a client

---

## Token Cost at Scale

| Reels/day | Claude cost/day | Monthly |
|---|---|---|
| 50 reels (2-3 creators) | ~$0.15 | ~$4.50 |
| 200 reels (8-10 creators) | ~$0.60 | ~$18 |
| 500 reels (20+ creators) | ~$1.50 | ~$45 |

Deep analysis (Poppy): ~$0.20–0.40 per creator per run (5 calls).
Dedup guard means these costs only apply to NEW reels — never repeated.

---

## Common Issues and Fixes

### "No analyzed reels found"
Gap/trending analysis found nothing — scraper hasn't run yet for that creator.
Fix: `node agents/daily-run.js --creator [username] --limit 20` first.

### Apify returns 0 reels
Account is private or username wrong.
Fix: Check the username is public on Instagram. Test in Apify console manually.

### Claude returns unparseable JSON
Rare — happens when transcript is very long and confuses the model.
Fix: Claude Code will detect `AI Analyzed = false` on those reels next run and retry automatically.

### Trigger.dev task times out
Apify scrape for one creator taking too long.
Fix: Reduce `reelsLimit` in targets.json for that creator, or increase `maxDuration` in scrape-creator.ts.

### Airtable 422 error
Field name mismatch — a field in schema.js doesn't exist in Airtable.
Fix: `node agents/setup.js` to re-run schema bootstrap, or check Airtable field names manually.
