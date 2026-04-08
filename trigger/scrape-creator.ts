import { task, logger } from "@trigger.dev/sdk/v3";
import { scrapeCreatorReels }   from "../src/scrapers/apify.js";
import { normalizeReels }       from "../src/scrapers/instagram.js";
import { analyzeReels }         from "../src/analyzers/claude.js";
import { buildMetrics }         from "../src/utils/engagement.js";
import {
  getExistingReels,
  classifyReels,
  upsertCreator,
  syncReelsToAirtable,
  syncUnanalyzedReels,
} from "../src/airtable/sync.js";

interface CreatorPayload {
  username:    string;
  displayName: string;
  niche:       string;
  reelsLimit:  number;
}

export const scrapeCreator = task({
  id: "scrape-creator",
  maxDuration: 600,

  run: async (payload: CreatorPayload) => {
    const { username, reelsLimit } = payload;
    logger.info(`Starting scrape for @${username}`);

    // 1. Scrape via Apify
    const rawReels = await scrapeCreatorReels(username, reelsLimit);
    logger.info(`Apify: ${rawReels.length} raw reels fetched`);

    // 2. Normalize
    const reels = normalizeReels(rawReels, username);

    // 3. Classify: brand new / needs analysis / already done
    const existingMap = await getExistingReels(username);
    const { brandNew, needsAnalysis, done } = classifyReels(reels, existingMap);

    logger.info(`Classification: ${brandNew.length} new, ${needsAnalysis.length} unanalyzed, ${done} done`);

    let totalCreated = 0;
    let totalPatched = 0;

    // --- Path A: Brand new reels ---
    if (brandNew.length > 0) {
      // Engagement metrics
      const withMetrics = brandNew.map(r => ({ ...r, ...buildMetrics(r) }));

      // Claude analysis — only new reels go here
      const analyzed = await analyzeReels(withMetrics);

      // Upsert creator record
      const creatorRecordId = await upsertCreator(payload);

      // Write to Airtable (aiAnalyzed=true if analysis succeeded)
      totalCreated = await syncReelsToAirtable(analyzed, creatorRecordId);
    }

    // --- Path B: Existing reels that never got analyzed ---
    // These were stored in a previous run where Claude failed or was skipped.
    // Re-run analysis on them now and patch the Airtable records.
    if (needsAnalysis.length > 0) {
      logger.info(`Re-analyzing ${needsAnalysis.length} previously unanalyzed reels...`);

      // Pull just the reel objects for Claude
      const reelsToAnalyze = needsAnalysis.map(({ reel }) => ({
        ...reel,
        ...buildMetrics(reel),
      }));

      const analyzed = await analyzeReels(reelsToAnalyze);

      // Stitch analysis back onto the { reel, airtableId } pairs
      const patchPayload = needsAnalysis.map(({ reel, airtableId }, i) => ({
        reel: { ...reel, aiAnalysis: analyzed[i]?.aiAnalysis },
        airtableId,
      }));

      totalPatched = await syncUnanalyzedReels(patchPayload);
    }

    const summary = {
      username,
      fetched:          reels.length,
      brandNew:         brandNew.length,
      created:          totalCreated,
      reanalyzed:       needsAnalysis.length,
      patched:          totalPatched,
      alreadyDone:      done,
      claudeCallsMade:  brandNew.length > 0 || needsAnalysis.length > 0 ? 1 : 0,
    };

    logger.info(`Done for @${username}`, summary);
    return summary;
  },
});
