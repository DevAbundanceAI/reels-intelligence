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
export const APIFY_POLL_INTERVAL   = parseInt(process.env.APIFY_POLL_INTERVAL_MS || '5000');
export const APIFY_TIMEOUT         = parseInt(process.env.APIFY_TIMEOUT_MS       || '180000');

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
export const AIRTABLE_ANALYSES_TABLE  = process.env.AIRTABLE_ANALYSES_TABLE  || 'Analyses';

// Scraping defaults
export const REELS_PER_CREATOR     = parseInt(process.env.REELS_PER_CREATOR || '20');

// Scheduling
export const CRON_SCHEDULE         = process.env.CRON_SCHEDULE          || '0 8 1,15 * *'; // bi-weekly: 1st and 15th of each month

// Debug
export const DEBUG                 = process.env.DEBUG === 'true';
