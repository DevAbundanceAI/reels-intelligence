import { task, logger } from "@trigger.dev/sdk/v3";
import { scrapeCreatorReels, scrapeCreatorProfile } from "../src/scrapers/apify.js";
import { normalizeReels }       from "../src/scrapers/instagram.js";
import { analyzeReels, generateAndSaveRunSummary } from "../src/analyzers/claude.js";
import { buildMetrics }         from "../src/utils/engagement.js";
import { loadBrandDna, renderBrandDnaPrompt } from "../src/brand/dna.js";
import {
  getExistingReels,
  classifyReels,
  upsertCreator,
  updateCreatorFollowers,
  syncReelsToAirtable,
  syncUnanalyzedReels,
  saveCreatorAnalysis,
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
    const { username, displayName, reelsLimit } = payload;
    logger.info(`Starting scrape for @${username}`);

    // 0. Load Brand DNA once per run. Missing DNA is non-fatal — pipeline
    // falls back to generic analysis and the user gets a clear log.
    let brandDnaPrompt: string | null = null;
    try {
      const dna = await loadBrandDna();
      brandDnaPrompt = renderBrandDnaPrompt(dna);
      logger.info(`Brand DNA: "${dna.brandName}" loaded — analyzer will score brand fit`);
    } catch (e) {
      logger.warn(`Brand DNA not loaded — running generic analysis. ${(e as Error).message}`);
    }

    // 1. Scrape via Apify
    const rawReels = await scrapeCreatorReels(username, reelsLimit);
    logger.info(`Apify: ${rawReels.length} raw reels fetched`);

    // 2. Normalize
    const reels = normalizeReels(rawReels, username);

    // 3. Upsert creator (always — updates lastScraped)
    const creatorRecordId = await upsertCreator(payload);

    // 3a. Fetch follower count in background (fire-and-forget)
    scrapeCreatorProfile(username).then((profile: { followersCount: number } | null) => {
      if (profile?.followersCount) {
        updateCreatorFollowers(creatorRecordId, profile.followersCount);
      }
    }).catch((e: Error) => logger.warn(`Profile scrape failed for @${username}: ${e.message}`));

    // 4. Classify: brand new / needs analysis / already done
    const existingMap = await getExistingReels(username);
    const { brandNew, needsAnalysis, done } = classifyReels(reels, existingMap);

    logger.info(`Classification: ${brandNew.length} new, ${needsAnalysis.length} unanalyzed, ${done} done`);

    let totalCreated = 0;
    let totalPatched = 0;

    // --- Path A: Brand new reels ---
    if (brandNew.length > 0) {
      const withMetrics = brandNew.map(r => ({ ...r, ...buildMetrics(r) }));
      const analyzed = await analyzeReels(withMetrics, { brandDnaPrompt });
      totalCreated = await syncReelsToAirtable(analyzed, creatorRecordId);
    }

    // --- Path B: Existing reels that never got analyzed ---
    if (needsAnalysis.length > 0) {
      logger.info(`Re-analyzing ${needsAnalysis.length} previously unanalyzed reels...`);

      const reelsToAnalyze = needsAnalysis.map(({ reel }: { reel: any }) => ({
        ...reel,
        ...buildMetrics(reel),
      }));

      const analyzed = await analyzeReels(reelsToAnalyze, { brandDnaPrompt });

      const patchPayload = needsAnalysis.map(({ reel, airtableId }: { reel: any; airtableId: string }, i: number) => ({
        reel: { ...reel, aiAnalysis: analyzed[i]?.aiAnalysis },
        airtableId,
      }));

      totalPatched = await syncUnanalyzedReels(patchPayload);
    }

    // 5. Save run summary to Analyses table (fetches from Airtable — accurate metrics)
    await generateAndSaveRunSummary(username, creatorRecordId);

    // 6. Save/update Creator Analysis table
    await saveCreatorAnalysis({ username, displayName: displayName || username });

    const summary = {
      username,
      fetched:     reels.length,
      brandNew:    brandNew.length,
      created:     totalCreated,
      reanalyzed:  needsAnalysis.length,
      patched:     totalPatched,
      alreadyDone: done,
    };

    logger.info(`Done for @${username}`, summary);
    return summary;
  },
});
