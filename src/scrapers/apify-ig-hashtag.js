/**
 * apify-ig-hashtag.js — Instagram hashtag discovery via Apify.
 *
 * Used by the trending pipeline. When a `Trending Sources` row of type
 * "IG Hashtag" runs, this scraper pulls the top reels under that hashtag
 * which then flow into the IG Trending table (separate from the
 * creator-tracked Reels table).
 */

import { runActor } from './apify.js';
import { APIFY_IG_HASHTAG_ACTOR_ID } from '../config.js';
import { normalizeReels } from './instagram.js';
import { logger } from '../utils/logger.js';

/**
 * Scrape top reels for a hashtag.
 * @param {string} hashtag  e.g. "salescoaching" (no leading #)
 * @param {number} limit
 */
export async function scrapeIgHashtag(hashtag, limit = 30) {
  const tag = hashtag.replace(/^#/, '');
  logger.info(`IG hashtag: #${tag} (limit: ${limit})`);
  const input = {
    hashtags:     [tag],
    resultsLimit: limit,
    resultsType:  'posts',
  };
  const items = await runActor(APIFY_IG_HASHTAG_ACTOR_ID, input, limit);

  // The hashtag actor returns a mix of posts and reels. Filter to reels only,
  // then normalize using the IG normalizer so the rest of the pipeline can
  // treat them like any other reel.
  const reels = items.filter((i) => i.type === 'Video' || i.productType === 'clips' || i.isVideo);
  return normalizeReels(reels, `#${tag}`);
}
