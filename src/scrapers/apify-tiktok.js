/**
 * apify-tiktok.js — TikTok video scraping via Apify.
 *
 * Used by the trending pipeline (TikTok trending feed) and by direct URL
 * submissions when the platform routes to TikTok.
 */

import { runActor } from './apify.js';
import { APIFY_TIKTOK_ACTOR_ID } from '../config.js';
import { logger } from '../utils/logger.js';

/**
 * Scrape videos for a TikTok hashtag or query.
 * Returns raw items from the actor.
 */
export async function scrapeTikTokHashtag(hashtag, limit = 30) {
  const cleanTag = hashtag.replace(/^#/, '');
  logger.info(`TikTok: hashtag #${cleanTag} (limit: ${limit})`);
  const input = {
    hashtags:        [cleanTag],
    resultsPerPage:  limit,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
  };
  return runActor(APIFY_TIKTOK_ACTOR_ID, input, limit);
}

/**
 * Scrape videos for a single TikTok creator profile.
 */
export async function scrapeTikTokProfile(username, limit = 20) {
  const handle = username.replace(/^@/, '');
  logger.info(`TikTok: profile @${handle} (limit: ${limit})`);
  const input = {
    profiles:        [handle],
    resultsPerPage:  limit,
    shouldDownloadVideos: false,
  };
  return runActor(APIFY_TIKTOK_ACTOR_ID, input, limit);
}

/**
 * Scrape a single TikTok video URL.
 */
export async function scrapeTikTokUrl(url) {
  logger.info(`TikTok: single URL ${url}`);
  const input = { postURLs: [url], shouldDownloadVideos: false };
  return runActor(APIFY_TIKTOK_ACTOR_ID, input, 1);
}

/**
 * Normalize a raw Apify TikTok item into the shape the rest of the pipeline
 * expects (mirrors the IG reel normalizer from src/scrapers/instagram.js).
 */
export function normalizeTikTokItem(item) {
  return {
    reelId:     item.id || item.videoId,
    url:        item.webVideoUrl || item.videoUrl || item.url,
    username:   item.authorMeta?.name || item.author?.uniqueId || '',
    caption:    item.text || item.desc || '',
    transcript: item.captionsText || '',
    hashtags:   (item.hashtags || []).map((h) => h.name || h).filter(Boolean),
    audioTitle: item.musicMeta?.musicName || '',

    views:           item.playCount || item.videoMeta?.playCount || 0,
    likes:           item.diggCount || 0,
    comments:        item.commentCount || 0,
    shares:          item.shareCount || 0,
    duration:        item.videoMeta?.duration || item.duration || null,

    publishedAt: item.createTimeISO || (item.createTime ? new Date(item.createTime * 1000).toISOString() : null),
    scrapedAt:   new Date().toISOString(),

    raw: item,
  };
}
