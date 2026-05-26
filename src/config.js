/**
 * config.js — Central environment configuration
 *
 * - Loads .env exactly once (safe to import from anywhere)
 * - Validates all required keys at startup — fails fast with a clear message
 * - Exports typed constants used across the entire project
 * - Never hardcode API keys anywhere else — always import from here
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env from project root regardless of where the process was started
const __dir = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dir, '..', '.env') });

// ─── Validation ────────────────────────────────────────────────────────────

const REQUIRED = [
  'APIFY_API_KEY',
  'ANTHROPIC_API_KEY',
  'AIRTABLE_API_KEY',
  'AIRTABLE_BASE_ID',
];

const missing = REQUIRED.filter(key => !process.env[key]?.trim());

if (missing.length > 0) {
  console.error('\n⚠  Missing required environment variables:');
  missing.forEach(k => console.error(`    • ${k}`));
  console.error('\n   Copy .env.example → .env and fill in the missing values.\n');
  process.exit(1);
}

// ─── Exports ───────────────────────────────────────────────────────────────

// Apify
export const APIFY_API_KEY         = process.env.APIFY_API_KEY;
export const APIFY_ACTOR_ID        = process.env.APIFY_ACTOR_ID        || 'apify~instagram-reel-scraper';
export const APIFY_YT_ACTOR_ID     = process.env.APIFY_YT_ACTOR_ID     || 'streamers~youtube-scraper';
export const APIFY_IG_HASHTAG_ACTOR_ID = process.env.APIFY_IG_HASHTAG_ACTOR_ID || 'apify~instagram-hashtag-scraper';
export const APIFY_TIKTOK_ACTOR_ID = process.env.APIFY_TIKTOK_ACTOR_ID || 'clockworks~tiktok-scraper';
export const APIFY_POLL_INTERVAL   = parseInt(process.env.APIFY_POLL_INTERVAL_MS || '5000');
export const APIFY_TIMEOUT         = parseInt(process.env.APIFY_TIMEOUT_MS       || '180000');
export const INSTAGRAM_SESSION_ID  = process.env.INSTAGRAM_SESSION_ID  || null;

// Anthropic / Claude
export const ANTHROPIC_API_KEY     = process.env.ANTHROPIC_API_KEY;
export const CLAUDE_MODEL          = process.env.CLAUDE_MODEL           || 'claude-opus-4-5';
export const CLAUDE_BATCH_SIZE     = parseInt(process.env.CLAUDE_BATCH_SIZE      || '10');

// Airtable
export const AIRTABLE_API_KEY      = process.env.AIRTABLE_API_KEY;
export const AIRTABLE_BASE_ID      = process.env.AIRTABLE_BASE_ID;
export const AIRTABLE_REELS_TABLE     = process.env.AIRTABLE_REELS_TABLE     || 'Reels';
export const AIRTABLE_CREATORS_TABLE  = process.env.AIRTABLE_CREATORS_TABLE  || 'Creators';
export const AIRTABLE_RUNS_TABLE      = process.env.AIRTABLE_RUNS_TABLE      || 'Runs';
export const AIRTABLE_ANALYSES_TABLE           = process.env.AIRTABLE_ANALYSES_TABLE           || 'Analyses';
export const AIRTABLE_CREATOR_ANALYSIS_TABLE   = process.env.AIRTABLE_CREATOR_ANALYSIS_TABLE   || 'Creator Analysis';
export const AIRTABLE_CUMULATIVE_ANALYSIS_TABLE = process.env.AIRTABLE_CUMULATIVE_ANALYSIS_TABLE || 'Cumulative Analysis';

// Scraping defaults
export const REELS_PER_CREATOR     = parseInt(process.env.REELS_PER_CREATOR || '20');

// Scheduling
export const CRON_SCHEDULE         = process.env.CRON_SCHEDULE          || '0 8 1,15 * *'; // bi-weekly: 1st and 15th of each month

// Debug
export const DEBUG                 = process.env.DEBUG === 'true';

// ── Supadata — YouTube Transcript API ─────────────────────────────────────
// Used for fetching transcripts from cloud IPs (Codespaces, servers) where
// YouTube directly blocks yt-dlp requests. Free tier: 100/month.
export const SUPADATA_API_KEY                = process.env.SUPADATA_API_KEY                         || null;

// ── YouTube (yt-dlp) ───────────────────────────────────────────────────────
export const YOUTUBE_VIDEOS_PER_CHANNEL      = parseInt(process.env.YOUTUBE_VIDEOS_PER_CHANNEL      || '20');
export const YTDLP_TIMEOUT                   = parseInt(process.env.YTDLP_TIMEOUT_MS                || '120000');
export const YTDLP_CONCURRENCY               = parseInt(process.env.YTDLP_CONCURRENCY               || '3');
export const YOUTUBE_COOKIES_FILE            = process.env.YOUTUBE_COOKIES_FILE                     || null;
// Live base splits YouTube into Shorts (≤180s) and Long-form (>180s) tables.
// Keep the old YT_VIDEOS_TABLE export for any legacy reader, but the new path
// uses YT_SHORTS_TABLE + YT_LONGFORM_TABLE.
export const AIRTABLE_YT_VIDEOS_TABLE        = process.env.AIRTABLE_YT_VIDEOS_TABLE                 || 'YouTube Videos';
export const AIRTABLE_YT_SHORTS_TABLE        = process.env.AIRTABLE_YT_SHORTS_TABLE                 || 'YouTube Shorts';
export const AIRTABLE_YT_LONGFORM_TABLE      = process.env.AIRTABLE_YT_LONGFORM_TABLE               || 'YouTube Long-form';
export const AIRTABLE_YT_CREATORS_TABLE      = process.env.AIRTABLE_YT_CREATORS_TABLE               || 'YouTube Creators';
export const AIRTABLE_YT_RUNS_TABLE          = process.env.AIRTABLE_YT_RUNS_TABLE                   || 'YouTube Runs';
export const YOUTUBE_CRON_SCHEDULE           = process.env.YOUTUBE_CRON_SCHEDULE                    || '0 9 1,15 * *';

// Threshold (seconds) for routing a YouTube video to Shorts vs Long-form.
export const YT_SHORTS_DURATION_MAX_S        = parseInt(process.env.YT_SHORTS_DURATION_MAX_S        || '180');

// ── Trending discovery (hashtags + niche feeds + URL submissions) ──────────
export const AIRTABLE_TRENDING_SOURCES_TABLE = process.env.AIRTABLE_TRENDING_SOURCES_TABLE          || 'Trending Sources';
export const AIRTABLE_IG_TRENDING_TABLE      = process.env.AIRTABLE_IG_TRENDING_TABLE               || 'IG Trending';
export const AIRTABLE_YT_SHORTS_TRENDING_TABLE   = process.env.AIRTABLE_YT_SHORTS_TRENDING_TABLE    || 'YT Shorts Trending';
export const AIRTABLE_YT_LONGFORM_TRENDING_TABLE = process.env.AIRTABLE_YT_LONGFORM_TRENDING_TABLE  || 'YT Long-form Trending';
export const AIRTABLE_TIKTOK_TRENDING_TABLE  = process.env.AIRTABLE_TIKTOK_TRENDING_TABLE           || 'TikTok Trending';
export const TRENDING_CRON_SCHEDULE          = process.env.TRENDING_CRON_SCHEDULE                   || '0 7 * * *';

// ── Watcher behaviour ──────────────────────────────────────────────────────
// Watchers re-trigger a creator scrape only if Last Scraped is older than this.
export const WATCH_MIN_HOURS_BETWEEN_SCRAPES = parseInt(process.env.WATCH_MIN_HOURS_BETWEEN_SCRAPES || '23');

// ── Marketing ──────────────────────────────────────────────────────────────
export const AIRTABLE_CONTENT_IDEAS_TABLE    = process.env.AIRTABLE_CONTENT_IDEAS_TABLE              || 'Content Ideas';
export const AIRTABLE_CONTENT_CALENDAR_TABLE = process.env.AIRTABLE_CONTENT_CALENDAR_TABLE           || 'Content Calendar';

// ── Brand DNA (cross-base, multi-tenant Brand OS architecture) ─────────────
// Brand DNA lives in a SEPARATE per-client Airtable base (registered in
// `Brand OS Master` → Clients table → "Brand DNA Base ID"). This pipeline
// READS that DNA on every run via src/brand/dna.js. It does NOT own or
// write Brand DNA.
//
// Default points at Abundance.AI's base as a placeholder. Switch to AN's
// own base once it's onboarded via the public form.
export const BRAND_DNA_BASE_ID            = process.env.BRAND_DNA_BASE_ID            || 'appKg5KqW82kOucCL';
export const BRAND_DNA_PROFILE_TABLE_ID   = process.env.BRAND_DNA_PROFILE_TABLE_ID   || 'tbl1tkPkABIqyJjrF'; // Brand Profile
export const BRAND_DNA_VOICE_TABLE_ID     = process.env.BRAND_DNA_VOICE_TABLE_ID     || 'tbl7ZSgUKZFpiI2I6'; // Brand Voice
export const BRAND_DNA_ICPS_TABLE_ID      = process.env.BRAND_DNA_ICPS_TABLE_ID      || 'tblioaRLaLEQSwQ1x'; // ICPs
