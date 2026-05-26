import { schedules, tasks } from "@trigger.dev/sdk/v3";
import {
  listSourcesNeedingWatcherAction,
  markSourceScraped,
} from "../src/airtable/trending-sync.js";
import { TRENDING_SOURCES_FIELDS } from "../src/airtable/schema.js";
import type { scrapeTrendingSource } from "./scrape-trending-source.js";
import type { generateFromUrl } from "./generate-from-url.js";

/**
 * watch-trending-sources — every 15 minutes.
 *
 * Two responsibilities, both driven by the Trending Sources table:
 *
 * 1. **URL submission flow** — a row where `Submitted URL` is set AND
 *    `Last Scraped` is blank means a user filled the public form. Trigger
 *    `generate-from-url` so the URL gets scraped, modeled, and turned into
 *    a Content Ideas row (Source = Modeled / Strict-Mirror).
 *
 * 2. **Force Rescrape flow** — a row where `Force Rescrape` is true means
 *    the user wants this source pulled again on the next tick. Trigger
 *    `scrape-trending-source` and clear the flag (done by the worker).
 *
 * Idempotency keys are bound to row id + day so a row that toggles twice in
 * the same day doesn't re-fire.
 */
export const watchTrendingSources = schedules.task({
  id: "watch-trending-sources",
  cron: "*/15 * * * *",
  maxDuration: 60,

  run: async () => {
    const rows = await listSourcesNeedingWatcherAction();
    if (rows.length === 0) {
      console.log("watch-trending-sources: nothing pending");
      return { triggered: 0 };
    }

    const today = new Date().toISOString().slice(0, 10);
    const triggered: { kind: string; ref: string }[] = [];

    for (const row of rows) {
      const f = row.fields as Record<string, any>;
      const submittedUrl = f[TRENDING_SOURCES_FIELDS.submittedUrl] as string;
      const lastScraped  = f[TRENDING_SOURCES_FIELDS.lastScraped] as string;
      const forceRescrape = f[TRENDING_SOURCES_FIELDS.forceRescrape] === true;

      // Case 1: new URL submission (form pickup)
      if (submittedUrl && !lastScraped) {
        await tasks.trigger<typeof generateFromUrl>("generate-from-url", {
          sourceRecordId:   row.id,
          url:              submittedUrl,
          platformOverride: f[TRENDING_SOURCES_FIELDS.platformOverride] || null,
          niche:            f[TRENDING_SOURCES_FIELDS.niche] || '',
        }, {
          idempotencyKey:    `submission-${row.id}-${today}`,
          idempotencyKeyTTL: "24h",
        });
        triggered.push({ kind: 'submission', ref: submittedUrl });
        continue;
      }

      // Case 2: force-rescrape an existing source
      if (forceRescrape) {
        await tasks.trigger<typeof scrapeTrendingSource>("scrape-trending-source", {
          sourceRecordId: row.id,
          query:          f[TRENDING_SOURCES_FIELDS.query] || '',
          sourceType:     f[TRENDING_SOURCES_FIELDS.sourceType]?.name || f[TRENDING_SOURCES_FIELDS.sourceType] || '',
          platform:       f[TRENDING_SOURCES_FIELDS.platform]?.name   || f[TRENDING_SOURCES_FIELDS.platform]   || '',
          niche:          f[TRENDING_SOURCES_FIELDS.niche] || '',
          limit:          f[TRENDING_SOURCES_FIELDS.limit] || 30,
        }, {
          idempotencyKey:    `forcerescrape-${row.id}-${today}`,
          idempotencyKeyTTL: "12h",
        });
        triggered.push({ kind: 'force-rescrape', ref: f[TRENDING_SOURCES_FIELDS.query] || row.id });
        // Worker clears the flag and stamps Last Scraped, but mark scraped here
        // too so the watcher doesn't re-trigger before the worker lands.
        await markSourceScraped(row.id);
      }
    }

    console.log(`watch-trending-sources: triggered ${triggered.length}`, triggered);
    return { triggered: triggered.length, items: triggered };
  },
});
