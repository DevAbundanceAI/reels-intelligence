import { schedules, tasks, logger } from "@trigger.dev/sdk/v3";
import { listRecords } from "../src/airtable/xbase.js";
import {
  LINKEDIN_BASE_ID, LINKEDIN_POSTS_TABLE,
  LINKEDIN_ACCESS_TOKEN, LINKEDIN_PERSON_URN, LINKEDIN_TOKEN_EXPIRES_AT,
} from "../src/config.js";
import type { linkedinPublishPost } from "./linkedin-publish-post.js";

/**
 * linkedin-publish-watch — every 15 minutes.
 *
 * Mirrors watch-trending-sources.ts's watcher/worker split: this task only
 * finds Approved + Auto rows whose Scheduled Time has passed and fires the
 * per-row publish worker with an idempotency key bound to the record id
 * (not the day — a record must never publish twice, full stop, even if
 * someone flips it back to Approved by mistake weeks later).
 *
 * If the LinkedIn token is missing or close to its 60-day expiry, this
 * logs a warning instead of failing outright — Manual-posting-method rows
 * (the carousel fallback) don't depend on the token at all.
 */
export const linkedinPublishWatch = schedules.task({
  id: "linkedin-publish-watch",
  cron: "*/15 * * * *",
  maxDuration: 60,

  run: async () => {
    if (!LINKEDIN_ACCESS_TOKEN || !LINKEDIN_PERSON_URN) {
      logger.warn("linkedin-publish-watch: LINKEDIN_ACCESS_TOKEN / LINKEDIN_PERSON_URN not set — skipping this tick. Run linkedin-engine/auth.js.");
      return { triggered: 0 };
    }
    if (LINKEDIN_TOKEN_EXPIRES_AT) {
      const daysLeft = (new Date(LINKEDIN_TOKEN_EXPIRES_AT).getTime() - Date.now()) / 86400000;
      if (daysLeft < 7) {
        logger.warn(`linkedin-publish-watch: LinkedIn token expires in ${daysLeft.toFixed(1)} day(s) — re-run linkedin-engine/auth.js soon.`);
      }
    }

    const nowIso = new Date().toISOString();
    const rows = await listRecords(LINKEDIN_BASE_ID, LINKEDIN_POSTS_TABLE, {
      filterFormula: `AND({Status} = "Approved", {Posting Method} = "Auto", {Platform} = "LinkedIn", IS_BEFORE({Scheduled Time}, "${nowIso}"))`,
      maxRecords: 5,
    });

    if (rows.length === 0) {
      logger.info("linkedin-publish-watch: nothing due");
      return { triggered: 0 };
    }

    rows.sort((a: any, b: any) => String(a.fields["Scheduled Time"]).localeCompare(String(b.fields["Scheduled Time"])));

    const triggered: string[] = [];
    for (const row of rows) {
      await tasks.trigger<typeof linkedinPublishPost>("linkedin-publish-post", { recordId: row.id }, {
        idempotencyKey: `publish-${row.id}`,
        idempotencyKeyTTL: "30d",
      });
      triggered.push(row.id);
    }

    logger.info(`linkedin-publish-watch: triggered ${triggered.length}`, { triggered });
    return { triggered: triggered.length, recordIds: triggered };
  },
});
