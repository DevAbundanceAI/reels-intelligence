/**
 * linkedin-engine shared helpers.
 *
 * Same idiom as content-engine/shared.js (Anthropic client, JSON-only
 * responses, ephemeral prompt caching) but:
 *   - reads Voice & Rules + Source Library from the LinkedIn Engine base
 *     (appdbuuWKHcTikOaF) via src/airtable/xbase.js, not Brand DNA
 *   - uses LINKEDIN_CLAUDE_MODEL, a pinned-current default kept separate
 *     from the shared CLAUDE_MODEL (that one is pinned for the reels
 *     pipeline and intentionally left untouched)
 *   - never loads Brand Profile stats/offer ladder (Brand DNA numbers are
 *     stale against itsryanfrost.com — see Part B of the plan)
 */

import Anthropic from '@anthropic-ai/sdk';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ANTHROPIC_API_KEY, LINKEDIN_CLAUDE_MODEL, LINKEDIN_BASE_ID, LINKEDIN_SOURCES_TABLE, LINKEDIN_RULES_TABLE } from '../src/config.js';
import { listRecords } from '../src/airtable/xbase.js';
import { parseClaudeJSON } from '../src/utils/helpers.js';
import { logger } from '../src/utils/logger.js';

export const ENGINE_DIR = dirname(fileURLToPath(import.meta.url));
export const QUEUE_DIR  = join(ENGINE_DIR, 'queue');
export const OUTPUT_DIR = join(ENGINE_DIR, 'output');
export const SEED_DIR   = join(ENGINE_DIR, 'seed');

export function ensureDirs() {
  for (const d of [QUEUE_DIR, OUTPUT_DIR]) mkdirSync(d, { recursive: true });
}

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

export function slugify(text) {
  return String(text).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'untitled';
}

export function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

let cachedRules = null;
let cachedSources = null;

/** Active rows from Voice & Rules, one fetch per process (call with refresh:true to bust). */
export async function loadRules({ refresh = false } = {}) {
  if (cachedRules && !refresh) return cachedRules;
  const records = await listRecords(LINKEDIN_BASE_ID, LINKEDIN_RULES_TABLE, {
    filterFormula: '{Active} = TRUE()',
    sort: [{ field: 'Sort', direction: 'asc' }],
  });
  cachedRules = records.map(r => ({
    id: r.id,
    rule: r.fields['Rule'] || '',
    type: r.fields['Type'] || '',
    detail: r.fields['Detail'] || '',
    appliesTo: r.fields['Applies To'] || 'Both',
    enforcedBy: r.fields['Enforced By'] || 'Prompt',
    example: r.fields['Example'] || '',
  }));
  return cachedRules;
}

/** Only Claim Safety = Safe, Active rows from Source Library — the sole set generation may read while Ryan is offline. */
export async function loadSources({ refresh = false, titles = null } = {}) {
  if (cachedSources && !refresh && !titles) return cachedSources;
  const records = await listRecords(LINKEDIN_BASE_ID, LINKEDIN_SOURCES_TABLE, {
    filterFormula: 'AND({Claim Safety} = "Safe", {Active} = TRUE())',
  });
  const sources = records.map(r => ({
    id: r.id,
    title: r.fields['Title'] || '',
    path: r.fields['Source Path'] || '',
    kind: r.fields['Kind'] || '',
    substance: r.fields['Substance'] || '',
    canonicalNumbers: r.fields['Canonical Numbers'] || '',
    angleIdeas: r.fields['Angle Ideas'] || '',
  }));
  if (!titles) { cachedSources = sources; return sources; }
  const wanted = new Set(titles);
  return sources.filter(s => wanted.has(s.title));
}

/**
 * Assemble the system prompt from Voice & Rules rows, grouped by Type,
 * plus the hard identity/claim-tier block from the plan. This is the
 * Ryan-specific system layer — it does NOT extend a Brand DNA prompt.
 */
