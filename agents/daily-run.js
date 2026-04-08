#!/usr/bin/env node
/**
 * daily-run.js — Main orchestrator
 *
 * Usage:
 *   node agents/daily-run.js                          # all creators
 *   node agents/daily-run.js --creator officialjoelkaplan    # single creator
 *   node agents/daily-run.js --limit 5                # override reel limit
 */

import { readFileSync } from 'fs';
import '../src/config.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { scrapeCreatorReels, scrapeCreatorProfile } from '../src/scrapers/apify.js';
import { normalizeReels }            from '../src/scrapers/instagram.js';
import { analyzeReels, generateAndSaveRunSummary } from '../src/analyzers/claude.js';
import { buildMetrics }              from '../src/utils/engagement.js';
import { logger }                    from '../src/utils/logger.js';
import { toISODate }                 from '../src/utils/helpers.js';
import {
  getExistingReels,
  classifyReels,
  upsertCreator,
  updateCreatorFollowers,
  syncReelsToAirtable,
  syncUnanalyzedReels,
  saveCreatorAnalysis,
  saveCumulativeAnalysis,
} from '../src/airtable/sync.js';
import { listRecords, createRecords } from '../src/airtable/client.js';
import {
  RUNS_TABLE, RUNS_FIELDS,
  CREATORS_TABLE, CREATORS_FIELDS,
} from '../src/airtable/schema.js';
import { airtableFormula } from '../src/utils/helpers.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const targetsPath = join(__dir, '..', 'config', 'targets.json');

// --- CLI args ---
const args = process.argv.slice(2);
const creatorIdx    = args.indexOf('--creator');
const limitIdx      = args.indexOf('--limit');
const singleCreator = creatorIdx !== -1 ? args[creatorIdx + 1] : null;
const limitOverride = limitIdx   !== -1 ? args[limitIdx   + 1] : null;

// --- Load targets ---
const { creators, defaults } = JSON.parse(readFileSync(targetsPath, 'utf8'));
const activeCreators = creators.filter(c => {
  if (!c.active) return false;
  if (singleCreator) return c.username === singleCreator;
  return true;
});

if (!activeCreators.length) {
  logger.warn(singleCreator
    ? `Creator "${singleCreator}" not found or inactive in config/targets.json`
    : 'No active creators in config/targets.json');
  process.exit(0);
}

logger.info(`Starting run for ${activeCreators.length} creator(s)`);

/**
 * Check if a creator was scraped recently enough to skip.
 * Returns true if the creator was scraped within skipHours hours.
 */
async function shouldSkipCreator(username, skipHours) {
  if (!skipHours) return false;
  try {
    const records = await listRecords(CREATORS_TABLE, {
      filterFormula: airtableFormula(CREATORS_FIELDS.username, username),
      fields: [CREATORS_FIELDS.lastScraped],
      maxRecords: 1,
    });
    if (!records.length || !records[0].fields[CREATORS_FIELDS.lastScraped]) return false;
    const hoursSince = (Date.now() - new Date(records[0].fields[CREATORS_FIELDS.lastScraped])) / 3600000;
    return hoursSince < skipHours;
  } catch (e) {
    logger.warn(`Could not check lastScraped for @${username}: ${e.message}`);
    return false;
  }
}

const runStats = {
  startedAt:    new Date().toISOString(),
  creatorsRun:  0,
  reelsFetched: 0,
  reelsNew:     0,
  errors:       [],
};

// Track processed creators to avoid double-processing within one run
const processedCreators = new Set();

// Collect all creators actually processed (for cumulative analysis)
const processedCreatorNames = [];

