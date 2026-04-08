import { listRecords, createRecords, updateRecords } from './client.js';
import { CLAUDE_MODEL } from '../config.js';
import { REELS_TABLE, REELS_FIELDS, CREATORS_TABLE, CREATORS_FIELDS } from './schema.js';
import { logger } from '../utils/logger.js';

/**
 * Get a map of reelId → { airtableId, aiAnalyzed } for a given username.
 * Covers both dedup (already stored) and analysis guard (already analyzed).
 */
export async function getExistingReels(username) {
  const formula = `{${REELS_FIELDS.username}} = "${username}"`;
  const records = await listRecords(REELS_TABLE, {
    filterFormula: formula,
    fields: [REELS_FIELDS.reelId, REELS_FIELDS.aiAnalyzed],
  });

  const map = new Map(); // reelId → { airtableId, aiAnalyzed }
  for (const r of records) {
    const reelId = r.fields[REELS_FIELDS.reelId];
    if (reelId) {
      map.set(reelId, {
        airtableId:  r.id,
        aiAnalyzed:  r.fields[REELS_FIELDS.aiAnalyzed] === true,
      });
    }
  }
  return map;
}

/**
 * Split scraped reels into:
 * - brandNew:      not in Airtable at all → needs scrape record + analysis
 * - needsAnalysis: in Airtable but aiAnalyzed = false → needs analysis only
 * - done:          in Airtable and aiAnalyzed = true → skip entirely
 */
export function classifyReels(reels, existingMap) {
  const brandNew      = [];
  const needsAnalysis = []; // { reel, airtableId }
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

  if (done > 0)
    logger.info(`Dedup: ${done} reels already fully analyzed — skipping`);
  if (needsAnalysis.length > 0)
    logger.info(`Dedup: ${needsAnalysis.length} reels stored but not yet analyzed — queuing`);
  if (brandNew.length > 0)
    logger.info(`Dedup: ${brandNew.length} brand new reels`);

  return { brandNew, needsAnalysis, done };
}

/**
 * Upsert a creator record. Returns the Airtable record ID.
 */
export async function upsertCreator(creator) {
  const existing = await listRecords(CREATORS_TABLE, {
    filterFormula: `{${CREATORS_FIELDS.username}} = "${creator.username}"`,
    maxRecords: 1,
  });

  const fields = {
    [CREATORS_FIELDS.username]:    creator.username,
    [CREATORS_FIELDS.displayName]: creator.displayName || creator.username,
    [CREATORS_FIELDS.niche]:       creator.niche || '',
    [CREATORS_FIELDS.active]:      true,
    [CREATORS_FIELDS.lastScraped]: new Date().toISOString().slice(0, 10),
  };

  if (existing.length > 0) {
    // Already exists — no update needed (or update lastScraped only)
    return existing[0].id;
  }

  const created = await createRecords(CREATORS_TABLE, [fields]);
  return created[0].id;
}

/**
 * Map a fully-analyzed reel to Airtable field values.
 * aiAnalyzed is set to true only when analysis is present.
 */
