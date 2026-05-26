import { listRecords, createRecords, updateRecords } from './client.js';
import { CLAUDE_MODEL } from '../config.js';
import {
  REELS_TABLE, REELS_FIELDS,
  CREATORS_TABLE, CREATORS_FIELDS,
  CREATOR_ANALYSIS_TABLE, CREATOR_ANALYSIS_FIELDS,
  CUMULATIVE_ANALYSIS_TABLE, CUMULATIVE_ANALYSIS_FIELDS,
} from './schema.js';
import { toISODate, airtableFormula } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

// ─────────────────────────────────────────────────────────────
// DEDUP HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Get a map of reelId → { airtableId, aiAnalyzed } for a given username.
 * Covers both dedup (already stored) and analysis guard (already analyzed).
 */
export async function getExistingReels(username) {
  const records = await listRecords(REELS_TABLE, {
    filterFormula: airtableFormula(REELS_FIELDS.username, username),
    fields: [REELS_FIELDS.reelId, REELS_FIELDS.aiAnalyzed],
  });

  const map = new Map();
  for (const r of records) {
    const reelId = r.fields[REELS_FIELDS.reelId];
    if (reelId) {
      map.set(reelId, {
        airtableId: r.id,
        aiAnalyzed: r.fields[REELS_FIELDS.aiAnalyzed] === true,
      });
    }
  }
  return map;
}

/**
 * Split scraped reels into three buckets:
 * - brandNew:      not in Airtable → store + analyze
 * - needsAnalysis: stored but aiAnalyzed=false → analyze + patch
 * - done:          aiAnalyzed=true → skip entirely (zero Claude calls)
 */
export function classifyReels(reels, existingMap) {
  const brandNew      = [];
  const needsAnalysis = [];
  let   done          = 0;

  for (const reel of reels) {
    const existing = existingMap.get(reel.reelId);
    if (!existing) {
      brandNew.push(reel);
    } else if (!existing.aiAnalyzed) {
      needsAnalysis.push({ reel, airtableId: existing.airtableId });
      logger.info(`Queued for re-analysis (no AI yet): ${reel.reelId}`);
    } else {
      done++;
    }
  }

  if (done > 0)            logger.info(`Dedup: ${done} reels already fully analyzed — skipping`);
  if (needsAnalysis.length) logger.info(`Dedup: ${needsAnalysis.length} reels stored but not yet analyzed — queuing`);
  if (brandNew.length)      logger.info(`Dedup: ${brandNew.length} brand new reels`);

  return { brandNew, needsAnalysis, done };
}

// ─────────────────────────────────────────────────────────────
// CREATOR SYNC
// ─────────────────────────────────────────────────────────────

/**
 * Upsert a creator record. Always updates lastScraped.
 * Returns the Airtable record ID.
 */
export async function upsertCreator(creator) {
  const existing = await listRecords(CREATORS_TABLE, {
    filterFormula: airtableFormula(CREATORS_FIELDS.username, creator.username),
    maxRecords: 1,
  });

  const fields = {
    [CREATORS_FIELDS.username]:    creator.username,
    [CREATORS_FIELDS.displayName]: creator.displayName || creator.username,
    [CREATORS_FIELDS.niche]:       creator.niche || '',
    [CREATORS_FIELDS.active]:      true,
    [CREATORS_FIELDS.lastScraped]: toISODate(),
  };

  if (existing.length > 0) {
    const id = existing[0].id;
    await updateRecords(CREATORS_TABLE, [{ id, fields }]);
    return id;
  }

  const created = await createRecords(CREATORS_TABLE, [fields]);
  return created[0].id;
}

/**
 * Update the follower count on a creator record.
 * Called after scrapeCreatorProfile() — fire-and-forget, never throws.
 */
