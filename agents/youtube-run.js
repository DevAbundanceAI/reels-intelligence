#!/usr/bin/env node
/**
 * youtube-run.js — YouTube pipeline orchestrator
 * Direct parallel to daily-run.js for Instagram Reels.
 *
 * Usage:
 *   node agents/youtube-run.js                              # all active channels
 *   node agents/youtube-run.js --channel alexhormozi       # single channel
 *   node agents/youtube-run.js --limit 5                   # override video limit
 *   node agents/youtube-run.js --no-transcripts            # skip transcript fetch
 *   node agents/youtube-run.js --channel alexhormozi --limit 3 --no-transcripts
 */

import { readFileSync }  from 'fs';
import '../src/config.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// ─── Progress bar ─────────────────────────────────────────────────────────────

function progressBar(current, total, label = '', width = 24) {
  const pct    = total > 0 ? current / total : 0;
  const filled = Math.round(pct * width);
  const bar    = '█'.repeat(filled) + '░'.repeat(width - filled);
  const pctStr = Math.round(pct * 100).toString().padStart(3);
  process.stdout.write(`\r  [${bar}] ${pctStr}% ${current}/${total} ${label}   `);
  if (current >= total) process.stdout.write('\n');
}

import { scrapeChannelVideos, fetchVideoTranscript } from '../src/scrapers/ytdlp.js';
import { normalizeVideo }                             from '../src/scrapers/youtube.js';
import { buildYTMetrics }                             from '../src/utils/youtube-engagement.js';
import { analyzeReels }                               from '../src/analyzers/claude.js';
import { logger }                                     from '../src/utils/logger.js';
import {
  getExistingVideos,
  classifyVideos,
  upsertYTCreator,
  syncVideosToAirtable,
  syncUnanalyzedVideos,
  logYTRun,
} from '../src/airtable/youtube-sync.js';
import { YTDLP_CONCURRENCY } from '../src/config.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const targetsPath = join(__dir, '..', 'config', 'youtube-targets.json');

// ─── CLI args ────────────────────────────────────────────────────────────────

const args           = process.argv.slice(2);
const channelIdx     = args.indexOf('--channel');
const limitIdx       = args.indexOf('--limit');
const noTranscripts  = args.includes('--no-transcripts');
const singleChannel  = channelIdx !== -1 ? args[channelIdx + 1] : null;
const limitOverride  = limitIdx   !== -1 ? parseInt(args[limitIdx + 1]) : null;

// ─── Load targets ────────────────────────────────────────────────────────────

const { channels, defaults } = JSON.parse(readFileSync(targetsPath, 'utf8'));
const activeChannels = channels.filter(c => {
  if (!c.active) return false;
  if (singleChannel) return c.channelUsername === singleChannel;
  return true;
});

if (!activeChannels.length) {
  logger.warn(singleChannel
    ? `Channel "${singleChannel}" not found or inactive in config/youtube-targets.json`
    : 'No active channels in config/youtube-targets.json');
  process.exit(0);
}

logger.info(`Starting YouTube run for ${activeChannels.length} channel(s)`);

// ─── Transcript fetcher with concurrency limit ───────────────────────────────

async function fetchTranscriptsWithConcurrency(videoIds, concurrency = YTDLP_CONCURRENCY) {
  const results = {};  // videoId → transcript string | null
  let done = 0;

  progressBar(0, videoIds.length, 'transcripts');
  for (let i = 0; i < videoIds.length; i += concurrency) {
    const batch = videoIds.slice(i, i + concurrency);
    const fetched = await Promise.all(
      batch.map(async id => {
        const text = await fetchVideoTranscript(id);
        return { id, text };
      })
    );
    for (const { id, text } of fetched) {
      results[id] = text;
      done++;
      progressBar(done, videoIds.length, 'transcripts');
    }
  }

  return results;
}

// ─── Run stats ───────────────────────────────────────────────────────────────

const runStats = {
  creatorsRun:   0,
  videosFetched: 0,
  videosNew:     0,
  errors:        [],
};

// ─── Main loop ───────────────────────────────────────────────────────────────