function reelToFields(reel, creatorRecordId, analyzed = false) {
  const a   = reel.aiAnalysis || {};
  const now = new Date().toISOString().slice(0, 10);

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
    [REELS_FIELDS.likes]:          reel.likes,
    [REELS_FIELDS.comments]:       reel.comments,
    [REELS_FIELDS.shares]:         reel.sharesCount || 0,
    [REELS_FIELDS.duration]:       reel.duration || null,

    // Engagement
    [REELS_FIELDS.engagementScore]: reel.engagementScore,
    [REELS_FIELDS.likeRatio]:       reel.likeRatio,
    [REELS_FIELDS.commentRatio]:    reel.commentRatio,
    [REELS_FIELDS.engagementTier]:  reel.engagementTier,

    // AI — only populated when analysis succeeded
    [REELS_FIELDS.mainTopic]:      a.mainTopic    || '',
    [REELS_FIELDS.topics]:         (a.topics || []).join(', '),
    [REELS_FIELDS.contentType]:    a.contentType  || 'Other',
    [REELS_FIELDS.keyPoints]:      (a.keyPoints || []).join('\n• '),
    [REELS_FIELDS.targetAudience]: a.targetAudience || '',
    [REELS_FIELDS.emotionalTone]:  a.emotionalTone  || '',

    // Hook classification — Poppy Protocol Prompt A
    [REELS_FIELDS.hookType]:       a.hookType     || 'Other',
    [REELS_FIELDS.hookCategory]:   a.hookCategory || 'Other',

    // CTA classification — Poppy Protocol Prompt D
    [REELS_FIELDS.ctaType]:        a.ctaType      || 'None',
    [REELS_FIELDS.ctaPlacement]:   a.ctaPlacement || 'None',

    // Analysis status
    [REELS_FIELDS.aiAnalyzed]:     analyzed,
    [REELS_FIELDS.analyzedAt]:     analyzed ? now : null,
    [REELS_FIELDS.analysisModel]:  analyzed ? (CLAUDE_MODEL) : '',

    // Timestamps
    [REELS_FIELDS.publishedAt]:    reel.publishedAt
      ? new Date(reel.publishedAt).toISOString().slice(0, 10)
      : null,
    [REELS_FIELDS.scrapedAt]:      reel.scrapedAt
      ? new Date(reel.scrapedAt).toISOString().slice(0, 10)
      : now,
  };
}

/**
 * Patch only the AI fields on an existing Airtable record.
 * Called when a reel was stored previously but analysis failed or hadn't run.
 */
export async function updateAnalysisFields(airtableId, reel) {
  const a   = reel.aiAnalysis || {};
  const now = new Date().toISOString().slice(0, 10);

  const fields = {
    [REELS_FIELDS.hook]:           a.hook           || '',
    [REELS_FIELDS.mainTopic]:      a.mainTopic      || '',
    [REELS_FIELDS.topics]:         (a.topics || []).join(', '),
    [REELS_FIELDS.contentType]:    a.contentType    || 'Other',
    [REELS_FIELDS.keyPoints]:      (a.keyPoints || []).join('\n• '),
    [REELS_FIELDS.targetAudience]: a.targetAudience || '',
    [REELS_FIELDS.emotionalTone]:  a.emotionalTone  || '',
    [REELS_FIELDS.hookType]:       a.hookType     || 'Other',
    [REELS_FIELDS.hookCategory]:   a.hookCategory || 'Other',
    [REELS_FIELDS.ctaType]:        a.ctaType      || 'None',
    [REELS_FIELDS.ctaPlacement]:   a.ctaPlacement || 'None',
    [REELS_FIELDS.aiAnalyzed]:     true,
    [REELS_FIELDS.analyzedAt]:     now,
    [REELS_FIELDS.analysisModel]:  CLAUDE_MODEL,
  };

  await updateRecords(REELS_TABLE, [{ id: airtableId, fields }]);
  logger.success(`Updated analysis for existing record: ${airtableId}`);
}

/**
 * Write brand new reels to Airtable.
 * aiAnalyzed is set based on whether analysis actually completed.
 */
export async function syncReelsToAirtable(reels, creatorRecordId) {
  if (!reels.length) {
    logger.info('No new reels to sync');
    return 0;
  }

  logger.info(`Airtable: writing ${reels.length} new reels...`);

  // analyzed = true only if aiAnalysis has real content (not the empty fallback)
  const fieldSets = reels.map(r => {
    const hasAnalysis = r.aiAnalysis && r.aiAnalysis.mainTopic !== 'Unknown';
    return reelToFields(r, creatorRecordId, hasAnalysis);
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
 * Patch AI analysis fields onto existing Airtable records that were
 * stored previously but never analyzed (aiAnalyzed = false).
 * Returns count of records updated.
 */
export async function syncUnanalyzedReels(analyzedReels) {
  if (!analyzedReels.length) return 0;

  logger.info(`Airtable: patching analysis onto ${analyzedReels.length} existing records...`);
  let updated = 0;

  for (const { reel, airtableId } of analyzedReels) {
    try {
      await updateAnalysisFields(airtableId, reel);
      updated++;
    } catch (e) {
      logger.error(`Failed to patch ${airtableId}: ${e.message}`);
    }
  }

  logger.success(`Airtable: patched ${updated} existing records with AI analysis`);
  return updated;
}
