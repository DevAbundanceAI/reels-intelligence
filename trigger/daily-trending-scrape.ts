import { schedules, tasks } from "@trigger.dev/sdk/v3";
import { listActiveTrendingSources } from "../src/airtable/trending-sync.js";
import { TRENDING_SOURCES_FIELDS } from "../src/airtable/schema.js";
import { TRENDING_CRON_SCHEDULE } from "../src/config.js";
import type { scrapeTrendingSource } from "./scrape-trending-source.js";

/**
 * daily-trending-scrape — daily @ 07:00 UTC by default.
 *
 * Reads `Trending Sources` (Active = true) and fires one scrape-trending-source
 * task per source. Each source can target IG hashtags, YT trending feeds,
 * TikTok hashtags, or niche creators. The worker routes to the right scraper
 * and writes results into the appropriate per-platform trending table.
 *
 * Manual URL submissions and Force Rescrape flags are handled by
 * watch-trending-sources (every 15 min), not this daily run.
 */
export const dailyTrendingScrape = schedules.task({
  id: "daily-trending-scrape",
  cron: TRENDING_CRON_SCHEDULE || "0 7 * * *",
  maxDuration: 60,

  run: async () => {
    const sources = await listActiveTrendingSources();
    if (sources.length === 0) {
      console.log("daily-trending-scrape: no active trending sources");
      return { triggered: 0 };
    }

    const today = new Date().toISOString().slice(0, 10);
    const handles = await Promise.all(
      sources.map((rec) => {
        const f = rec.fields as Record<string, any>;
        const sourceType = f[TRENDING_SOURCES_FIELDS.sourceType]?.name
                        || f[TRENDING_SOURCES_FIELDS.sourceType] || '';
        const platform   = f[TRENDING_SOURCES_FIELDS.platform]?.name
                        || f[TRENDING_SOURCES_FIELDS.platform] || '';
        return tasks.trigger<typeof scrapeTrendingSource>("scrape-trending-source", {
          sourceRecordId: rec.id,
          query:          f[TRENDING_SOURCES_FIELDS.query] || '',
          sourceType,
          platform,
          niche:          f[TRENDING_SOURCES_FIELDS.niche] || '',
          limit:          f[TRENDING_SOURCES_FIELDS.limit] || 30,
        }, {
          idempotencyKey:    `daily-trending-${rec.id}-${today}`,
          idempotencyKeyTTL: "20h",
        });
      })
    );

    console.log(`daily-trending-scrape: triggered ${handles.length} sources`);
    return { triggered: handles.length };
  },
});
