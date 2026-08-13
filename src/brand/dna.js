/**
 * Brand DNA loader — reads from an external per-client Brand DNA base.
 *
 * The Brand OS architecture is multi-tenant:
 *   - The `Brand OS Master` base holds the `Clients` table.
 *   - Each client has a `Brand DNA Base ID` pointing to its own Brand DNA base.
 *   - That base holds Brand Profile, Brand Voice, ICPs, Offers, etc.
 *
 * reels-intelligence consumes Brand DNA — it does NOT own it. To run
 * brand-aware analysis, point at the client's base via BRAND_DNA_BASE_ID.
 *
 * Default: Abundance.AI's Brand DNA base, used as a placeholder until
 * Acquisition Network is properly onboarded with its own base.
 *
 * Edits to the brand DNA in Airtable take effect on the next run — no
 * redeploy. The loader caches per-process; call `clearBrandDnaCache()` to
 * force a refetch.
 */

import {
  AIRTABLE_API_KEY,
  BRAND_DNA_BASE_ID,
  BRAND_DNA_PROFILE_TABLE_ID,
  BRAND_DNA_VOICE_TABLE_ID,
  BRAND_DNA_ICPS_TABLE_ID,
} from '../config.js';
import { logger } from '../utils/logger.js';

const AIRTABLE_BASE_URL = 'https://api.airtable.com/v0';

let cachedDna = null;

/**
 * Cross-base GET — hits any baseId, not just AIRTABLE_BASE_ID. We keep
 * `src/airtable/client.js` scoped to the main reels base so its usage stays
 * untouched; cross-base reads live here.
 */
