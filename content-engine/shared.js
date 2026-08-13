/**
 * content-engine shared helpers.
 *
 * Everything here follows the analyzer idiom: Brand DNA rendered once,
 * sent as a cached system block (cache_control: ephemeral), JSON-only
 * responses parsed with parseClaudeJSON.
 */

import Anthropic from '@anthropic-ai/sdk';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ANTHROPIC_API_KEY, CLAUDE_MODEL } from '../src/config.js';
import { frameworkSystemSuffix } from '../src/utils/frameworks.js';
import { parseClaudeJSON } from '../src/utils/helpers.js';
import { loadBrandDna, renderBrandDnaGenerationPrompt } from '../src/brand/dna.js';
import { logger } from '../src/utils/logger.js';

export const ENGINE_DIR  = dirname(fileURLToPath(import.meta.url));
export const QUEUE_DIR   = join(ENGINE_DIR, 'queue');
export const OUTPUT_DIR  = join(ENGINE_DIR, 'output');
export const SCRIPTS_DIR = join(ENGINE_DIR, 'scripts');

export function ensureDirs() {
  for (const d of [QUEUE_DIR, OUTPUT_DIR, SCRIPTS_DIR]) mkdirSync(d, { recursive: true });
}

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

export const GEN_SYSTEM_BASE = `You are the brand's in-house content creator for organic social.
You turn competitor research into original content in the brand's own voice — never a copy of the competitor's.
Always return valid JSON only — no markdown fences, no explanation, no preamble.${frameworkSystemSuffix()}`;

/**
 * Load Brand DNA and render the generation prompt. Generation REQUIRES
 * Brand DNA — unlike the analyzer there is no brandless fallback, because
 * voice is the whole point.
 */
export async function loadGenerationDna() {
  const dna = await loadBrandDna();
  return { dna, dnaPrompt: renderBrandDnaGenerationPrompt(dna) };
}

/**
 * One JSON-returning Claude call with the DNA block cached.
 */
export async function generateJSON(dnaPrompt, userPrompt, { maxTokens = 4096 } = {}) {
  const msg = await client.messages.create({
    model:      CLAUDE_MODEL,
    max_tokens: maxTokens,
    system: [
      { type: 'text', text: dnaPrompt, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: `\n\n---\n\n${GEN_SYSTEM_BASE}` },
    ],
    messages: [{ role: 'user', content: userPrompt }],
  });
  const text = msg.content.map(c => c.text || '').join('');
  return parseClaudeJSON(text);
}

/**
 * Same, but returning raw markdown/text (used for video scripts).
 */
export async function generateText(dnaPrompt, userPrompt, { maxTokens = 4096 } = {}) {
  const msg = await client.messages.create({
    model:      CLAUDE_MODEL,
    max_tokens: maxTokens,
    system: [
      { type: 'text', text: dnaPrompt, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: `\n\n---\n\n${GEN_SYSTEM_BASE.replace('Always return valid JSON only — no markdown fences, no explanation, no preamble.', 'Return clean markdown only — no preamble, no meta-commentary.')}` },
    ],
    messages: [{ role: 'user', content: userPrompt }],
  });
  return msg.content.map(c => c.text || '').join('');
}

export function slugify(text) {
  return String(text).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'untitled';
}

export function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Extract the `## Raw JSON` fenced block that every research report embeds.
 * Returns the parsed object, or null (never throws — reports are best-effort
 * inputs, and the miner reports what it could not read).
 */
export function extractRawJSON(reportContent) {
  if (!reportContent) return null;
  const match = reportContent.match(/## Raw JSON\s*```(?:json)?\s*([\s\S]*?)```/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch (e) {
    logger.warn(`Raw JSON block found but unparseable: ${e.message}`);
    return null;
  }
}

/** Trim a research JSON object to the keys generation actually uses. */
export function trimResearch(type, json) {
  if (!json) return null;
  const pick = (obj, keys) => {
    const out = {};
    for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
    return Object.keys(out).length ? out : null;
  };
  switch (type) {
    case 'Gap':       return pick(json, ['opportunities', 'hardGaps', 'weakSpots']);
    case 'Hooks':     return pick(json, ['winningPatterns', 'hookFormulas', 'patternsToAvoid']);
    case 'Trending':  return pick(json, ['trending', 'trendingTopics', 'emergingGems']);
    case 'Aggregate': return pick(json, ['whitespaceOpportunities', 'crossCreatorPatterns', 'saturatedTopics']);
    case 'Deep':      return json.synthesis ? { synthesis: json.synthesis } : null;
    default:          return null;
  }
}
