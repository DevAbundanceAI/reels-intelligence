# Reels Intelligence — Claude Code Framework

## Project Purpose
Daily automated extraction and AI analysis of Instagram Reels for creator research.
Scrapes public reels via Apify, analyzes content with Claude, stores structured results
in Airtable. Includes a research agent for content gap, trending topic, hook pattern,
and competitor analysis on top of stored data.

## Tools in Use
- **Claude Code** — the primary interface for ALL development, setup, debugging, and research
- **Airtable MCP** — connected inside Claude Code for schema setup, querying, and research sessions
- **Apify** — cloud scraping (`apify~instagram-reel-scraper`)
- **Anthropic Claude API** — `claude-opus-4-5` for analysis
- **Trigger.dev** — cloud-hosted cron scheduler with job dashboard
- **Node.js 20+** — runtime (ES modules in `src/`, TypeScript in `trigger/`)

## How Claude Code Is Used in This Project

Claude Code is not just for writing code. It runs the entire workflow:

| Task | How Claude Code does it |
|---|---|
| Project scaffold | Creates all files and folders |
| Airtable schema | Uses Airtable MCP to create tables and fields |
| Test connections | Runs `npm run test-apify`, `npm run test-airtable` |
| First scrape | Runs `node agents/daily-run.js --creator x --limit 5` |
| Debugging | Reads error output, edits files, re-runs |
| Research reports | Runs `node agents/research-agent.js --mode gap --creator x` |
| Reading reports | Opens `reports/*.md` and summarizes findings |
| Adding creators | Edits `config/targets.json`, triggers a scrape |
| Deploying | Runs Trigger.dev CLI commands |

**You never need to edit files manually.** Every action goes through Claude Code prompts.

## Airtable MCP — How It Is Used

The Airtable MCP is connected inside Claude Code sessions.
It handles two things this project needs:

### 1. One-time schema bootstrap (Session 3)
Claude Code uses these MCP tools to build the entire Airtable base:
- `list_bases` — find your base ID
- `create_table` — create Reels, Creators, Runs tables
- `create_field` — create every field with correct type
- Single-select options are created inline with the field

This replaces manual Airtable UI setup entirely.
Run once: Claude Code does it all from one prompt.

### 2. Interactive research queries (Session 5+)
During research sessions, Claude Code uses MCP to query Airtable directly:
- `list_records_for_table` with filters — "show me HIGH tier reels for @alexhormozi"
- `get_table_schema` — verify field names before writing code
- No need to write Airtable query code for ad-hoc questions

### When NOT to use MCP
MCP requires an active Claude Code session.
Trigger.dev tasks run headless in the cloud — no session, no MCP.
Those tasks use `src/airtable/client.js` (raw REST) instead.

**Rule: MCP = interactive sessions. REST client = automated tasks.**

## Project Structure
```
reels-intelligence/
├── CLAUDE.md                        ← You are here — Claude Code reads this every session
├── .env                             ← API keys (never commit)
├── .env.example                     ← Committed env template
├── package.json
├── trigger.config.ts                ← Trigger.dev project config
├── config/
│   └── targets.json                 ← Creator list & scraping settings
├── src/
│   ├── config.js                    ← Loads .env once, validates keys, exports all constants
│   ├── scrapers/
│   │   ├── apify.js                 ← Apify actor runner with exponential backoff polling
│   │   └── instagram.js             ← Normalizes raw Apify data into clean reel objects
│   ├── analyzers/
│   │   └── claude.js                ← Batch analysis + Poppy Deep Analysis Protocol
│   ├── airtable/
│   │   ├── client.js                ← Raw REST client (used by Trigger.dev tasks — no MCP)
│   │   ├── schema.js                ← Single source of truth for all Airtable field names
│   │   └── sync.js                  ← Classify, dedup, upsert, patch analysis
│   ├── research/
│   │   ├── content-gap.js           ← Gap analysis: what competitors cover that creator doesn't
│   │   ├── trending.js              ← Rising topics across all creators
│   │   ├── hook-patterns.js         ← Hook structure clustering from HIGH vs LOW reels
│   │   └── competitor-compare.js    ← Side-by-side creator breakdown
│   └── utils/
│       ├── engagement.js            ← Engagement score formulas
│       └── logger.js                ← Console logger with timestamps
├── trigger/
│   ├── daily-scrape.ts              ← Cron entry point — fans out to scrape-creator
│   └── scrape-creator.ts            ← Per-creator task: scrape → classify → analyze → sync
├── agents/
│   ├── CLAUDE.md                    ← Research agent spec (auto-loaded when in agents/)
│   ├── setup.js                     ← One-time Airtable schema bootstrap via MCP
│   ├── research-agent.js            ← CLI for all research modes (uses MCP for queries)
│   └── daily-run.js                 ← Full pipeline orchestrator for local runs
├── reports/                         ← Generated markdown research reports land here
└── docs/
    ├── airtable-schema.md           ← Full table & field specs
    ├── engagement-formula.md        ← Score formula and tier logic
    ├── adding-creators.md           ← How to add/pause creators
    └── TRIGGER_DEV.md               ← Trigger.dev setup and deploy guide
```