async function xbFetch(baseId, tableId, { filterByFormula, maxRecords } = {}) {
  const params = new URLSearchParams();
  if (filterByFormula) params.set('filterByFormula', filterByFormula);
  if (maxRecords)      params.set('maxRecords', String(maxRecords));

  const url = `${AIRTABLE_BASE_URL}/${baseId}/${encodeURIComponent(tableId)}?${params}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Brand DNA fetch failed: ${baseId}/${tableId} → ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.records || [];
}

/**
 * Load Brand DNA from the configured per-client base.
 *
 * - Brand Profile: first record (one per base by convention)
 * - Brand Voice:   first record
 * - ICPs:          all 4 (Primary / Secondary / Tertiary / Negative)
 *
 * Returns a normalized object whose shape is stable regardless of which
 * client base it came from. Missing fields default to empty strings so
 * prompt rendering stays safe.
 */
export async function loadBrandDna({ refresh = false } = {}) {
  if (cachedDna && !refresh) return cachedDna;

  if (!BRAND_DNA_BASE_ID) {
    throw new Error(
      'BRAND_DNA_BASE_ID is not set. Point it at the client\'s Brand DNA base ' +
      '(see Clients.Brand DNA Base ID in Brand OS Master). ' +
      'Default for placeholder: appKg5KqW82kOucCL (Abundance).'
    );
  }

  const [profileRecs, voiceRecs, icpRecs] = await Promise.all([
    xbFetch(BRAND_DNA_BASE_ID, BRAND_DNA_PROFILE_TABLE_ID, { maxRecords: 1 }),
    xbFetch(BRAND_DNA_BASE_ID, BRAND_DNA_VOICE_TABLE_ID,   { maxRecords: 1 }),
    xbFetch(BRAND_DNA_BASE_ID, BRAND_DNA_ICPS_TABLE_ID),
  ]);

  if (profileRecs.length === 0) {
    throw new Error(`No Brand Profile record in ${BRAND_DNA_BASE_ID}. Fill the onboarding form first.`);
  }

  cachedDna = normalize(profileRecs[0], voiceRecs[0] || null, icpRecs);
  logger.info(`Brand DNA loaded: "${cachedDna.brandName}" from base ${BRAND_DNA_BASE_ID}`);
  return cachedDna;
}

export function clearBrandDnaCache() {
  cachedDna = null;
}

function f(record, name) {
  return (record && record.fields && record.fields[name]) || '';
}

function normalize(profile, voice, icps) {
  // ICPs come back as up to 4 records by Type. Bucket them.
  const byType = { Primary: null, Secondary: null, Tertiary: null, Negative: null };
  for (const r of icps) {
    const type = f(r, 'Type')?.name || f(r, 'Type'); // singleSelect may be object or string
    if (byType[type] === null) byType[type] = r;
  }

  const primary = byType.Primary;

  return {
    brandName:          f(profile, 'Brand Name')      || '(unnamed brand)',
    companyIdentity:    f(profile, 'Company Identity'),
    oneLiner:           f(profile, 'Company One-Liner'),
    transformation:     f(profile, 'The Transformation We Promise'),
    riskReversal:       f(profile, 'The Risk Reversal'),
    bigIdea:            f(profile, 'The Big Idea / Unique Mechanism'),
    founderOrigin:      f(profile, 'Founder Origin Story'),
    coreValues:         f(profile, 'Core Values'),
    antiPositioning:    f(profile, 'Anti-Positioning'),
    sharedEnemy:        f(profile, 'The Shared Enemy'),
    proprietaryTerms:   f(profile, 'Proprietary Terminology'),
    growthStory:        f(profile, "Company's Own Growth Story"),
    currentScale:       f(profile, 'Current Company Scale'),
    credibilityStats:   f(profile, 'Aggregate Brand Credibility & Stats'),
    offerLadder:        f(profile, 'Offer Ladder / Product Hierarchy'),
    voicePOV:           f(profile, 'Brand Voice POV'),
    presenterEnergy:    f(profile, 'Presenter Energy'),

    // Brand Voice table — fully optional. Empty object if missing.
    voice: voice ? {
      tonePersona:    f(voice, 'Tone & Persona'),
      voiceRules:     f(voice, 'Voice Rules'),
      forbiddenTopics:f(voice, 'Forbidden Topics'),
      approvedCopy:   f(voice, 'Approved Copy Examples'),
      founderSamples: f(voice, 'Founder Voice Samples'),
    } : {},

    // Primary ICP is the default lens. Secondary/Tertiary/Negative kept on
    // the side for any analyzer that wants to score multiple audiences.
    primaryIcp: primary ? {
      label:           f(primary, 'Label'),
      identity:        f(primary, 'Identity'),
      world:           f(primary, 'World / Day-In-Life'),
      corePain:        f(primary, 'Core Pain'),
      desire:          f(primary, 'Desire'),
      vocLanguage:     f(primary, 'Voice-of-Customer Language'),
      mindsetUnaware:  f(primary, 'Mindset When Unaware'),
      mindsetProblem:  f(primary, 'Mindset When Problem-Aware'),
      mindsetSolution: f(primary, 'Mindset When Solution-Aware'),
      mindsetProduct:  f(primary, 'Mindset When Product-Aware'),
      mindsetMost:     f(primary, 'Mindset When Most-Aware'),
      financialReality:f(primary, 'Financial Reality'),
      daggers:         f(primary, "What They've Tried Before (Daggers)"),
    } : null,

    negativeIcp: byType.Negative ? {
      label:    f(byType.Negative, 'Label'),
      identity: f(byType.Negative, 'Identity'),
      whyNotFit:f(byType.Negative, 'Why Not a Fit'),
    } : null,
  };
}

/**
 * Render Brand DNA as a system-prompt block.
 *
 * Keep it scoped — Claude reads this on every analyzer call, so token cost
 * scales linearly. We include Profile, Voice, and Primary ICP; Secondary /
 * Tertiary / Negative are loaded but not sent unless an analyzer asks.
 */
export function renderBrandDnaPrompt(dna) {
  const v = dna.voice || {};
  const icp = dna.primaryIcp;

  return `# Brand DNA: ${dna.brandName}

You are analyzing content for **${dna.brandName}**. Every recommendation, hook
rewrite, or content idea must fit this brand. Generic best practice is NOT the
goal — brand-fit is.

## Identity
${dna.companyIdentity || '(not set)'}

**One-liner:** ${dna.oneLiner || '(not set)'}

## Transformation We Promise
${dna.transformation || '(not set)'}

## The Big Idea / Unique Mechanism
${dna.bigIdea || '(not set)'}

## Founder Origin
${dna.founderOrigin || '(not set)'}

## Anti-Positioning (what we are NOT)
${dna.antiPositioning || '(not set)'}

## The Shared Enemy
${dna.sharedEnemy || '(not set)'}

## Proprietary Terminology
${dna.proprietaryTerms || '(not set)'}

## Voice
**Tone & Persona:** ${v.tonePersona || '(not set)'}

**Voice Rules:** ${v.voiceRules || '(not set)'}

**Forbidden Topics:** ${v.forbiddenTopics || '(not set)'}

**Approved Copy Examples:**
${v.approvedCopy || '(not set)'}

## Primary ICP${icp ? ` — ${icp.label}` : ''}
${icp ? `**Identity:** ${icp.identity}

**Core Pain:** ${icp.corePain}

**Desire:** ${icp.desire}

**Voice-of-Customer Language:** ${icp.vocLanguage}

**Daggers (what they've tried):** ${icp.daggers}` : '(no Primary ICP record found)'}

## Negative ICP (refuse to serve)
${dna.negativeIcp ? `**${dna.negativeIcp.label}** — ${dna.negativeIcp.whyNotFit}` : '(not set)'}

## Rules for every output
1. Reject anything that violates Voice Rules or names a Forbidden Topic.
2. Hooks and templates must echo the brand's Tone & Persona and Big Idea.
3. Score brand-fit relative to the Primary ICP's Core Pain and Desire.
4. If the analyzed content targets a Negative ICP, mark BRAND-INCOMPATIBLE.
5. Voice should match the Approved Copy Examples, not the analyzed creator's.
`;
}

/**
 * Render Brand DNA for content GENERATION (content-engine).
 *
 * Richer than the analyzer prompt on purpose: generation needs the voice
 * samples, offer ladder, credibility stats, and presenter energy that the
 * analyzer deliberately omits for token economy. Generation runs are few
 * and human-reviewed, so the extra tokens are worth it — and the block is
 * cached with cache_control: ephemeral like the analyzer's.
 */
export function renderBrandDnaGenerationPrompt(dna) {
  const v = dna.voice || {};
  const icp = dna.primaryIcp;

  return `# Brand DNA: ${dna.brandName}

You are writing content AS **${dna.brandName}** — first-person brand voice,
not commentary about the brand. Every hook, slide, caption, and script you
produce is something the brand itself will publish.

## Identity
${dna.companyIdentity || '(not set)'}

**One-liner:** ${dna.oneLiner || '(not set)'}

## Transformation We Promise
${dna.transformation || '(not set)'}

## The Big Idea / Unique Mechanism
${dna.bigIdea || '(not set)'}

## Founder Origin
${dna.founderOrigin || '(not set)'}

## Anti-Positioning (what we are NOT)
${dna.antiPositioning || '(not set)'}

## The Shared Enemy
${dna.sharedEnemy || '(not set)'}

## Proprietary Terminology (use naturally where it fits)
${dna.proprietaryTerms || '(not set)'}

## Credibility & Stats (only cite what appears here — never invent numbers)
${dna.credibilityStats || '(not set)'}

## Offer Ladder (what CTAs can point to)
${dna.offerLadder || '(not set)'}

## Voice
**POV:** ${dna.voicePOV || '(not set)'}

**Presenter Energy:** ${dna.presenterEnergy || '(not set)'}

**Tone & Persona:** ${v.tonePersona || '(not set)'}

**Voice Rules:** ${v.voiceRules || '(not set)'}

**Forbidden Topics:** ${v.forbiddenTopics || '(not set)'}

**Approved Copy Examples (match this voice exactly):**
${v.approvedCopy || '(not set)'}

**Founder Voice Samples (how the founder actually talks):**
${v.founderSamples || '(not set)'}

## Primary ICP${icp ? ` — ${icp.label}` : ''}
${icp ? `**Identity:** ${icp.identity}

**World / Day-In-Life:** ${icp.world}

**Core Pain:** ${icp.corePain}

**Desire:** ${icp.desire}

**Voice-of-Customer Language (use their words):** ${icp.vocLanguage}

**Daggers (what they've tried that failed):** ${icp.daggers}` : '(no Primary ICP record found)'}

## Negative ICP (never write for these people)
${dna.negativeIcp ? `**${dna.negativeIcp.label}** — ${dna.negativeIcp.whyNotFit}` : '(not set)'}

## Rules for every output
1. Write AS the brand. Match the Approved Copy Examples and Founder Voice
   Samples — not the competitors whose research inspired the angle.
2. Never violate a Voice Rule or touch a Forbidden Topic. If an angle
   requires one, refuse it and say why instead of softening it.
3. Every piece targets the Primary ICP's Core Pain and Desire, in their
   Voice-of-Customer language. Never write for the Negative ICP.
4. Never invent statistics, client results, or credibility claims — only
   use what the Credibility & Stats section provides.
5. CTAs must point to something real on the Offer Ladder.
6. No em dashes or en dashes anywhere in output copy — use normal hyphens
   or restructure the sentence.
`;
}
