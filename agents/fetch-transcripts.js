#!/usr/bin/env node
/**
 * fetch-transcripts.js — Backfill transcripts for YouTube videos that don't have one.
 *
 * Transcript fetch strategy:
 *   1. Supadata API (supadata.ai) — works from any IP including cloud/Codespaces.
 *      Requires SUPADATA_API_KEY in .env. Free tier: 100/month.
 *   2. yt-dlp fallback — used only when SUPADATA_API_KEY is not set.
 *      Only works from non-blocked IPs (i.e. not cloud environments).
 *
 * Usage:
 *   node agents/fetch-transcripts.js                          # all channels
 *   node agents/fetch-transcripts.js --channel TakiMoore     # one channel
 *   node agents/fetch-transcripts.js --limit 10              # cap records
 */

import '../src/config.js';

import { listRecords, updateRecords } from '../src/airtable/client.js';
import { fetchVideoTranscript }       from '../src/scrapers/ytdlp.js';
import { logger }                     from '../src/utils/logger.js';
import { YTDLP_CONCURRENCY }          from '../src/config.js';
import { YT_VIDEOS_TABLE, YT_VIDEOS_FIELDS as F } from '../src/airtable/schema.js';

// ─── CLI args ────────────────────────────────────────────────────────────────

const args           = process.argv.slice(2);
const channelIdx     = args.indexOf('--channel');
const limitIdx       = args.indexOf('--limit');
const singleChannel  = channelIdx !== -1 ? args[channelIdx + 1] : null;
const limitOverride  = limitIdx   !== -1 ? parseInt(args[limitIdx + 1]) : null;

// ─── Progress bar ─────────────────────────────────────────────────────────────

function progressBar(current, total, label = '', width = 28) {
  const pct    = total > 0 ? current / total : 0;
  const filled = Math.round(pct * width);
  const bar    = '█'.repeat(filled) + '░'.repeat(width - filled);
  const pctStr = Math.round(pct * 100).toString().padStart(3);
  process.stdout.write(`\r  [${bar}] ${pctStr}% ${current}/${total} ${label}   `);
  if (current >= total) process.stdout.write('\n');
}

// ─── Fetch with concurrency cap ───────────────────────────────────────────────

async function fetchWithConcurrency(videoIds, concurrency = YTDLP_CONCURRENCY) {
  const results = {};
  let done = 0;
  const queue = [...videoIds];

  async function worker() {
    while (queue.length) {
      const id = queue.shift();
      results[id] = await fetchVideoTranscript(id);
      done++;
      progressBar(done, videoIds.length, id);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, videoIds.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

logger.info('=== Transcript Backfill ===');

// 1. Query Airtable for videos without a transcript
let filterFormula = `{${F.transcript}} = ""`;
if (singleChannel) {
  filterFormula = `AND({${F.transcript}} = "", {${F.channelUsername}} = "${singleChannel}")`;
}

logger.info(`Querying Airtable: YouTube Videos where Transcript is empty${singleChannel ? ` (@${singleChannel})` : ''}...`);

const records = await listRecords(YT_VIDEOS_TABLE, {
  filterFormula,
  fields: [F.videoId, F.title, F.channelUsername],
  maxRecords: limitOverride || undefined,
});

if (records.length === 0) {
  logger.success('No videos missing transcripts — all caught up!');
  process.exit(0);
}

// Group by channel for display
const byChannel = {};
for (const r of records) {
  const ch = r.fields[F.channelUsername] || 'unknown';
  (byChannel[ch] = byChannel[ch] || []).push(r);
}

logger.info(`Found ${records.length} video(s) missing transcripts:`);
for (const [ch, vids] of Object.entries(byChannel)) {
  logger.info(`  @${ch}: ${vids.length} video(s)`);
}
logger.info('');

// 2. Fetch transcripts
const videoIds   = records.map(r => r.fields[F.videoId]).filter(Boolean);
const idToRecord = Object.fromEntries(records.map(r => [r.fields[F.videoId], r]));

logger.info(`Fetching transcripts (concurrency: ${YTDLP_CONCURRENCY})...`);
const transcripts = await fetchWithConcurrency(videoIds);

// 3. Build patch payload
const updates = [];
let gotTranscript = 0;
let noTranscript  = 0;

for (const [videoId, text] of Object.entries(transcripts)) {
  const record = idToRecord[videoId];
  if (!record) continue;

  if (text && text.trim()) {
    gotTranscript++;
    updates.push({ id: record.id, fields: { [F.transcript]: text.trim() } });
  } else {
    noTranscript++;
  }
}

logger.info(`  Got transcripts: ${gotTranscript}`);
logger.info(`  No captions available: ${noTranscript}`);

// 4. Patch Airtable
if (updates.length === 0) {
  logger.warn('No transcripts to write — videos may not have auto-generated captions.');
  process.exit(0);
}

logger.info(`Patching ${updates.length} record(s) in Airtable...`);
let patched = 0;
const BATCH = 10;
for (let i = 0; i < updates.length; i += BATCH) {
  await updateRecords(YT_VIDEOS_TABLE, updates.slice(i, i + BATCH));
  patched += Math.min(BATCH, updates.length - i);
  progressBar(patched, updates.length, 'patching Airtable');
}

logger.success(`Done — ${patched} transcript(s) saved to Airtable.`);
if (noTranscript > 0) {
  logger.info(`${noTranscript} video(s) had no captions (disabled or non-English videos).`);
}
