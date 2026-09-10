import { task, logger } from "@trigger.dev/sdk/v3";
import { getRecord, updateRecords } from "../src/airtable/xbase.js";
import { publishRecord, TokenExpiredError } from "../src/linkedin/api.js";
import {
  LINKEDIN_BASE_ID, LINKEDIN_POSTS_TABLE, LINKEDIN_ACCESS_TOKEN, LINKEDIN_PERSON_URN,
} from "../src/config.js";

interface PublishPayload {
  recordId: string;
}

/**
 * linkedin-publish-post — per-row publish worker.
 *
 * retry.maxAttempts is pinned to 1 (overriding the project default of 3):
 * a retry after the LinkedIn POST already succeeded but before the
 * Airtable write-back landed would publish the SAME row a second time.
 * Safer to fail once, land it in Needs Fix with the error attached, and
 * let a human (or the next scheduled watch tick, via a fresh Approve) run
 * it again deliberately.
 *
 * Guards against ever publishing a non-Approved row twice over: checked
 * once here (in addition to the watcher's own filter) in case the row
 * changed between the watcher's scan and this worker actually running.
 */
export const linkedinPublishPost = task({
  id: "linkedin-publish-post",
  maxDuration: 300,
  retry: { maxAttempts: 1 },

  run: async (payload: PublishPayload) => {
    const { recordId } = payload;
    const row = await getRecord(LINKEDIN_BASE_ID, LINKEDIN_POSTS_TABLE, recordId);

    if (row.fields["Status"] !== "Approved") {
      logger.info(`linkedin-publish-post: ${recordId} is "${row.fields["Status"]}", not Approved — skipping`);
      return { skipped: true };
    }
    if (!LINKEDIN_ACCESS_TOKEN || !LINKEDIN_PERSON_URN) {
      throw new Error("LINKEDIN_ACCESS_TOKEN / LINKEDIN_PERSON_URN not configured in this environment");
    }

    await updateRecords(LINKEDIN_BASE_ID, LINKEDIN_POSTS_TABLE, [{
      id: recordId,
      fields: { Status: "Publishing", "Publish Attempted At": new Date().toISOString() },
    }]);

    try {
      const { urn, url } = await publishRecord(row, { token: LINKEDIN_ACCESS_TOKEN, personUrn: LINKEDIN_PERSON_URN });
      await updateRecords(LINKEDIN_BASE_ID, LINKEDIN_POSTS_TABLE, [{
        id: recordId,
        fields: { Status: "Posted", "Post URN": urn, "Posted URL": url, "Posted At": new Date().toISOString() },
      }]);
      logger.info(`linkedin-publish-post: ${recordId} posted — ${url}`);
      return { posted: true, url, urn };
    } catch (err: any) {
      const detail = err instanceof TokenExpiredError ? err.message : String(err?.message || err);
      const existingNotes = row.fields["Review Notes"] || "";
      await updateRecords(LINKEDIN_BASE_ID, LINKEDIN_POSTS_TABLE, [{
        id: recordId,
        fields: {
          Status: "Needs Fix",
          "Review Notes": `${existingNotes}${existingNotes ? "\n" : ""}[publish error ${new Date().toISOString()}] ${detail}`,
        },
      }]);
      logger.error(`linkedin-publish-post: ${recordId} failed — ${detail}`);
      throw err; // surface red in the Trigger.dev dashboard; write-back above already happened
    }
  },
});