## Core Pipeline (what happens on each Trigger.dev run)
```
daily-scrape.ts (cron: 0 8 * * *)
  └── scrape-creator.ts (one per creator, in parallel)
        1. Apify scrape → raw reels
        2. Normalize (instagram.js)
        3. getExistingReels() → Map of reelId → { airtableId, aiAnalyzed }
        4. classifyReels() → three buckets:
             brandNew      → store + analyze (Claude called)
             needsAnalysis → stored but aiAnalyzed=false → analyze + patch
             done          → aiAnalyzed=true → skip (zero Claude calls)
        5. analyzeReels() on brandNew + needsAnalysis only
        6. syncReelsToAirtable() for brandNew
        7. syncUnanalyzedReels() to patch needsAnalysis
        8. Return { fetched, created, patched, alreadyDone }
```

## Token Cost Control — Analysis Dedup
Every reel record has three fields that guard against re-analysis:
- `AI Analyzed` (checkbox) — flips to `true` only after Claude returns valid output
- `Analyzed At` (date) — when analysis ran
- `Analysis Model` (text) — which model was used (audit trail)

Claude is **never called** for a reel where `AI Analyzed = true`.
If Claude fails mid-run, reel is stored with `AI Analyzed = false` and retried next run.

Airtable view to monitor: Reels → "Unanalyzed Queue" (filter: AI Analyzed = false)

## Analysis: Two Modes

### Mode 1 — Daily Batch (automatic, per reel)
Called by `scrape-creator.ts` on every run.
Extracts: mainTopic, topics, contentType, hook, hookType, hookCategory,
keyPoints, targetAudience, emotionalTone, ctaType, ctaPlacement.

### Mode 2 — Poppy Deep Analysis Protocol (on-demand, per creator)
5 sequential Claude prompts. Run via `research-agent.js --mode deep`.

```
Prompt A → Hook Analysis: exact hooks, types, categories, patterns across all reels
Prompt B → Title Analysis: structure, power words, timeframes, 3 title formula templates
Prompt C → Structure Analysis: hook length, problem setup, proof type, CTA pattern
Prompt D → Engagement Correlation: which hook+title combos produce HIGH tier
Prompt E → Synthesis: content formula, unique philosophy, replicable templates, red flags
```

Never run deep analysis inside the daily scrape — on-demand only.

## Research Modes (via research-agent.js)
```bash
node agents/research-agent.js --mode gap       --creator alexhormozi
node agents/research-agent.js --mode trending  --days 14
node agents/research-agent.js --mode hooks     --creator alexhormozi
node agents/research-agent.js --mode compare   --creator alexhormozi --vs garyvee
node agents/research-agent.js --mode deep      --creator alexhormozi --icp "coaches"
node agents/research-agent.js --mode all       --creator alexhormozi
```

## Key Commands
```bash
npm install                        # Install all dependencies
npx trigger.dev@latest dev         # Start Trigger.dev local dev
npx trigger.dev@latest deploy      # Deploy to production cloud
npm run test-apify                 # Test Apify connection
npm run test-airtable              # Test Airtable REST connection
node agents/setup.js               # Bootstrap Airtable schema via MCP (run once)
node agents/daily-run.js           # Run full scrape locally
node agents/daily-run.js --creator alexhormozi --limit 5   # Single creator test
```

## Environment Variables
All keys live in `.env` (local) or Trigger.dev dashboard (production).
Loaded and validated once in `src/config.js` — never read `process.env` anywhere else.

Required (fail fast if missing):
```
APIFY_API_KEY          apify.com → Settings → Integrations
ANTHROPIC_API_KEY      console.anthropic.com → API Keys
AIRTABLE_API_KEY       airtable.com → Account → API
AIRTABLE_BASE_ID       from Airtable base URL (starts with app...)
```

Full list with descriptions: `.env.example`

When adding a new env var:
1. Add to `.env.example` with comment
2. Add to `.env`
3. Export from `src/config.js`
4. Import by name — never via `process.env`

## Airtable Tables
- **Reels** — one record per reel, 28 fields, AI Analyzed flag is the token guard
- **Creators** — one record per tracked creator
- **Runs** — log of every Trigger.dev task run

Full field specs: `docs/airtable-schema.md`

## Error Handling Rules
- Apify timeout: exponential backoff polling, skip creator on final timeout, log
- Airtable 422: log bad record, skip it, continue batch
- Claude API error: store reel with `AI Analyzed = false` — retried next run automatically
- Never crash full run because one creator failed — catch per-task, continue
- Trigger.dev retries failed tasks up to 3× with exponential backoff

## Notes for Claude Code
- Read this file at the start of every session before taking any action
- Use Airtable MCP for schema setup and research queries — never for Trigger.dev tasks
- `src/` = ES modules (.js). `trigger/` = TypeScript (.ts). Never mix.
- Never use `process.env` directly — import named constants from `src/config.js`
- Never add `import 'dotenv/config'` anywhere — dotenv loads once in `config.js`
- `schema.js` is the single source of truth for field names — never hardcode strings
- `sync.js` is the most critical file — read it fully before modifying
- Research agent is READ-ONLY — never writes to Reels or Creators tables
- Reports go to `reports/` — never overwrite, append `-v2` if same date exists
- Use `logger` from `@trigger.dev/sdk/v3` in `trigger/` files
- Use `src/utils/logger.js` in all `src/` and `agents/` files
