/**
 * analyze-yt-existing.js
 * Analyzes YouTube Videos already in Airtable that have AI Analyzed = false.
 * Use this when videos were scraped but analysis didn't run (e.g. cookies expired).
 *
 * Usage: node agents/analyze-yt-existing.js [--channel handle]
 */

import { analyzeReels }       from '../src/analyzers/claude.js';
import { syncUnanalyzedVideos } from '../src/airtable/youtube-sync.js';
import { listRecords }        from '../src/airtable/client.js';
import { YT_VIDEOS_TABLE, YT_VIDEOS_FIELDS } from '../src/airtable/schema.js';
import { logger }             from '../src/utils/logger.js';

// ── CLI args ──────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const chIdx   = args.indexOf('--channel');
const channel = chIdx !== -1 ? args[chIdx + 1] : null;

// ── Fetch unanalyzed records from Airtable ───────────────────────────────────
async function fetchUnanalyzed(channelUsername) {
  const filter = channelUsername
    ? `AND(NOT({${YT_VIDEOS_FIELDS.aiAnalyzed}}), {${YT_VIDEOS_FIELDS.channelUsername}} = "${channelUsername}")`
    : `NOT({${YT_VIDEOS_FIELDS.aiAnalyzed}})`;

  const records = await listRecords(YT_VIDEOS_TABLE, {
    filterFormula: filter,
    // Fetch ALL fields videoToFields() needs so the patch doesn't overwrite
    // engagement metrics with zeros
    fields: [
      YT_VIDEOS_FIELDS.videoId,
      YT_VIDEOS_FIELDS.url,
      YT_VIDEOS_FIELDS.channelUsername,
      YT_VIDEOS_FIELDS.channelId,
      YT_VIDEOS_FIELDS.title,
      YT_VIDEOS_FIELDS.description,
      YT_VIDEOS_FIELDS.transcript,
      YT_VIDEOS_FIELDS.tags,
      YT_VIDEOS_FIELDS.views,
      YT_VIDEOS_FIELDS.likes,
      YT_VIDEOS_FIELDS.comments,
      YT_VIDEOS_FIELDS.duration,
      YT_VIDEOS_FIELDS.isShort,
      YT_VIDEOS_FIELDS.engagementScore,
      YT_VIDEOS_FIELDS.likeRatio,
      YT_VIDEOS_FIELDS.commentRatio,
      YT_VIDEOS_FIELDS.engagementTier,
      YT_VIDEOS_FIELDS.publishedAt,
      YT_VIDEOS_FIELDS.scrapedAt,
    ],
  });

  // Map to the shape analyzeReels() expects (uses .caption alias)
  return records.map(r => ({
    airtableId:      r.id,
    videoId:         r.fields[YT_VIDEOS_FIELDS.videoId]         || '',
    url:             r.fields[YT_VIDEOS_FIELDS.url]             || '',
    channelUsername: r.fields[YT_VIDEOS_FIELDS.channelUsername] || '',
    channelId:       r.fields[YT_VIDEOS_FIELDS.channelId]       || '',
    title:           r.fields[YT_VIDEOS_FIELDS.title]           || '',
    description:     r.fields[YT_VIDEOS_FIELDS.description]     || '',
    transcript:      r.fields[YT_VIDEOS_FIELDS.transcript]      || '',
    tags:            r.fields[YT_VIDEOS_FIELDS.tags]            || '',
    // Preserve existing engagement metrics — videoToFields() writes these back
    views:           r.fields[YT_VIDEOS_FIELDS.views]           ?? 0,
    likes:           r.fields[YT_VIDEOS_FIELDS.likes]           ?? 0,
    comments:        r.fields[YT_VIDEOS_FIELDS.comments]        ?? 0,
    duration:        r.fields[YT_VIDEOS_FIELDS.duration]        ?? 0,
    isShort:         r.fields[YT_VIDEOS_FIELDS.isShort]         || false,
    engagementScore: r.fields[YT_VIDEOS_FIELDS.engagementScore] ?? 0,
    likeRatio:       r.fields[YT_VIDEOS_FIELDS.likeRatio]       ?? 0,
    commentRatio:    r.fields[YT_VIDEOS_FIELDS.commentRatio]    ?? 0,
    engagementTier:  r.fields[YT_VIDEOS_FIELDS.engagementTier]  || 'LOW',
    publishedAt:     r.fields[YT_VIDEOS_FIELDS.publishedAt]     || '',
    scrapedAt:       r.fields[YT_VIDEOS_FIELDS.scrapedAt]       || '',
    // caption alias — analyzeReels() reads this field
    caption: [
      r.fields[YT_VIDEOS_FIELDS.title]       || '',
      r.fields[YT_VIDEOS_FIELDS.description] || '',
    ].join('\n\n').slice(0, 2000),
    // metric aliases for analyzeReels()
    videoViewCount: r.fields[YT_VIDEOS_FIELDS.views]    ?? 0,
    likesCount:     r.fields[YT_VIDEOS_FIELDS.likes]    ?? 0,
    commentsCount:  r.fields[YT_VIDEOS_FIELDS.comments] ?? 0,
  }));
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  logger.info(`Fetching unanalyzed YouTube videos${channel ? ` for @${channel}` : ' (all channels)'}...`);

  const videos = await fetchUnanalyzed(channel);
  if (videos.length === 0) {
    logger.info('No unanalyzed videos found — all done!');
    process.exit(0);
  }

  logger.info(`Found ${videos.length} video(s) to analyze`);

  // Group by channel for logging
  const byChannel = {};
  for (const v of videos) {
    byChannel[v.channelUsername] = (byChannel[v.channelUsername] || 0) + 1;
  }
  for (const [ch, n] of Object.entries(byChannel)) {
    logger.info(`  @${ch}: ${n} video(s)`);
  }

  // Run Claude analysis
  logger.info('Running Claude analysis...');
  const analyzed = await analyzeReels(videos);

  // Merge analysis back + patch to Airtable
  // analyzeReels() nests results under .aiAnalysis — unwrap to top level so
  // videoToFields(v, v, null) can read the fields directly off the object.
  const patchPayload = videos.map((v, i) => ({
    ...v,
    ...(analyzed[i]?.aiAnalysis || {}),
    airtableId: v.airtableId,
  }));

  logger.info('Patching results to Airtable...');
  const patched = await syncUnanalyzedVideos(patchPayload);

  logger.info(`Done — ${patched.length} video(s) analyzed and synced to Airtable`);
})();
