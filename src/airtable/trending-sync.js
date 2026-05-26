/**
 * trending-sync.js — Airtable sync for the discovery (trending) tables.
 *
 * The trending tables are deliberately separate from the creator-tracked tables:
 *   - Reels / YouTube Shorts / YouTube Long-form  → creator-tracked
 *   - IG Trending / YT Shorts Trending / YT Long-form Trending / TikTok Trending → discovery
 *
 * Same dedup pattern as creator scrape: read existing IDs, classify into
 * brand-new / needs-analysis / done, write only what's new. Brand-fit scores
 * are written when the analyzer was brand-aware.
 */

import { listRecords, createRecords, updateRecords } from './client.js';
import {
  TRENDING_SOURCES_TABLE, TRENDING_SOURCES_FIELDS,
} from './schema.js';
import { CLAUDE_MODEL } from '../config.js';
import { toISODate, airtableFormula } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

// ─── Existing IDs in a trending table ─────────────────────────────────────

/**
 * Map of <id field value> → { airtableId, aiAnalyzed }.
 * `fields.id` is whichever field holds the platform's native ID — varies per
 * table (Reel ID for IG, Video ID for YT/TikTok).
 */
export async function getExistingTrendingItems(table, idFieldName) {
  const records = await listRecords(table, {
    fields: [idFieldName, 'AI Analyzed'],
  });
  const map = new Map();
  for (const r of records) {
    const id = r.fields[idFieldName];
    if (!id) continue;
    map.set(id, {
      airtableId: r.id,
      aiAnalyzed: r.fields['AI Analyzed'] === true,
    });
  }
  return map;
}

/**
 * Split scraped items into brand-new / needs-analysis / done using the dedup map.
 */
export function classifyTrendingItems(items, idKey, existingMap) {
  const brandNew = [];
  const needsAnalysis = [];
  let done = 0;
  for (const item of items) {
    const id = item[idKey];
    if (!id) continue;
    const existing = existingMap.get(id);
    if (!existing) brandNew.push(item);
    else if (!existing.aiAnalyzed) needsAnalysis.push({ item, airtableId: existing.airtableId });
    else done++;
  }
  return { brandNew, needsAnalysis, done };
}

// ─── Writes ───────────────────────────────────────────────────────────────

/**
 * Map a normalized item + analysis to a trending-table field set. Keeps the
 * shape generic so the same function works for IG/YT/TikTok trending tables.
 *
 * @param {object} item     normalized scraper output
 * @param {object} F        the FIELDS map for the destination table
 * @param {boolean} analyzed
 */
function trendingItemToFields(item, F, analyzed = false) {
  const a = item.aiAnalysis || {};
  const now = toISODate();
  const out = {
    [F.id]:        item.reelId || item.videoId,
    [F.url]:       item.url,
    [F.username]:  item.username || item.channelUsername || '',
    ...(F.title       && item.title       ? { [F.title]:       item.title }       : {}),
    ...(F.description && item.description ? { [F.description]: item.description } : {}),
    ...(F.tags        && item.tags        ? { [F.tags]:        Array.isArray(item.tags) ? item.tags.join(', ') : item.tags } : {}),
    ...(F.channelId   && item.channelId   ? { [F.channelId]:   item.channelId }   : {}),

    [F.caption]:    (item.caption || '').slice(0, 100000),
    [F.transcript]: (item.transcript || '').slice(0, 100000),
    [F.hashtags]:   (item.hashtags || []).join(', '),
    [F.hook]:       a.hook || '',
    [F.audio]:      item.audioTitle || '',

    [F.views]:        item.views    || 0,
    [F.playCount]:    item.playCount|| 0,
    [F.likes]:        item.likes    || 0,
    [F.comments]:     item.comments || 0,
    [F.shares]:       item.shares   || 0,
    [F.duration]:     item.duration || null,

    [F.engagementScore]: item.engagementScore || 0,
    [F.likeRatio]:       item.likeRatio       || 0,
    [F.commentRatio]:    item.commentRatio    || 0,
    ...(item.shareRatio !== undefined ? { [F.shareRatio]: item.shareRatio } : {}),
    [F.engagementTier]:  item.engagementTier  || 'LOW',

    [F.mainTopic]:      a.mainTopic    || '',
    [F.topics]:         (a.topics || []).join(', '),
    [F.contentType]:    a.contentType  || 'Other',
    [F.keyPoints]:      (a.keyPoints || []).join('\n• '),
    [F.targetAudience]: a.targetAudience || '',
    [F.emotionalTone]:  a.emotionalTone  || '',
    [F.hookType]:       a.hookType     || 'Other',
    [F.hookCategory]:   a.hookCategory || 'Other',
    [F.ctaType]:        a.ctaType      || 'None',
    [F.ctaPlacement]:   a.ctaPlacement || 'None',

    // Brand fit — only populated when Brand DNA was loaded.
    ...(a.brandFit       ? { 'Brand Fit':        a.brandFit }       : {}),
    ...(a.brandFitReason ? { 'Brand Fit Reason': a.brandFitReason } : {}),

    // Source lineage
    ...(item.sourceHashtag && F.sourceHashtag ? { [F.sourceHashtag]: item.sourceHashtag } : {}),
    ...(item.source        && F.source        ? { [F.source]:        item.source }        : {}),
    ...(item.niche         && F.niche         ? { [F.niche]:         item.niche }         : {}),

    [F.aiAnalyzed]:     analyzed,
    [F.analyzedAt]:     analyzed ? now : null,
    [F.analysisModel]:  analyzed ? CLAUDE_MODEL : '',

    [F.publishedAt]: item.publishedAt
      ? new Date(item.publishedAt).toISOString().slice(0, 10) : null,
    [F.scrapedAt]:   item.scrapedAt
      ? new Date(item.scrapedAt).toISOString().slice(0, 10) : now,
  };

  // Strip null/empty undefined to avoid Airtable 422s on optional fields.
  for (const k of Object.keys(out)) {
    if (out[k] === undefined) delete out[k];
  }
  return out;
}

