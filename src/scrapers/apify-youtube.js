/**
 * apify-youtube.js — Scrapes YouTube channel videos via Apify's youtube-scraper actor.
 *
 * Use this instead of ytdlp.js when running in cloud environments (GitHub Actions,
 * Trigger.dev, Codespaces) where YouTube blocks yt-dlp requests.
 *
 * Actor: streamers~youtube-scraper
 * Returns: full metadata (title, views, likes, comments, duration, description, tags)
 * Does NOT return transcripts — run fetch-transcripts.js locally for that.
 *
 * Cost estimate: ~$0.25–0.50 per 1,000 videos (much cheaper than workarounds)
 */

import { logger }          from '../utils/logger.js';
import { APIFY_API_KEY, APIFY_YT_ACTOR_ID, APIFY_POLL_INTERVAL, APIFY_TIMEOUT } from '../config.js';

const BASE_URL = 'https://api.apify.com/v2';

async function apifyFetch(path, options = {}) {
  const url = `${BASE_URL}${path}${path.includes('?') ? '&' : '?'}token=${APIFY_API_KEY}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Apify ${res.status}: ${body}`);
  }
  return res.json();
}

async function startRun(input) {
  const data = await apifyFetch(`/acts/${APIFY_YT_ACTOR_ID}/runs`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return data.data.id;
}

async function waitForRun(runId) {
  const deadline = Date.now() + APIFY_TIMEOUT;
  let interval   = APIFY_POLL_INTERVAL;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval));
    interval = Math.min(interval * 1.3, 30000);

    const data   = await apifyFetch(`/actor-runs/${runId}`);
    const status = data.data.status;
    logger.step(`Apify YT run ${runId}: ${status}`);

    if (status === 'SUCCEEDED') return;
    if (status === 'FAILED' || status === 'ABORTED') {
      throw new Error(`Apify YT run ${status}: ${data.data.statusMessage || 'no message'}`);
    }
  }
  throw new Error(`Apify YT run timed out after ${APIFY_TIMEOUT / 1000}s`);
}

async function getRunItems(runId, limit) {
  const data = await apifyFetch(`/actor-runs/${runId}/dataset/items?limit=${limit}`);
  return Array.isArray(data) ? data : (data.items || []);
}

/**
 * Scrape up to `limit` videos from a YouTube channel using Apify.
 * Returns raw Apify items — pass to normalizeApifyVideos() in youtube.js.
 *
 * @param {string} channelUsername — @handle without @
 * @param {number} limit           — max videos to fetch
 * @param {object} opts
 * @param {boolean} opts.shortsOnly — fetch Shorts instead of regular videos (default: false)
 */
export async function scrapeChannelVideosApify(channelUsername, limit = 20, { shortsOnly = false } = {}) {
  const tab  = shortsOnly ? 'shorts' : 'videos';
  const url  = `https://www.youtube.com/@${channelUsername}/${tab}`;

  logger.info(`Apify YT: scraping @${channelUsername}/${tab} (limit: ${limit})`);

  const input = {
    startUrls:         [{ url }],
    maxResults:        shortsOnly ? 0        : limit,
    maxResultsShorts:  shortsOnly ? limit    : 0,
    maxResultStreams:   0,
  };

  const runId = await startRun(input);
  logger.step(`Apify YT run started: ${runId}`);

  await waitForRun(runId);
  logger.success(`Apify YT run complete: ${runId}`);

  const items = await getRunItems(runId, limit);
  logger.success(`Fetched ${items.length} video(s) for @${channelUsername}`);
  return items;
}