export async function updateCreatorFollowers(creatorId, followersCount) {
  if (!creatorId || !followersCount) return;
  try {
    await updateRecords(CREATORS_TABLE, [{
      id: creatorId,
      fields: { [CREATORS_FIELDS.followersCount]: followersCount },
    }]);
    logger.success(`Followers updated: ${followersCount.toLocaleString()}`);
  } catch (e) {
    logger.warn(`Could not update followers: ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────
// REEL SYNC
// ─────────────────────────────────────────────────────────────

/**
 * Map a fully-analyzed reel to Airtable field values.
 */
function reelToFields(reel, analyzed = false) {
  const a   = reel.aiAnalysis || {};
  const now = toISODate();

  return {
    [REELS_FIELDS.reelId]:         reel.reelId,
    [REELS_FIELDS.url]:            reel.url,
    [REELS_FIELDS.username]:       reel.username,
    [REELS_FIELDS.caption]:        (reel.caption || '').slice(0, 100000),
    [REELS_FIELDS.transcript]:     (reel.transcript || '').slice(0, 100000),
    [REELS_FIELDS.hashtags]:       (reel.hashtags || []).join(', '),
    [REELS_FIELDS.hook]:           a.hook || '',
    [REELS_FIELDS.audioTitle]:     reel.audioTitle || '',

    // Metrics
    [REELS_FIELDS.views]:          reel.views,
    [REELS_FIELDS.playCount]:      reel.videoPlayCount || 0,
    [REELS_FIELDS.likes]:          reel.likes,
    [REELS_FIELDS.comments]:       reel.comments,
    [REELS_FIELDS.shares]:         reel.sharesCount || 0,
    [REELS_FIELDS.duration]:       reel.duration || null,

    // Engagement
    [REELS_FIELDS.engagementScore]: reel.engagementScore,
    [REELS_FIELDS.likeRatio]:       reel.likeRatio,
    [REELS_FIELDS.commentRatio]:    reel.commentRatio,
    [REELS_FIELDS.engagementTier]:  reel.engagementTier,

    // AI Analysis
    [REELS_FIELDS.mainTopic]:      a.mainTopic    || '',
    [REELS_FIELDS.topics]:         (a.topics || []).join(', '),
    [REELS_FIELDS.contentType]:    a.contentType  || 'Other',
    [REELS_FIELDS.keyPoints]:      (a.keyPoints || []).join('\n• '),
    [REELS_FIELDS.targetAudience]: a.targetAudience || '',
    [REELS_FIELDS.emotionalTone]:  a.emotionalTone  || '',
    [REELS_FIELDS.hookType]:       a.hookType     || 'Other',
    [REELS_FIELDS.hookCategory]:   a.hookCategory || 'Other',
    [REELS_FIELDS.ctaType]:        a.ctaType      || 'None',
    [REELS_FIELDS.ctaPlacement]:   a.ctaPlacement || 'None',

    // Brand fit — only populated when Brand DNA was loaded for this run.
    // When absent, leave both empty so Airtable doesn't force a default value.
    ...(a.brandFit       ? { [REELS_FIELDS.brandFit]:       a.brandFit }       : {}),
    ...(a.brandFitReason ? { [REELS_FIELDS.brandFitReason]: a.brandFitReason } : {}),

    // Analysis status guard
    [REELS_FIELDS.aiAnalyzed]:     analyzed,
    [REELS_FIELDS.analyzedAt]:     analyzed ? now : null,
    [REELS_FIELDS.analysisModel]:  analyzed ? CLAUDE_MODEL : '',

    // Timestamps
    [REELS_FIELDS.publishedAt]: reel.publishedAt
      ? new Date(reel.publishedAt).toISOString().slice(0, 10)
      : null,
    [REELS_FIELDS.scrapedAt]: reel.scrapedAt
      ? new Date(reel.scrapedAt).toISOString().slice(0, 10)
      : now,
  };
}

/**
 * Write brand new reels to Airtable.
 */
export async function syncReelsToAirtable(reels, creatorRecordId) {
  if (!reels.length) {
    logger.info('No new reels to sync');
    return 0;
  }

  logger.info(`Airtable: writing ${reels.length} new reels...`);

  const fieldSets = reels.map(r => {
    const hasAnalysis = r.aiAnalysis && r.aiAnalysis.mainTopic !== 'Unknown';
    return reelToFields(r, hasAnalysis);
  });

  let created = 0;
  try {
    const records = await createRecords(REELS_TABLE, fieldSets);
    created = records.length;
    logger.success(`Airtable: created ${created} reel records`);
  } catch (e) {
    logger.warn(`Batch write failed — trying one-by-one: ${e.message}`);
    for (const fields of fieldSets) {
      try {
        await createRecords(REELS_TABLE, [fields]);
        created++;
      } catch (err) {
        logger.error(`Skipped reel ${fields[REELS_FIELDS.reelId]}: ${err.message}`);
      }
    }
  }

  return created;
}

/**
 * Patch AI analysis fields onto existing records that were stored but never analyzed.
 */
export async function syncUnanalyzedReels(analyzedReels) {
  if (!analyzedReels.length) return 0;

  logger.info(`Airtable: patching analysis onto ${analyzedReels.length} existing records...`);
  let updated = 0;
  const now = toISODate();

  for (const { reel, airtableId } of analyzedReels) {
    const a = reel.aiAnalysis || {};
    try {
      await updateRecords(REELS_TABLE, [{
        id: airtableId,
        fields: {
          [REELS_FIELDS.hook]:           a.hook           || '',
          [REELS_FIELDS.mainTopic]:      a.mainTopic      || '',
          [REELS_FIELDS.topics]:         (a.topics || []).join(', '),
          [REELS_FIELDS.contentType]:    a.contentType    || 'Other',
          [REELS_FIELDS.keyPoints]:      (a.keyPoints || []).join('\n• '),
          [REELS_FIELDS.targetAudience]: a.targetAudience || '',
          [REELS_FIELDS.emotionalTone]:  a.emotionalTone  || '',
          [REELS_FIELDS.hookType]:       a.hookType       || 'Other',
          [REELS_FIELDS.hookCategory]:   a.hookCategory   || 'Other',
          [REELS_FIELDS.ctaType]:        a.ctaType        || 'None',
          [REELS_FIELDS.ctaPlacement]:   a.ctaPlacement   || 'None',
          [REELS_FIELDS.aiAnalyzed]:     true,
          [REELS_FIELDS.analyzedAt]:     now,
          [REELS_FIELDS.analysisModel]:  CLAUDE_MODEL,
        },
      }]);
      updated++;
      logger.success(`Updated analysis for existing record: ${airtableId}`);
    } catch (e) {
      logger.error(`Failed to patch ${airtableId}: ${e.message}`);
    }
  }

  logger.success(`Airtable: patched ${updated} existing records with AI analysis`);
  return updated;
}

// ─────────────────────────────────────────────────────────────
// CREATOR ANALYSIS — per-creator summary, upserted after each run
// ─────────────────────────────────────────────────────────────

/**
 * Compute engagement stats from an array of Airtable reel field objects.
 * Used by both saveCreatorAnalysis and saveCumulativeAnalysis.
 */
function computeReelStats(fieldSets) {
  const tiers = { HIGH: 0, MID: 0, LOW: 0 };
  const topicCount = {};
  const hookTypeCount = {};
  const contentTypeCount = {};
  let totalScore = 0;
  let totalViews = 0;

  for (const f of fieldSets) {
    const tier = f[REELS_FIELDS.engagementTier] || f.engagementTier || 'LOW';
    tiers[tier] = (tiers[tier] || 0) + 1;
    totalScore += parseFloat(f[REELS_FIELDS.engagementScore] ?? f.engagementScore ?? 0);
    totalViews += parseInt(f[REELS_FIELDS.views] ?? f.views ?? 0);

    const topic = f[REELS_FIELDS.mainTopic] ?? f.mainTopic;
    if (topic && topic !== 'Unknown') topicCount[topic] = (topicCount[topic] || 0) + 1;

    const hookType = f[REELS_FIELDS.hookType] ?? f.hookType;
    if (hookType && hookType !== 'Other') hookTypeCount[hookType] = (hookTypeCount[hookType] || 0) + 1;

    const ct = f[REELS_FIELDS.contentType] ?? f.contentType;
    if (ct && ct !== 'Other') contentTypeCount[ct] = (contentTypeCount[ct] || 0) + 1;
  }

  const n = fieldSets.length || 1;
  return {
    tiers,
    totalScore,
    totalViews,
    avgScore:  parseFloat((totalScore / n).toFixed(4)),
    avgViews:  Math.round(totalViews / n),
    topTopics: Object.entries(topicCount).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t).join(', '),
    topHooks:  Object.entries(hookTypeCount).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t).join(', '),
    topTypes:  Object.entries(contentTypeCount).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t).join(', '),
  };
}

/**
 * Upsert a record in Creator Analysis table after each creator run.
 * Fetches reel data from Airtable to ensure accurate metrics.
 */
export async function saveCreatorAnalysis({ username, displayName, contentFormula = '', keyTakeaways = '', reportFile = '' }) {
  try {
    // Fetch all analyzed reels for this creator from Airtable
    const records = await listRecords(REELS_TABLE, {
      filterFormula: `AND(${airtableFormula(REELS_FIELDS.username, username)}, {${REELS_FIELDS.aiAnalyzed}} = TRUE())`,
      fields: [
        REELS_FIELDS.engagementScore, REELS_FIELDS.engagementTier,
        REELS_FIELDS.views, REELS_FIELDS.mainTopic,
        REELS_FIELDS.hookType, REELS_FIELDS.contentType,
      ],
    });

    if (!records.length) {
      logger.warn(`No analyzed reels found for @${username} — skipping Creator Analysis`);
      return null;
    }

    const stats = computeReelStats(records.map(r => r.fields));

    const fields = {
      [CREATOR_ANALYSIS_FIELDS.username]:           username,
      [CREATOR_ANALYSIS_FIELDS.displayName]:        displayName || username,
      [CREATOR_ANALYSIS_FIELDS.totalReels]:         records.length,
      [CREATOR_ANALYSIS_FIELDS.avgEngagementScore]: stats.avgScore,
      [CREATOR_ANALYSIS_FIELDS.highCount]:          stats.tiers.HIGH,
      [CREATOR_ANALYSIS_FIELDS.midCount]:           stats.tiers.MID,
      [CREATOR_ANALYSIS_FIELDS.lowCount]:           stats.tiers.LOW,
      [CREATOR_ANALYSIS_FIELDS.topTopics]:          stats.topTopics,
      [CREATOR_ANALYSIS_FIELDS.topHookTypes]:       stats.topHooks,
      [CREATOR_ANALYSIS_FIELDS.topContentTypes]:    stats.topTypes,
      [CREATOR_ANALYSIS_FIELDS.contentFormula]:     contentFormula,
      [CREATOR_ANALYSIS_FIELDS.keyTakeaways]:       keyTakeaways,
      [CREATOR_ANALYSIS_FIELDS.reportFile]:         reportFile,
      [CREATOR_ANALYSIS_FIELDS.lastAnalyzed]:       toISODate(),
    };

    const existing = await listRecords(CREATOR_ANALYSIS_TABLE, {
      filterFormula: airtableFormula(CREATOR_ANALYSIS_FIELDS.username, username),
      maxRecords: 1,
    });

    if (existing.length > 0) {
      await updateRecords(CREATOR_ANALYSIS_TABLE, [{ id: existing[0].id, fields }]);
    } else {
      await createRecords(CREATOR_ANALYSIS_TABLE, [fields]);
    }

    logger.success(`Creator Analysis saved for @${username} (${records.length} reels, avg score: ${stats.avgScore})`);
  } catch (e) {
    logger.warn(`Could not save Creator Analysis for @${username}: ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────
// CUMULATIVE ANALYSIS — cross-creator summary after multi-creator runs
// ─────────────────────────────────────────────────────────────

/**
 * Create a Cumulative Analysis record after a run with 2+ creators.
 * Always creates (never upserts) — one record per run.
 */
export async function saveCumulativeAnalysis({ creators, reportContent = '', reportFile = '' }) {
  try {
    // Fetch all analyzed reels for all creators in this run
    const allRecords = [];
    const creatorScores = {};

    for (const username of creators) {
      const records = await listRecords(REELS_TABLE, {
        filterFormula: `AND(${airtableFormula(REELS_FIELDS.username, username)}, {${REELS_FIELDS.aiAnalyzed}} = TRUE())`,
        fields: [
          REELS_FIELDS.engagementScore, REELS_FIELDS.engagementTier,
          REELS_FIELDS.views, REELS_FIELDS.mainTopic,
          REELS_FIELDS.hookType, REELS_FIELDS.contentType,
          REELS_FIELDS.username,
        ],
      });
      allRecords.push(...records);
      if (records.length) {
        const scores = records.map(r => parseFloat(r.fields[REELS_FIELDS.engagementScore] || 0));
        creatorScores[username] = scores.reduce((a, b) => a + b, 0) / scores.length;
      }
    }

    if (!allRecords.length) return;

    const stats = computeReelStats(allRecords.map(r => r.fields));

    // Top performing creator by avg engagement score
    const topPerformingCreator = Object.entries(creatorScores)
      .sort((a, b) => b[1] - a[1])[0]?.[0] || '';

    await createRecords(CUMULATIVE_ANALYSIS_TABLE, [{
      [CUMULATIVE_ANALYSIS_FIELDS.runDate]:                  toISODate(),
      [CUMULATIVE_ANALYSIS_FIELDS.creators]:                 creators.join(', '),
      [CUMULATIVE_ANALYSIS_FIELDS.creatorCount]:             creators.length,
      [CUMULATIVE_ANALYSIS_FIELDS.totalReels]:               allRecords.length,
      [CUMULATIVE_ANALYSIS_FIELDS.avgEngagementScore]:       stats.avgScore,
      [CUMULATIVE_ANALYSIS_FIELDS.topPerformingCreator]:     topPerformingCreator,
      [CUMULATIVE_ANALYSIS_FIELDS.topTopics]:                stats.topTopics,
      [CUMULATIVE_ANALYSIS_FIELDS.crossCreatorHookPatterns]: stats.topHooks,
      [CUMULATIVE_ANALYSIS_FIELDS.reportContent]:            reportContent,
      [CUMULATIVE_ANALYSIS_FIELDS.reportFile]:               reportFile,
    }]);

    logger.success(`Cumulative Analysis saved: ${creators.length} creators, ${allRecords.length} reels, top: @${topPerformingCreator}`);
  } catch (e) {
    logger.warn(`Could not save Cumulative Analysis: ${e.message}`);
  }
}