export async function syncTrendingItems(table, FIELDS, items) {
  if (!items.length) return 0;
  const payload = items.map((it) => trendingItemToFields(
    it, FIELDS, Boolean(it.aiAnalysis && it.aiAnalysis.mainTopic && it.aiAnalysis.mainTopic !== 'Unknown'),
  ));
  try {
    const created = await createRecords(table, payload);
    logger.success(`Trending: created ${created.length} records in ${table}`);
    return created.length;
  } catch (e) {
    logger.warn(`Batch write failed (${table}) — falling back one-by-one: ${e.message}`);
    let created = 0;
    for (const fields of payload) {
      try { await createRecords(table, [fields]); created++; }
      catch (err) { logger.error(`Skipped trending record: ${err.message}`); }
    }
    return created;
  }
}

export async function patchTrendingAnalysis(table, FIELDS, updates) {
  if (!updates.length) return 0;
  const payload = updates.map(({ item, airtableId }) => ({
    id: airtableId,
    fields: trendingItemToFields(item, FIELDS, true),
  }));
  try {
    const out = await updateRecords(table, payload);
    return out.length;
  } catch (e) {
    logger.warn(`Patch failed (${table}): ${e.message}`);
    return 0;
  }
}

// ─── Trending Sources table — the discovery queue ─────────────────────────

export async function listActiveTrendingSources() {
  return listRecords(TRENDING_SOURCES_TABLE, {
    filterFormula: `{${TRENDING_SOURCES_FIELDS.active}} = TRUE()`,
  });
}

/**
 * Find Trending Sources rows that need watcher action (the form-submission
 * + force-rescrape watcher). A row qualifies when:
 *   - `Submitted URL` is set AND `Last Scraped` is empty, OR
 *   - `Force Rescrape` is checked.
 */
export async function listSourcesNeedingWatcherAction() {
  const formula = `OR(
    AND({${TRENDING_SOURCES_FIELDS.submittedUrl}} != '', {${TRENDING_SOURCES_FIELDS.lastScraped}} = ''),
    {${TRENDING_SOURCES_FIELDS.forceRescrape}} = TRUE()
  )`.replace(/\s+/g, ' ');
  return listRecords(TRENDING_SOURCES_TABLE, { filterFormula: formula });
}

export async function markSourceScraped(sourceRecordId) {
  await updateRecords(TRENDING_SOURCES_TABLE, [{
    id: sourceRecordId,
    fields: {
      [TRENDING_SOURCES_FIELDS.lastScraped]:  toISODate(),
      [TRENDING_SOURCES_FIELDS.forceRescrape]: false,
    },
  }]);
}

// Re-export helpers used by other modules
export { airtableFormula };