for (const creator of activeCreators) {
  // Dedup: skip if already processed in this run
  if (processedCreators.has(creator.username)) {
    logger.info(`Skipping @${creator.username} — already processed in this run`);
    continue;
  }
  processedCreators.add(creator.username);

  // Dedup: skip if scraped too recently
  if (await shouldSkipCreator(creator.username, defaults.skipIfScrapedWithinHours)) {
    logger.info(`Skipping @${creator.username} — scraped within last ${defaults.skipIfScrapedWithinHours}h`);
    continue;
  }

  const limit = parseInt(limitOverride || creator.reelsLimit || defaults.reelsLimit);
  logger.info(`\n── @${creator.username} (${creator.niche}) — limit: ${limit}`);

  try {
    // 1. Scrape
    const rawReels = await scrapeCreatorReels(creator.username, limit);

    // 2. Normalize
    const reels = normalizeReels(rawReels, creator.username);
    runStats.reelsFetched += reels.length;
    logger.success(`Normalized: ${reels.length} reels`);

    // 3. Classify: brand new / needs analysis / already done
    const existingMap = await getExistingReels(creator.username);
    const { brandNew, needsAnalysis, done } = classifyReels(reels, existingMap);

    // 4. Upsert creator — always (updates lastScraped)
    const creatorRecordId = await upsertCreator(creator);

    // 4a. Fetch follower count in background (fire-and-forget)
    scrapeCreatorProfile(creator.username).then(profile => {
      if (profile?.followersCount) {
        updateCreatorFollowers(creatorRecordId, profile.followersCount);
      }
    }).catch(e => logger.warn(`Profile scrape failed for @${creator.username}: ${e.message}`));

    if (!brandNew.length && !needsAnalysis.length) {
      logger.info('No new or unanalyzed reels — skipping analysis');
      runStats.creatorsRun++;
      processedCreatorNames.push(creator.username);
      await generateAndSaveRunSummary(creator.username, creatorRecordId);
      await saveCreatorAnalysis({ username: creator.username, displayName: creator.displayName || creator.username });
      continue;
    }

    // 5. Compute engagement metrics
    const reelsWithMetrics = brandNew.map(r => ({ ...r, ...buildMetrics(r) }));

    // 6. AI analysis for brand new reels
    let analyzed = [];
    if (brandNew.length > 0) {
      analyzed = await analyzeReels(reelsWithMetrics);
    }

    // 7. Sync new reels — Airtable
    let created = 0;
    if (analyzed.length > 0) {
      created = await syncReelsToAirtable(analyzed, creatorRecordId);
    }

    // 8. Re-analyze and patch previously unanalyzed reels
    let patched = 0;
    if (needsAnalysis.length > 0) {
      logger.info(`Re-analyzing ${needsAnalysis.length} previously unanalyzed reels...`);
      const reelsToReanalyze = needsAnalysis.map(({ reel }) => ({
        ...reel,
        ...buildMetrics(reel),
      }));
      const reanalyzed = await analyzeReels(reelsToReanalyze);
      const patchPayload = needsAnalysis.map(({ reel, airtableId }, i) => ({
        reel: { ...reel, aiAnalysis: reanalyzed[i]?.aiAnalysis },
        airtableId,
      }));
      patched = await syncUnanalyzedReels(patchPayload);
    }

    runStats.reelsNew  += created;
    runStats.creatorsRun++;
    processedCreatorNames.push(creator.username);
    logger.success(`@${creator.username}: ${created} new, ${patched} patched, ${done} skipped`);

    // 9. Save run summary to Analyses table (fetches from Airtable — accurate metrics)
    await generateAndSaveRunSummary(creator.username, creatorRecordId);

    // 10. Save/update Creator Analysis table
    await saveCreatorAnalysis({ username: creator.username, displayName: creator.displayName || creator.username });

  } catch (e) {
    logger.error(`Failed for @${creator.username}`, e.message);
    runStats.errors.push(`@${creator.username}: ${e.message}`);
    // Continue to next creator
  }
}

// --- Cumulative Analysis (2+ creators processed) ---
if (processedCreatorNames.length >= 2) {
  logger.info(`\nSaving cumulative analysis for ${processedCreatorNames.length} creators...`);
  await saveCumulativeAnalysis({ creators: processedCreatorNames });
}

// --- Log run to Airtable ---
const runStatus = runStats.errors.length === 0 ? 'Success'
  : runStats.creatorsRun > 0 ? 'Partial'
  : 'Failed';

try {
  await createRecords(RUNS_TABLE, [{
    [RUNS_FIELDS.runAt]:        toISODate(),
    [RUNS_FIELDS.creatorsRun]:  runStats.creatorsRun,
    [RUNS_FIELDS.reelsFetched]: runStats.reelsFetched,
    [RUNS_FIELDS.reelsNew]:     runStats.reelsNew,
    [RUNS_FIELDS.errors]:       runStats.errors.join('\n') || '',
    [RUNS_FIELDS.status]:       runStatus,
  }]);
} catch (e) {
  logger.warn('Could not log run to Airtable: ' + e.message);
}

// --- Summary ---
logger.info('\n─────────── RUN COMPLETE ───────────');
logger.success(`Creators run:   ${runStats.creatorsRun}`);
logger.success(`Reels fetched:  ${runStats.reelsFetched}`);
logger.success(`Reels new:      ${runStats.reelsNew}`);
if (runStats.errors.length) {
  logger.warn(`Errors:         ${runStats.errors.length}`);
  runStats.errors.forEach(e => logger.warn('  ' + e));
}
