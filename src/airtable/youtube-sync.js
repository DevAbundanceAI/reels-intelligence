/**
 * youtube-sync.js — Airtable sync for YouTube Videos and Creators tables.
 * Mirrors the role of sync.js for Instagram Reels.
 *
 * Key difference: yt-dlp field names (viewCount, likeCount, commentCount)
 * differ from Airtable field names (Views, Likes, Comments) — the mapping
 * happens in videoToFields().
 */

import { listRecords, createRecords, updateRecords } from './client.js';
import {
  YT_VIDEOS_TABLE,   YT_VIDEOS_FIELDS,
  YT_CREATORS_TABLE, YT_CREATORS_FIELDS,
  YT_RUNS_TABLE,     YT_RUNS_FIELDS,
} from './schema.js';
import { logger } from '../utils/logger.js';

// ─── Existing videos map ─────────────────────────────────────────────────────

/**
 * Returns Map<videoId, { airtableId, aiAnalyzed }> for a specific channel.
 * Used for dedup and classify.
 */
export async function getExistingVideos(channelUsername) {
  const records = await listRecords(YT_VIDEOS_TABLE, {
    filterFormula: `{${YT_VIDEOS_FIELDS.channelUsername}} = "${channelUsername}"`,
    fields: [YT_VIDEOS_FIELDS.videoId, YT_VIDEOS_FIELDS.aiAnalyzed],
  });

  const map = new Map();
  for (const r of records) {
    const videoId = r.fields[YT_VIDEOS_FIELDS.videoId];
    if (videoId) {
      map.set(videoId, { airtableId: r.id, aiAnalyzed: r.fields[YT_VIDEOS_FIELDS.aiAnalyzed] || false });
    }
  }
  return map;
}

// ─── Classify ────────────────────────────────────────────────────────────────

/**
 * Same 3-bucket pattern as Instagram sync:
 *   brandNew      — not in Airtable yet
 *   needsAnalysis — in Airtable but aiAnalyzed=false
 *   done          — aiAnalyzed=true, skip
 */
export function classifyVideos(videos, existingMap) {
  const brandNew      = [];
  const needsAnalysis = [];
  const done          = [];

  for (const video of videos) {
    const existing = existingMap.get(video.videoId);
    if (!existing) {
      brandNew.push(video);
    } else if (!existing.aiAnalyzed) {
      needsAnalysis.push({ ...video, airtableId: existing.airtableId });
    } else {
      done.push(video);
    }
  }

  return { brandNew, needsAnalysis, done };
}

// ─── Creator upsert ──────────────────────────────────────────────────────────

/**
 * Upsert a YouTube Creators record. Creates if not found, updates lastScraped either way.
 * Returns the Airtable record ID.
 */
export async function upsertYTCreator(creator) {
  const { channelUsername, displayName, channelId, niche, active, subscriberCount, totalVideos } = creator;

  const existing = await listRecords(YT_CREATORS_TABLE, {
    filterFormula: `{${YT_CREATORS_FIELDS.channelUsername}} = "${channelUsername}"`,
    fields: [YT_CREATORS_FIELDS.channelUsername],
  });

  const today = new Date().toISOString().split('T')[0];

  if (existing.length > 0) {
    const recordId = existing[0].id;
    await updateRecords(YT_CREATORS_TABLE, [{
      id: recordId,
      fields: {
        [YT_CREATORS_FIELDS.lastScraped]:    today,
        ...(subscriberCount && { [YT_CREATORS_FIELDS.subscriberCount]: subscriberCount }),
        ...(totalVideos     && { [YT_CREATORS_FIELDS.totalVideos]:     totalVideos     }),
      },
    }]);
    logger.info(`  Creator @${channelUsername} updated (lastScraped: ${today})`);
    return recordId;
  }

  const created = await createRecords(YT_CREATORS_TABLE, [{
    [YT_CREATORS_FIELDS.channelUsername]: channelUsername,
    [YT_CREATORS_FIELDS.displayName]:     displayName || channelUsername,
    [YT_CREATORS_FIELDS.channelId]:       channelId   || '',
    [YT_CREATORS_FIELDS.niche]:           niche       || '',
    [YT_CREATORS_FIELDS.active]:          active !== false,
    [YT_CREATORS_FIELDS.lastScraped]:     today,
    ...(subscriberCount && { [YT_CREATORS_FIELDS.subscriberCount]: subscriberCount }),
    ...(totalVideos     && { [YT_CREATORS_FIELDS.totalVideos]:     totalVideos     }),
  }]);

  logger.info(`  Creator @${channelUsername} created`);
  return created[0].id;
}

// ─── Field mapping ───────────────────────────────────────────────────────────

/**
 * Map a normalized+analyzed video object to Airtable field names.
 * `analyzed` contains the Claude analysis result (may be undefined for un-analyzed videos).
 */
