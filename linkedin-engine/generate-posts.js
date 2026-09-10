/**
 * linkedin-engine/generate-posts.js — turns one editorial plan item into a
 * generated post (text) or carousel deck (JSON), validated, one retry on
 * failure, written to queue/.
 *
 * Usage:
 *   node linkedin-engine/generate-posts.js --plan seed/plan-2026-09-15.json [--only <slug>]
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../src/utils/logger.js';
import {
  ensureDirs, QUEUE_DIR, buildSystemPrompt, generateJSON, loadSources, slugify,
} from './shared.js';
import { validateTextPost, validateDeck } from './validate.js';

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (flag) => { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : null; };
  return { plan: get('--plan'), only: get('--only') };
}

const TEXT_CONTRACT = `Return a JSON object with exactly this shape:
{
  "id": "<slug>",
  "format": "text",
  "pillar": "<pillar>",
  "story_type": "<story type>",
  "working_title": "...",
  "hook": "<the exact hook line supplied to you, or a close edit if it needs to fit 140 chars>",
  "body": "2-4 short paragraphs, separated by blank lines, NOT including the hook line",
  "wrap_line": "the last sentence of body — a tie-back, never an ask",
  "cta": "none",
  "hashtags": [],
  "claims": [{"text": "...", "tier": "Safe", "source": "<source title>"}],
  "sources": ["<source titles used>"]
}
The hook plus body plus one blank line between them must total 600-1300 characters. Do not include the hashtags array as text in body.`;

const DECK_CONTRACT = `Return a JSON object with exactly this shape:
{
  "id": "<slug>",
  "format": "carousel",
  "pillar": "<pillar>",
  "story_type": "<story type>",
  "document_title": "<=60 chars, shown as the PDF title on LinkedIn",
  "caption": "150-300 chars, hook first, creates curiosity, does NOT summarize the slides, no URL",
  "hashtags": [],
  "slides": [
    {"type": "hook", "eyebrow": "2-4 WORD LABEL", "headline": "<=12 words", "emphasis": "substring of headline", "sub": "one line or null"},
    {"type": "point", "number": 1, "headline": "...", "emphasis": "...", "body": "<=30 words"},
    {"type": "list", "eyebrow": "...", "headline": "...", "emphasis": "...", "items": ["3-6 short items"]},
    {"type": "quote", "quote": "...", "attribution": "Ryan Frost"},
    {"type": "stat", "eyebrow": "...", "value": "$989K", "label": "one line, must match a canonical number"},
    {"type": "before_after", "headline": "...", "emphasis": "...", "before": {"label": "Before", "items": []}, "after": {"label": "After", "items": []}},
    {"type": "signoff", "headline": "optional one-line wrap, no ask"}
  ],
  "claims": [{"text": "...", "tier": "Safe", "source": "<source title>"}],
  "sources": ["<source titles used>"]
}
Slide 1 MUST be type "hook". The LAST slide MUST be type "signoff" (name/site are added by the renderer — only write an optional "headline" wrap line, or omit it). Use 6 to 10 slides total, one idea per slide, about 30 words max per slide (headline+sub+body+items combined). "emphasis" must be copied EXACTLY as a substring of that slide's own headline. Use only the slide types you need — hook first and signoff last are the only fixed positions.`;

function userPrompt(item, sources) {
  const sourceBlock = sources.map(s => `### ${s.title} (${s.kind})\n${s.substance}\n${s.canonicalNumbers ? `Canonical numbers for this source: ${s.canonicalNumbers}` : ''}`).join('\n\n');
  return `Write a LinkedIn ${item.format === 'carousel' ? 'carousel deck' : 'text post'} for Ryan Frost.

Pillar: ${item.pillar}
Story type: ${item.story_type}
Working title: ${item.title}
Angle: ${item.angle}
Pre-written hook (use verbatim unless it must be trimmed to fit 140 chars): ${item.hook}
${item.outline ? `Outline to follow:\n${item.outline.map((o, i) => `${i + 1}. ${o}`).join('\n')}` : ''}

SOURCE MATERIAL (the only facts you may draw from):
${sourceBlock}

${item.format === 'carousel' ? DECK_CONTRACT : TEXT_CONTRACT}
Return ONLY the JSON object, no markdown fences.`;
}

async function generateOne(item, systemPrompt) {
  const sources = await loadSources({ titles: item.sources });
  if (item.sources.length !== sources.length) {
    const missing = item.sources.filter(t => !sources.find(s => s.title === t));
    logger.warn(`${item.slug}: ${missing.length} source(s) not found or not Safe: ${missing.join(', ')}`);
  }

  const prompt = userPrompt(item, sources);
  let result = await generateJSON(systemPrompt, prompt, { maxTokens: 4096 });
  let problems = item.format === 'carousel' ? validateDeck(result) : validateTextPost(result);
  const hardProblems = problems.filter(p => !p.startsWith('FLAG:'));

  if (hardProblems.length) {
    logger.warn(`${item.slug}: ${hardProblems.length} problem(s) on first pass, retrying once`);
    const retryPrompt = `${prompt}\n\nYour previous attempt had these problems — fix EXACTLY these and return the corrected JSON:\n${hardProblems.map(p => `- ${p}`).join('\n')}`;
    result = await generateJSON(systemPrompt, retryPrompt, { maxTokens: 4096 });
    problems = item.format === 'carousel' ? validateDeck(result) : validateTextPost(result);
  }

  result.slug = item.slug || slugify(result.working_title || result.document_title || item.title);
  result.generatedAt = new Date().toISOString();
  result.constraintProblems = problems;
  result.pillar = item.pillar;
  result.story_type = item.story_type;
  result.schedule = item.schedule;
  result.claimNotes = (result.claims || []).map(c => `${c.text} (${c.tier}) — ${c.source}`).join('\n');
  return result;
}

async function main() {
  const { plan, only } = parseArgs();
  if (!plan) throw new Error('Pass --plan seed/plan-<batch>.json');
  ensureDirs();

  const items = JSON.parse(readFileSync(plan, 'utf8'));
  const targets = only ? items.filter(i => i.slug === only) : items;
  if (!targets.length) throw new Error(only ? `No plan item with slug "${only}"` : 'Plan file is empty');

  const systemPrompt = await buildSystemPrompt();
  logger.info(`Generating ${targets.length} post(s) from ${plan}`);

  const written = [];
  for (const item of targets) {
    logger.step(`Generating: ${item.slug} (${item.format})`);
    try {
      const result = await generateOne(item, systemPrompt);
      const prefix = item.format === 'carousel' ? 'deck' : 'post';
      const out = join(QUEUE_DIR, `${prefix}-${result.slug}.json`);
      writeFileSync(out, JSON.stringify(result, null, 2));
      const hard = result.constraintProblems.filter(p => !p.startsWith('FLAG:'));
      if (hard.length) {
        logger.warn(`  ${out} — ${hard.length} unresolved problem(s), will stage as Needs Fix`);
        hard.forEach(p => logger.warn(`    - ${p}`));
      } else {
        logger.success(`  ${out}`);
      }
      written.push(out);
    } catch (e) {
      logger.error(`  ${item.slug} failed: ${e.message}`);
    }
  }

  logger.success(`Done — ${written.length}/${targets.length} written to ${QUEUE_DIR}`);
}

main().catch(e => { logger.error(e.message); console.error(e.stack); process.exit(1); });
