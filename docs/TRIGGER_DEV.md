# Trigger.dev Integration

## Why Trigger.dev over node-cron

| | node-cron | Trigger.dev |
|---|---|---|
| Runs on | Your machine (must be on) | Trigger.dev cloud |
| Job history | None | Full dashboard with logs |
| Retries | Manual | Built-in with backoff |
| Alerts on failure | None | Email / Slack notifications |
| Long-running jobs | Can timeout | Native support (up to 1hr+) |

## Installation

```bash
npm install @trigger.dev/sdk@3 @trigger.dev/build@3
npx trigger.dev@latest login
npx trigger.dev@latest init
npx trigger.dev@latest dev      # local dev
npx trigger.dev@latest deploy   # production
```

## trigger.config.ts

```typescript
import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: "reels-intelligence",
  runtime: "node",
  logLevel: "log",
  maxDuration: 3600,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 10000,
      maxTimeoutInMs: 60000,
      factor: 2,
    },
  },
  dirs: ["./trigger"],
});
```

## Task 1: daily-scrape.ts

```typescript
import { schedules, tasks } from "@trigger.dev/sdk/v3";
import targets from "../config/targets.json";

export const dailyScrapeTask = schedules.task({
  id: "daily-scrape",
  cron: "0 8 * * *",
  maxDuration: 3600,
  run: async (payload) => {
    const activeCreators = targets.creators.filter(c => c.active);
    const runs = await Promise.allSettled(
      activeCreators.map(creator =>
        tasks.trigger("scrape-creator", {
          username: creator.username,
          displayName: creator.displayName,
          niche: creator.niche,
          reelsLimit: creator.reelsLimit ?? targets.defaults.reelsLimit,
        })
      )
    );
    const succeeded = runs.filter(r => r.status === "fulfilled").length;
    const failed = runs.filter(r => r.status === "rejected").length;
    return { succeeded, failed, total: activeCreators.length };
  },
});
```

## Task 2: scrape-creator.ts

See `trigger/scrape-creator.ts`

## Manual Triggers

```bash
npx trigger.dev@latest trigger daily-scrape
npx trigger.dev@latest trigger scrape-creator --payload '{"username":"alexhormozi","displayName":"Alex Hormozi","niche":"Business","reelsLimit":10}'
```

## Environment Variables

Set these in Trigger.dev dashboard → Project → Environment Variables:
- APIFY_API_KEY
- ANTHROPIC_API_KEY
- AIRTABLE_API_KEY
- AIRTABLE_BASE_ID
- AIRTABLE_REELS_TABLE
- AIRTABLE_CREATORS_TABLE
- AIRTABLE_RUNS_TABLE
- APIFY_ACTOR_ID
- CLAUDE_MODEL
- CLAUDE_BATCH_SIZE
- REELS_PER_CREATOR

## Notes for Claude Code
- Use logger from @trigger.dev/sdk/v3 inside trigger/ files (shows in dashboard)
- Use src/utils/logger.js inside src/ files
- Never use MCP inside trigger/ files — those run headless in cloud
- trigger/ is TypeScript (.ts), src/ is ES modules (.js) — never mix