for (const channel of activeChannels) {
  const limit      = limitOverride || channel.videoLimit || defaults.videoLimit;
  const doTranscripts = !noTranscripts && (channel.fetchTranscripts ?? defaults.fetchTranscripts);

  logger.info(`\n── @${channel.channelUsername} (${channel.niche || 'unknown'}) — limit: ${limit}`);

  try {
    // 1. Scrape raw video metadata via yt-dlp
    const rawVideos = await scrapeChannelVideos(channel.channelUsername, limit);

    if (rawVideos.length === 0) {
      logger.warn(`  No videos found for @${channel.channelUsername}`);
      runStats.errors.push(`@${channel.channelUsername}: no videos returned`);
      continue;
    }

    logger.info(`  Fetched ${rawVideos.length} raw video(s)`);
    runStats.videosFetched += rawVideos.length;

    // 2. Optionally fetch transcripts (concurrently)
    let transcripts = {};
    if (doTranscripts) {
      logger.info(`  Fetching transcripts (concurrency: ${YTDLP_CONCURRENCY})...`);
      const videoIds = rawVideos.map(v => v.id).filter(Boolean);
      transcripts = await fetchTranscriptsWithConcurrency(videoIds);
    }

    // 3. Normalize
    const videos = rawVideos
      .filter(raw => raw && raw.id)
      .map(raw => normalizeVideo(raw, channel.channelUsername, transcripts[raw.id] || null));

    logger.info(`  Normalized: ${videos.length} video(s)`);

    // 4. Compute engagement metrics and merge into video objects
    const videosWithMetrics = videos.map(v => ({ ...v, ...buildYTMetrics(v) }));

    // 5. Upsert YouTube Creator record
    const creatorRecordId = await upsertYTCreator({
      channelUsername: channel.channelUsername,
      displayName:     channel.displayName || channel.channelUsername,
      channelId:       rawVideos[0]?.channel_id || '',
      niche:           channel.niche || '',
      active:          true,
    });

    // 6. Get existing videos, classify
    const existingMap = await getExistingVideos(channel.channelUsername);
    const { brandNew, needsAnalysis, done } = classifyVideos(videosWithMetrics, existingMap);

    logger.info(`  brandNew: ${brandNew.length}, needsAnalysis: ${needsAnalysis.length}, done: ${done.length}`);

    // 7. AI analysis on brand new videos (reuse existing analyzeReels — caption alias handles this)
    let analyzedNew = [];
    if (brandNew.length > 0) {
      logger.info(`  Running Claude analysis on ${brandNew.length} new video(s)...`);
      progressBar(0, brandNew.length, 'analyzing');
      analyzedNew = await analyzeReels(brandNew);
      progressBar(brandNew.length, brandNew.length, 'analyzing');
    }

    // 8. Sync new videos to Airtable
    // analyzeReels() nests results under .aiAnalysis — extract for videoToFields()
    let created = 0;
    if (analyzedNew.length > 0) {
      logger.info(`  Syncing ${analyzedNew.length} new video(s) to Airtable...`);
      progressBar(0, analyzedNew.length, 'syncing');
      const analysisResults = analyzedNew.map(a => a.aiAnalysis || {});
      const syncResult = await syncVideosToAirtable(brandNew, creatorRecordId, analysisResults);
      created = syncResult.length;
      progressBar(created, analyzedNew.length, 'syncing');
    } else if (brandNew.length > 0) {
      // Analysis failed; store without analysis so they can be retried
      const syncResult = await syncVideosToAirtable(brandNew, creatorRecordId);
      created = syncResult.length;
    }

    // 9. Patch analysis onto previously unanalyzed videos
    let patched = 0;
    if (needsAnalysis.length > 0) {
      logger.info(`  Re-analyzing ${needsAnalysis.length} previously unanalyzed video(s)...`);
      progressBar(0, needsAnalysis.length, 'analyzing');
      const reanalyzed = await analyzeReels(needsAnalysis);
      progressBar(needsAnalysis.length, needsAnalysis.length, 'analyzing');
      // analyzeReels() nests results under .aiAnalysis — unwrap to top level
      const patchPayload = needsAnalysis.map((v, i) => ({
        ...v,
        ...(reanalyzed[i]?.aiAnalysis || {}),
        airtableId: v.airtableId,
      }));
      const patchResult = await syncUnanalyzedVideos(patchPayload);
      patched = patchResult.length;
    }

    runStats.videosNew   += created;
    runStats.creatorsRun++;
    logger.success(`@${channel.channelUsername}: ${created} new, ${patched} patched, ${done.length} skipped`);

  } catch (e) {
    logger.error(`Failed for @${channel.channelUsername}: ${e.message}`);
    runStats.errors.push(`@${channel.channelUsername}: ${e.message}`);
  }
}

// ─── Log run to Airtable ─────────────────────────────────────────────────────

const runStatus = runStats.errors.length === 0 ? 'Success'
  : runStats.creatorsRun > 0 ? 'Partial'
  : 'Failed';

try {
  await logYTRun({
    creatorsRun:   runStats.creatorsRun,
    videosFetched: runStats.videosFetched,
    videosNew:     runStats.videosNew,
    errors:        runStats.errors.join('\n'),
    status:        runStatus,
  });
} catch (e) {
  logger.warn('Could not log run to Airtable: ' + e.message);
}

// ─── Summary ─────────────────────────────────────────────────────────────────

logger.info('\n─────────── YOUTUBE RUN COMPLETE ───────────');
logger.success(`Channels run:    ${runStats.creatorsRun}`);
logger.success(`Videos fetched:  ${runStats.videosFetched}`);
logger.success(`Videos new:      ${runStats.videosNew}`);
if (runStats.errors.length) {
  logger.warn(`Errors:          ${runStats.errors.length}`);
  runStats.errors.forEach(e => logger.warn('  ' + e));
}