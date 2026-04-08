#!/usr/bin/env node
/**
 * daily-run.js — Main orchestrator
 *
 * Usage:
 *   node agents/daily-run.js                          # all creators
 *   node agents/daily-run.js --creator alexhormozi    # single creator
 *   node agents/daily-run.js --limit 5                # override reel limit
 */

import { readFileSync } from 'fs';
import '../src/config.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { scrapeCreatorReels }        from '../src/scrapers/apify.js';
import { normalizeReels }            from '../src/scrapers/instagram.js';
import { analyzeReels }              from '../src/analyzers/claude.js';
import { buildMetrics }              from '../src/utils/engagement.js';
import { logger }                    from '../src/utils/logger.js';
import {
  getExistingReels,
  classifyReels,
  upsertCreator,
  syncReelsToAirtable,
  syncUnanalyzedReels,
} from '../src/airtable/sync.js';
import { createRecords }             from '../src/airtable/client.js';
import { RUNS_TABLE, RUNS_FIELDS }   from '../src/airtable/schema.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const targetsPath = join(__dir, '..', 'config', 'targets.json');

// --- CLI args ---
const args = process.argv.slice(2);
const singleCreator = args[args.indexOf('--creator') + 1] || null;
const limitOverride = args[args.indexOf('--limit') + 1]   || null;

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

const runStats = {
  startedAt:    new Date().toISOString(),
  creatorsRun:  0,
  reelsFetched: 0,
  reelsNew:     0,
  errors:       [],
};

for (const creator of activeCreators) {
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

    if (!brandNew.length && !needsAnalysis.length) {
      logger.info('No new or unanalyzed reels — skipping analysis');
      runStats.creatorsRun++;
      continue;
    }

    // 4. Compute engagement metrics
    const reelsWithMetrics = brandNew.map(r => ({ ...r, ...buildMetrics(r) }));

    // 5. AI analysis for brand new reels
    let analyzed = [];
    if (brandNew.length > 0) {
      analyzed = await analyzeReels(reelsWithMetrics);
    }

    // 6. Upsert creator — Airtable
    const creatorRecordId = await upsertCreator(creator);

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
    logger.success(`@${creator.username}: ${created} new, ${patched} patched, ${done} skipped`);

  } catch (e) {
    logger.error(`Failed for @${creator.username}`, e.message);
    runStats.errors.push(`@${creator.username}: ${e.message}`);
    // Continue to next creator
  }
}

// --- Log run to Airtable ---
const runStatus = runStats.errors.length === 0 ? 'Success'
  : runStats.creatorsRun > 0 ? 'Partial'
  : 'Failed';

try {
  await createRecords(RUNS_TABLE, [{
    [RUNS_FIELDS.runAt]:        new Date().toISOString().slice(0, 10),
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
