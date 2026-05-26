import { schedules, tasks } from "@trigger.dev/sdk/v3";
import { listRecords } from "../src/airtable/client.js";
import { YT_CREATORS_TABLE, YT_CREATORS_FIELDS } from "../src/airtable/schema.js";
import { YOUTUBE_CRON_SCHEDULE } from "../src/config.js";
import type { scrapeYtCreator } from "./scrape-yt-creator.js";

/**
 * daily-youtube-scrape — bi-weekly (1st & 15th @ 09:00 UTC by default).
 *
 * Fans out to scrape-yt-creator for every active row in YouTube Creators.
 * The watcher handles new rows added between cron windows.
 */
export const dailyYoutubeScrape = schedules.task({
  id: "daily-youtube-scrape",
  cron: YOUTUBE_CRON_SCHEDULE || "0 9 1,15 * *",
  maxDuration: 60,

  run: async () => {
    const creators = await listRecords(YT_CREATORS_TABLE, {
      filterFormula: `{${YT_CREATORS_FIELDS.active}} = TRUE()`,
    });
    if (creators.length === 0) {
      console.log("daily-youtube-scrape: no active YouTube channels");
      return { triggered: 0 };
    }

    const today = new Date().toISOString().slice(0, 10);
    const handles = await Promise.all(
      creators.map((rec) => {
        const f = rec.fields as Record<string, any>;
        const channelUsername = f[YT_CREATORS_FIELDS.channelUsername] as string;
        const contentTypes    = (f[YT_CREATORS_FIELDS.contentTypes] as string[]) || ['Shorts', 'Long-form'];
        return tasks.trigger<typeof scrapeYtCreator>("scrape-yt-creator", {
          channelUsername,
          displayName:      (f[YT_CREATORS_FIELDS.displayName] as string) || channelUsername,
          niche:            (f[YT_CREATORS_FIELDS.niche] as string) || '',
          videoLimit:       (f[YT_CREATORS_FIELDS.videoLimit] as number) || 20,
          contentTypes,
          fetchTranscripts: f[YT_CREATORS_FIELDS.fetchTranscripts] !== false,
        }, {
          idempotencyKey:    `daily-yt-${channelUsername}-${today}`,
          idempotencyKeyTTL: "24h",
        });
      })
    );

    console.log(`daily-youtube-scrape: triggered ${handles.length} channels`);
    return { triggered: handles.length };
  },
});
