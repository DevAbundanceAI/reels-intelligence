import { schedules, tasks } from "@trigger.dev/sdk/v3";
import { scrapeCreator } from "./scrape-creator";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

interface CreatorConfig {
  username: string;
  displayName: string;
  niche: string;
  active: boolean;
  reelsLimit: number;
}

interface TargetsConfig {
  creators: CreatorConfig[];
  defaults: {
    reelsLimit: number;
  };
}

function loadTargets(): CreatorConfig[] {
  const __dir = dirname(fileURLToPath(import.meta.url));
  const targetsPath = resolve(__dir, "../config/targets.json");
  const raw = readFileSync(targetsPath, "utf-8");
  const config: TargetsConfig = JSON.parse(raw);
  return config.creators.filter((c) => c.active !== false);
}

/**
 * Daily scrape cron — runs at 8am UTC every day.
 * Fans out one scrape-creator task per active creator in config/targets.json.
 */
export const dailyScrape = schedules.task({
  id: "daily-scrape",
  // Runs every 2 weeks (1st and 15th of each month) at 08:00 UTC
  // Change CRON_SCHEDULE env var to override (e.g. "0 8 * * 1" for weekly on Mondays)
  cron: process.env.CRON_SCHEDULE || "0 8 1,15 * *",
  maxDuration: 60,

  run: async (_payload) => {
    const creators = loadTargets();

    if (creators.length === 0) {
      console.log("No active creators in config/targets.json — nothing to scrape");
      return { triggered: 0 };
    }

    console.log(`Daily scrape: triggering ${creators.length} creator tasks`);
    creators.forEach((c) => console.log(`  → @${c.username} (limit: ${c.reelsLimit})`));

    const today = new Date().toISOString().slice(0, 10);

    // Fan out — one task per creator, all run in parallel on Trigger.dev
    const handles = await Promise.all(
      creators.map((creator) =>
        tasks.trigger<typeof scrapeCreator>("scrape-creator", {
          username:    creator.username,
          displayName: creator.displayName,
          niche:       creator.niche,
          reelsLimit:  creator.reelsLimit,
        }, {
          idempotencyKey:    `scrape-${creator.username}-${today}`,
          idempotencyKeyTTL: "24h",
        })
      )
    );

    console.log(`Daily scrape: triggered ${handles.length} tasks`);
    return {
      triggered: handles.length,
      creators: creators.map((c) => c.username),
    };
  },
});