function videoToFields(video, analyzed, creatorRecordId) {
  const fields = {
    // Identity
    [YT_VIDEOS_FIELDS.videoId]:         video.videoId,
    [YT_VIDEOS_FIELDS.url]:             video.url,
    [YT_VIDEOS_FIELDS.channelUsername]: video.channelUsername,
    [YT_VIDEOS_FIELDS.channelId]:       video.channelId || '',

    // Content
    [YT_VIDEOS_FIELDS.title]:           video.title       || '',
    [YT_VIDEOS_FIELDS.description]:     video.description || '',
    [YT_VIDEOS_FIELDS.tags]:            video.tags        || '',
    [YT_VIDEOS_FIELDS.transcript]:      video.transcript  || '',

    // Metrics — NOTE: yt-dlp uses viewCount/likeCount; Airtable fields are Views/Likes
    [YT_VIDEOS_FIELDS.views]:           video.views           ?? video.viewCount   ?? 0,
    [YT_VIDEOS_FIELDS.likes]:           video.likes           ?? video.likeCount   ?? 0,
    [YT_VIDEOS_FIELDS.comments]:        video.comments        ?? video.commentCount ?? 0,
    [YT_VIDEOS_FIELDS.duration]:        video.duration        || 0,
    [YT_VIDEOS_FIELDS.isShort]:         video.isShort         || false,
    [YT_VIDEOS_FIELDS.engagementScore]: video.engagementScore || 0,
    [YT_VIDEOS_FIELDS.likeRatio]:       video.likeRatio       || 0,
    [YT_VIDEOS_FIELDS.commentRatio]:    video.commentRatio    || 0,
    [YT_VIDEOS_FIELDS.engagementTier]:  video.engagementTier  || 'LOW',

    // Timestamps
    ...(video.publishedAt && { [YT_VIDEOS_FIELDS.publishedAt]: video.publishedAt }),
    [YT_VIDEOS_FIELDS.scrapedAt]:       video.scrapedAt || new Date().toISOString().split('T')[0],
  };

  // Creator link
  if (creatorRecordId) {
    fields[YT_VIDEOS_FIELDS.creatorRecord] = [creatorRecordId];
  }

  // AI Analysis fields
  if (analyzed) {
    const today = new Date().toISOString().split('T')[0];
    Object.assign(fields, {
      [YT_VIDEOS_FIELDS.hook]:           analyzed.hook           || '',
      [YT_VIDEOS_FIELDS.mainTopic]:      analyzed.mainTopic      || '',
      [YT_VIDEOS_FIELDS.topics]:         analyzed.topics         || '',
      [YT_VIDEOS_FIELDS.contentType]:    analyzed.contentType    || '',
      [YT_VIDEOS_FIELDS.keyPoints]:      analyzed.keyPoints      || '',
      [YT_VIDEOS_FIELDS.targetAudience]: analyzed.targetAudience || '',
      [YT_VIDEOS_FIELDS.emotionalTone]:  analyzed.emotionalTone  || '',
      [YT_VIDEOS_FIELDS.hookType]:       analyzed.hookType       || '',
      [YT_VIDEOS_FIELDS.hookCategory]:   analyzed.hookCategory   || '',
      [YT_VIDEOS_FIELDS.ctaType]:          analyzed.ctaType          || '',
      [YT_VIDEOS_FIELDS.ctaPlacement]:    analyzed.ctaPlacement     || '',
      [YT_VIDEOS_FIELDS.contentLongevity]: analyzed.contentLongevity || 'Evergreen',
      [YT_VIDEOS_FIELDS.contentFormat]:   analyzed.contentFormat    || 'Short-form',
      [YT_VIDEOS_FIELDS.aiAnalyzed]:      true,
      [YT_VIDEOS_FIELDS.analyzedAt]:     today,
      [YT_VIDEOS_FIELDS.analysisModel]:  analyzed.analysisModel  || '',
    });
  } else {
    fields[YT_VIDEOS_FIELDS.aiAnalyzed] = false;
  }

  return fields;
}

// ─── Sync: create new records ────────────────────────────────────────────────

/**
 * Create new YouTube Videos records in Airtable.
 * `videos` should already have engagement metrics merged in (buildYTMetrics called upstream).
 * `analyzed` is an array of Claude analysis objects, parallel to videos.
 */
export async function syncVideosToAirtable(videos, creatorRecordId, analyzed = []) {
  if (videos.length === 0) return [];

  const fieldMaps = videos.map((v, i) => videoToFields(v, analyzed[i], creatorRecordId));
  const created   = await createRecords(YT_VIDEOS_TABLE, fieldMaps);
  logger.info(`  Synced ${created.length} new video(s) to Airtable`);
  return created;
}

// ─── Sync: patch analysis onto existing records ───────────────────────────────

/**
 * Patch AI analysis fields onto existing records that are stored but not yet analyzed.
 * `analyzedVideos` should include: { airtableId, ...analysisFields }
 */
export async function syncUnanalyzedVideos(analyzedVideos) {
  if (analyzedVideos.length === 0) return [];

  const updates = analyzedVideos.map(v => ({
    id: v.airtableId,
    fields: videoToFields(v, v, null),  // pass v as both video and analyzed
  }));

  const updated = await updateRecords(YT_VIDEOS_TABLE, updates);
  logger.info(`  Patched analysis on ${updated.length} existing video(s)`);
  return updated;
}

// ─── YouTube Runs ─────────────────────────────────────────────────────────────

/**
 * Write a YouTube Runs log record.
 */
export async function logYTRun({ creatorsRun, videosFetched, videosNew, errors, status }) {
  const today = new Date().toISOString().split('T')[0];
  const records = await createRecords(YT_RUNS_TABLE, [{
    [YT_RUNS_FIELDS.runAt]:         today,
    [YT_RUNS_FIELDS.creatorsRun]:   creatorsRun  || 0,
    [YT_RUNS_FIELDS.videosFetched]: videosFetched || 0,
    [YT_RUNS_FIELDS.videosNew]:     videosNew     || 0,
    [YT_RUNS_FIELDS.errors]:        errors        || '',
    [YT_RUNS_FIELDS.status]:        status        || 'Success',
  }]);
  return records[0];
}
