import { schedules, tasks } from "@trigger.dev/sdk/v3";
import { listRecords, updateRecords } from "../src/airtable/client.js";
import {
  CREATORS_TABLE,
  CREATORS_FIELDS,
} from "../src/airtable/schema.js";
import { scrapeCreator } from "./scrape-creator";

/**
 * watch-creators — polls the Creators table every 15 minutes.
 * Finds active creators with no Last Scraped date and triggers a scrape.
 * This makes the Creators tab the entry point: add a row → scrape auto-starts.
 */
export const watchCreators = schedules.task({
  id: "watch-creators",
  cron: "*/15 * * * *",   // every 15 minutes
  maxDuration: 60,

  run: async (_payload) => {
    // Find active creators that have never been scraped
    const records = await listRecords(CREATORS_TABLE, {
      filterFormula: `AND({${CREATORS_FIELDS.active}} = TRUE(), {${CREATORS_FIELDS.lastScraped}} = BLANK())`,
      fields: [
        CREATORS_FIELDS.username,
        CREATORS_FIELDS.displayName,
        CREATORS_FIELDS.niche,
        CREATORS_FIELDS.active,
        CREATORS_FIELDS.lastScraped,
      ],
    });

    if (records.length === 0) {
      console.log("watch-creators: no new creators to scrape");
      return { triggered: 0 };
    }

    console.log(`watch-creators: found ${records.length} new creator(s) to scrape`);
    const today = new Date().toISOString().slice(0, 10);

    const triggered: string[] = [];

    for (const record of records) {
      const f = record.fields as Record<string, any>;
      const username = f[CREATORS_FIELDS.username] as string;
      if (!username) continue;

      // Mark as scraped now to prevent duplicate triggers on the next 15-min poll
      await updateRecords(CREATORS_TABLE, [{
        id: record.id,
        fields: { [CREATORS_FIELDS.lastScraped]: today },
      }]);

      await tasks.trigger<typeof scrapeCreator>("scrape-creator", {
        username,
        displayName: (f[CREATORS_FIELDS.displayName] as string) || username,
        niche:       (f[CREATORS_FIELDS.niche] as string) || '',
        reelsLimit:  20,
      }, {
        idempotencyKey:    `watch-${username}-${today}`,
        idempotencyKeyTTL: "24h",
      });

      triggered.push(username);
      console.log(`  → triggered scrape for @${username}`);
    }

    return { triggered: triggered.length, creators: triggered };
  },
});
