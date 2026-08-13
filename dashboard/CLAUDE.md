# Reels Intelligence — Ops Dashboard

Internal ops view for the Reels Intelligence Trigger.dev pipeline. Read-only.
Aggregates Trigger.dev run telemetry + Airtable output counts so we can see at
a glance which agents (tasks) are healthy and which are failing.

## Status
Initial scaffold. Pulls live data from Trigger.dev and Airtable on each
request. No persistence, no client JS. Auth via optional basic-auth
middleware (set both env vars to enable).

## Stack
- **Framework:** Astro 6 with strict TypeScript, `output: 'server'` via `@astrojs/cloudflare`
- **Styling:** Tailwind CSS v4 via `@tailwindcss/vite` (imported in `src/styles/global.css`)
- **Hosting:** Cloudflare Pages / Workers
- **Repo:** sub-project of `reels-intelligence` (https://github.com/DevAbundanceAI/reels-intelligence)

## Commands
- `npm run dev` local dev server (port 4321)
- `npm run build` production build into `dist/`
- `npm run preview` serve the built site locally

## Project layout
- `src/pages/index.astro` — 10 task rows grouped by kind (cron / orchestrator / worker), plus 4 KPI cards across the top
- `src/pages/tasks/[id].astro` — per-task drill: stats, latest error, today's Airtable output, recent runs, latest payload + output
- `src/lib/tasks.ts` — static catalog of the 10 tasks; edit this when a new task is added
- `src/lib/trigger.ts` — REST client for Trigger.dev. `/api/v1/runs` and `/api/v3/runs/{id}` and `/api/v1/schedules`. Auth: project secret key.
- `src/lib/airtable.ts` — minimal read-only Airtable client (only `countRecords` used today)
- `src/lib/aggregate.ts` — stat reducers and formatters (`formatDuration`, `formatCost`, `formatRelative`)
- `src/middleware.ts` — optional basic auth gate (enforced when both `OPS_BASIC_AUTH_USER` and `OPS_BASIC_AUTH_PASS` are set)
- `src/styles/global.css` — Tailwind + design tokens (matte black, blue→purple gradient, status pills)

## Worker env vars (production)
Set these in Cloudflare Pages → project → Settings → Environment variables (Production):
- `TRIGGER_SECRET_KEY` (Secret) — Trigger.dev project secret key (`tr_prod_*`). Reuse the one already in the Trigger.dev project itself.
- `AIRTABLE_API_KEY` (Secret) — Airtable PAT with `data.records:read` on the Reels Intelligence base
- `AIRTABLE_BASE_ID` (Variable) — `appYfkPFW0Meaj7aG` (the Reels Intelligence base)
- `OPS_BASIC_AUTH_USER` (Secret, optional) — leave both unset to make dashboard public (don't do this on prod)
- `OPS_BASIC_AUTH_PASS` (Secret, optional)

## Working agreements
- Server-only fetching. No API key ever ships to the browser.
- No JS framework until necessary. Astro pages render fully on the server.
- 50-subrequest Workers cap: index page does ONE `listRuns(50)` call and filters client-side per task. Don't be tempted to add per-task fetches in a loop.
- Adding a new Trigger.dev task = add a row to `src/lib/tasks.ts` and redeploy.
- No em dashes in user-facing copy.

## Local dev
1. `cp .env.example .env` and fill in `TRIGGER_SECRET_KEY` + `AIRTABLE_API_KEY` from the parent `reels-intelligence/.env`.
2. `npm install`
3. `npm run dev` and open http://localhost:4321
4. Both auth vars unset → dashboard is open. Set both to test the gate.

## How data flows
```
[Astro page (server)]
   │
   ├─→ TriggerClient.listRuns(50)        → 1 HTTP call, used by index for all 10 tasks
   ├─→ TriggerClient.listSchedules()     → 1 HTTP call, used by index footer
   ├─→ TriggerClient.getRun(id)          → drill-down only, for latest payload/output/error
   └─→ AirtableClient.countRecords()     → drill-down only, for "today's output" panel
```

## What it intentionally does NOT do
- Edit prompts (those stay in code, in `src/analyzers/claude.js`)
- Trigger task runs from the UI (the secret key has permission, but read-only feels right for v1)
- Multi-tenant — single base view, no Brand DNA selector
- Mobile layout — desktop only
- Real-time — page-load fetch only, no websockets, no polling

## Open follow-ups
- Per-task time-series charts (success rate and cost by hour over 7 days) — needs more than the 50-run rolling window
- Slack alert when a task's last run is FAILED
- Brand DNA selector once Acquisition Network onboards as its own client base