export async function buildSystemPrompt() {
  const rules = await loadRules();
  const byType = (t) => rules.filter(r => r.type === t);
  const renderRows = (rows) => rows.map(r => `- ${r.rule}: ${r.detail}${r.example ? `\n  Example: ${r.example}` : ''}`).join('\n');

  return `You write LinkedIn posts for Ryan Frost's own personal profile, in his voice, using ONLY the source excerpts supplied in the user message. Never invent a number, a name, a date, or a result. Return JSON only, no markdown fences, no preamble, no explanation.

IDENTITY (verbatim facts, from itsryanfrost.com):
Ryan Frost. Fractional head of growth. 3x founder. Based in Phoenix, Arizona. Six years installing growth engines for founder-led companies. $11.5M+ generated across 7 engagements. Ventures: Expert Health (co-founder and President, Ciara is CEO, never obscure that), HeyFrosty.ai / Frosty (founder; built in under three months with no developers; do not promote it, do not use "sign up" / "$100 free" / "heyfrosty.ai"), Abundance.AI (founder; "my team" delivers the work). Current positioning is AI implementation. Named things, used identically every time: "AI Growth Assessment", "AI Growth Discovery Call", "God Mode", "Constraint-First AI Mapping". The price is NEVER written, in any form.

VOICE RULES (active, from the Voice & Rules table):
${renderRows(byType('Voice Rule'))}

BANNED PHRASES (never use, in any form):
${renderRows(byType('Banned Phrase'))}

BANNED PATTERNS (regex the validator also checks, write around these, don't rely on the validator to catch you):
${renderRows(byType('Banned Pattern'))}

CANONICAL NUMBERS (the ONLY numbers you may cite; use them verbatim, as totals, never as $/mo or any rate):
${renderRows(byType('Canonical Number'))}

OFFER LANGUAGE (one name per thing):
${renderRows(byType('Offer Language'))}

FORMAT RULES:
${renderRows(byType('Format Rule'))}

STORY RECIPES (follow the one matching the requested story_type):
${renderRows(byType('Story Recipe'))}

HOOK PATTERNS (reference bank, not a checklist, the hook is usually supplied to you pre-written; if you must write one, draw on these):
${renderRows(byType('Hook Pattern'))}

CLAIM TIERS:
- SAFE: numbers and facts from the "Canonical Numbers" block above, and any Substance text from a source explicitly marked Claim Safety = Safe.
- NEEDS RYAN OK: anything not in Canonical Numbers or not clearly stated in a Safe source's Substance, a name, a stat, a detail you are tempted to add for color. When in doubt, leave it out or mark the claim "tier": "Needs Ryan OK" and set status to "held".
- CONFIDENTIAL: never write anything about Smart Sellers Academy beyond the single past-tense $1.5M receipt already public; never write Expert Health sales, order, revenue, or product-name detail; never name a client's internal metrics (CAC, show rate, P&L).

Every number and every named company or person in your output MUST appear in a "claims" array entry with the exact text and its source. If you cannot point to a source, do not write the claim.

Output valid JSON only, matching exactly the contract given in the user message.`;
}

/**
 * One JSON-returning Claude call, LinkedIn engine's own system prompt
 * cached as the first (large, stable) system block — same ephemeral-cache
 * shape as content-engine/shared.js generateJSON, independent model.
 */
export async function generateJSON(systemPrompt, userPrompt, { maxTokens = 4096 } = {}) {
  const msg = await client.messages.create({
    model: LINKEDIN_CLAUDE_MODEL,
    max_tokens: maxTokens,
    system: [
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: userPrompt }],
  });
  const text = msg.content.map(c => c.text || '').join('');
  return parseClaudeJSON(text);
}

export { logger };

/**
 * Build a UTC ISO datetime string for a given America/New_York wall-clock
 * date+time, resolving the correct DST offset for that specific date (the
 * batch runs entirely in EDT, but this holds for any date). Airtable (and
 * the LinkedIn publish runner, which compares the absolute instant) need
 * a real offset here — a bare "T08:30:00" with no zone would be read as
 * UTC, which is 4-5 hours off from the intended Eastern send time.
 */
export function nyIsoString(dateStr, timeStr) {
  const probe = new Date(`${dateStr}T${timeStr}:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', timeZoneName: 'shortOffset', hour: '2-digit',
  }).formatToParts(probe);
  const tzPart = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT-5';
  const match = tzPart.match(/GMT([+-]\d+)/);
  const offsetHours = match ? parseInt(match[1], 10) : -5;
  const sign = offsetHours <= 0 ? '-' : '+';
  const abs = String(Math.abs(offsetHours)).padStart(2, '0');
  return `${dateStr}T${timeStr}:00${sign}${abs}:00`;
}
