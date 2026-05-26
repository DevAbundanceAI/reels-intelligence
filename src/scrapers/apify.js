import { logger } from '../utils/logger.js';
import { APIFY_API_KEY, APIFY_ACTOR_ID, APIFY_POLL_INTERVAL, APIFY_TIMEOUT } from '../config.js';

const BASE_URL = 'https://api.apify.com/v2';
const API_KEY  = APIFY_API_KEY;
const ACTOR_ID = APIFY_ACTOR_ID;
const POLL_MS  = APIFY_POLL_INTERVAL;
const TIMEOUT  = APIFY_TIMEOUT;

async function apifyFetch(path, options = {}) {
  const url = `${BASE_URL}${path}${path.includes('?') ? '&' : '?'}token=${API_KEY}`;
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

/**
 * Start an Apify actor run and return the run ID.
 * @param {object} input — actor input payload
 * @param {string} [actorId] — defaults to ACTOR_ID (reel scraper)
 */
async function startRun(input, actorId = ACTOR_ID) {
  const data = await apifyFetch(`/acts/${actorId}/runs`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return data.data.id;
}

/**
 * Poll until the run succeeds, fails, or times out.
 * Uses exponential backoff: 5s → 8s → 13s → ... (capped at 30s)
 */
async function waitForRun(runId) {
  const deadline = Date.now() + TIMEOUT;
  let interval = POLL_MS;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval));
    interval = Math.min(interval * 1.3, 30000);

    const data = await apifyFetch(`/actor-runs/${runId}`);
    const status = data.data.status;
    logger.step(`Apify run ${runId}: ${status}`);

    if (status === 'SUCCEEDED') return;
    if (status === 'FAILED' || status === 'ABORTED') {
      throw new Error(`Apify run ${status}: ${data.data.statusMessage || 'no message'}`);
    }
  }
  throw new Error(`Apify run timed out after ${TIMEOUT / 1000}s`);
}

/**
 * Fetch dataset items from a completed run.
 */
async function getRunItems(runId, limit) {
  const data = await apifyFetch(`/actor-runs/${runId}/dataset/items?limit=${limit}`);
  // Apify returns the array directly for dataset items
  return Array.isArray(data) ? data : (data.items || []);
}

/**
 * Main export: scrape reels for a given username.
 * Returns array of raw reel objects from Apify.
 */
export async function scrapeCreatorReels(username, limit = 20) {
  logger.info(`Apify: starting scrape for @${username} (limit: ${limit})`);

  const input = {
    username: [username],
    resultsLimit: limit,
  };

  const runId = await startRun(input);
  logger.step(`Apify run started: ${runId}`);

  await waitForRun(runId);
  logger.success(`Apify run complete: ${runId}`);

  const items = await getRunItems(runId, limit);
  logger.success(`Fetched ${items.length} reels for @${username}`);
  return items;
}

/**
 * Scrape profile data for a creator — returns follower count and basic profile info.
 * Uses the apify~instagram-profile-scraper actor (separate from reel scraper).
 * Returns null and logs a warning on failure so it never blocks the main pipeline.
 *
 * @param {string} username — Instagram handle (without @)
 * @returns {Promise<{followersCount: number, fullName: string}|null>}
 */
export async function scrapeCreatorProfile(username) {
  logger.info(`Apify: fetching profile for @${username}`);
  try {
    const input = { usernames: [username] };
    const runId = await startRun(input, 'apify~instagram-profile-scraper');
    logger.step(`Apify profile run started: ${runId}`);
    await waitForRun(runId);
    const items = await getRunItems(runId, 1);
    const profile = items[0];
    if (!profile || profile.error) {
      logger.warn(`No profile data returned for @${username}`);
      return null;
    }
    return {
      followersCount: profile.followersCount || profile.followingCount && profile.edge_followed_by?.count || 0,
      fullName:       profile.fullName || profile.biography && username || username,
    };
  } catch (e) {
    logger.warn(`Profile scrape failed for @${username}: ${e.message}`);
    return null;
  }
}

/**
 * Generic actor runner — start + poll + fetch items.
 * Use this from new scrapers (TikTok, IG hashtag, etc.) so they don't have to
 * duplicate the polling logic.
 */
export async function runActor(actorId, input, limit = 50) {
  logger.info(`Apify: starting ${actorId}`);
  const runId = await startRun(input, actorId);
  logger.step(`Apify run started: ${runId}`);
  await waitForRun(runId);
  const items = await getRunItems(runId, limit);
  logger.success(`Apify: ${items.length} items from ${actorId}`);
  return items;
}

/**
 * Scrape a single reel URL.
 */
export async function scrapeReelUrl(url, limit = 1) {
  logger.info(`Apify: scraping single reel: ${url}`);
  const input = { directUrls: [url], resultsLimit: limit };
  const runId = await startRun(input);
  await waitForRun(runId);
  return getRunItems(runId, limit);
}

// --- CLI test ---
if (process.argv.includes('--test')) {
  logger.info('Testing Apify connection...');
  try {
    const items = await scrapeCreatorReels('cristiano', 3);
    logger.success(`Connection OK — got ${items.length} reels`);
    console.log(JSON.stringify(items[0], null, 2));
  } catch (e) {
    logger.error('Apify test failed', e.message);
    process.exit(1);
  }
}
