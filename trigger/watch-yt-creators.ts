import { schedules, tasks } from "@trigger.dev/sdk/v3";
import { listRecords, updateRecords } from "../src/airtable/client.js";
import { YT_CREATORS_TABLE, YT_CREATORS_FIELDS } from "../src/airtable/schema.js";
import type { scrapeYtCreator } from "./scrape-yt-creator.js";

/**
 * watch-yt-creators — every 15 minutes.
 *
 * Mirror of watch-creators.ts but for the YouTube Creators table. Picks up
 * newly added (Last Scraped blank) channels and fires a scrape-yt-creator
 * task per channel. Periodic re-scrape is handled by daily-youtube-scrape.
 */
export const watchYtCreators = schedules.task({
  id: "watch-yt-creators",
  cron: "*/15 * * * *",
  maxDuration: 60,

  run: async () => {
    const records = await listRecords(YT_CREATORS_TABLE, {
      filterFormula: `AND({${YT_CREATORS_FIELDS.active}} = TRUE(), {${YT_CREATORS_FIELDS.lastScraped}} = BLANK())`,
      fields: [
        YT_CREATORS_FIELDS.channelUsername,
        YT_CREATORS_FIELDS.displayName,
        YT_CREATORS_FIELDS.niche,
        YT_CREATORS_FIELDS.contentTypes,
        YT_CREATORS_FIELDS.fetchTranscripts,
        YT_CREATORS_FIELDS.videoLimit,
        YT_CREATORS_FIELDS.lastScraped,
      ],
    });

    if (records.length === 0) {
      console.log("watch-yt-creators: no new channels to scrape");
      return { triggered: 0 };
    }

    const today = new Date().toISOString().slice(0, 10);
    const triggered: string[] = [];

    for (const record of records) {
      const f = record.fields as Record<string, any>;
      const channelUsername = f[YT_CREATORS_FIELDS.channelUsername] as string;
      if (!channelUsername) continue;

      // Optimistic mark to prevent duplicate triggers on the next 15-min poll.
      await updateRecords(YT_CREATORS_TABLE, [{
        id: record.id,
        fields: { [YT_CREATORS_FIELDS.lastScraped]: today },
      }]);

      const contentTypes = (f[YT_CREATORS_FIELDS.contentTypes] as string[]) || ['Shorts', 'Long-form'];

      await tasks.trigger<typeof scrapeYtCreator>("scrape-yt-creator", {
        channelUsername,
        displayName:      (f[YT_CREATORS_FIELDS.displayName] as string) || channelUsername,
        niche:            (f[YT_CREATORS_FIELDS.niche] as string) || '',
        videoLimit:       (f[YT_CREATORS_FIELDS.videoLimit] as number) || 20,
        contentTypes,
        fetchTranscripts: f[YT_CREATORS_FIELDS.fetchTranscripts] !== false,
      }, {
        idempotencyKey:    `watch-yt-${channelUsername}-${today}`,
        idempotencyKeyTTL: "24h",
      });

      triggered.push(channelUsername);
      console.log(`  → triggered YT scrape for @${channelUsername}`);
    }

    return { triggered: triggered.length, channels: triggered };
  },
});
