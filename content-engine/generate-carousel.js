/**
 * Stage 2a — carousel deck generator.
 *
 * Takes one mined angle (format: carousel) and has Claude write the deck as
 * structured copy: max 5 slides, caption with NO inline links, hashtags, and
 * a first-comment link. Claude never designs pixels — slide types + copy
 * only; layout belongs to render_slides.py.
 *
 * Usage:
 *   node content-engine/generate-carousel.js --angles queue/angles-<date>.json --index 0
 *   node content-engine/generate-carousel.js --latest        (first pending carousel angle in newest queue file)
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { logger } from '../src/utils/logger.js';
import {
  ensureDirs, QUEUE_DIR, loadGenerationDna, generateJSON, slugify, todayStamp,
} from './shared.js';

export const SLIDE_TYPES = ['hook', 'point', 'list', 'quote', 'chart', 'cta'];

const DECK_PROMPT = (angle) => `Write an Instagram carousel for the angle below, in the brand voice from the Brand DNA above.

Angle:
${JSON.stringify(angle, null, 2)}

Hard constraints:
- MAXIMUM 5 slides. Slide 1 must be type "hook". Last slide must be type "cta".
- Headlines: max 12 words. Body text: max 40 words per slide. Punchy beats complete.
- "emphasis": one word or short phrase COPIED EXACTLY from that slide's headline — it gets the brand's red gradient treatment. Pick the word that carries the tension.
- Caption: 2-4 short paragraphs, brand voice, NO links or URLs anywhere in it (links kill carousel reach). End with a comment prompt.
- "first_comment_link": the URL the first comment will carry (from the brand's Offer Ladder), or null if none fits.
- Include a "chart" slide ONLY if the angle's chartIdea is non-null — copy its data exactly, never invent numbers.

Return a JSON object:
{
  "title": "...",
  "slides": [
    {"type": "hook",  "eyebrow": "2-4 WORD LABEL", "headline": "...", "emphasis": "...", "sub": "one supporting line or null"},
    {"type": "point", "number": 1, "headline": "...", "emphasis": "...", "body": "..."},
    {"type": "list",  "eyebrow": "...", "headline": "...", "emphasis": "...", "items": ["...", "..."]},
    {"type": "quote", "quote": "...", "attribution": "..."},
    {"type": "chart", "eyebrow": "...", "headline": "...", "emphasis": "...", "chart": {"kind": "bar", "labels": [], "values": [], "unit": ""}, "insight": "one line under the chart"},
    {"type": "cta",   "headline": "...", "emphasis": "...", "body": "what to do next (no URL — say 'link in comments' if there is one)"}
  ],
  "caption": "...",
  "hashtags": "#... #... (8-12, niche over generic)",
  "first_comment_link": "https://... or null"
}
Use only the slide types you need — the example shows the available shapes, not a required order.
Return ONLY the JSON object.`;

function newestAnglesFile() {
  const files = readdirSync(QUEUE_DIR).filter(f => f.startsWith('angles-')).sort();
  if (!files.length) throw new Error('No angles files in queue/. Run mine-angles.js first.');
  return join(QUEUE_DIR, files[files.length - 1]);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  return {
    anglesFile: get('--angles'),
    index:      get('--index') !== null ? parseInt(get('--index'), 10) : null,
    latest:     args.includes('--latest'),
  };
}

export function validateDeck(deck) {
  const problems = [];
  if (!Array.isArray(deck.slides) || deck.slides.length === 0) problems.push('no slides');
  if (deck.slides?.length > 5) problems.push(`${deck.slides.length} slides (max 5 — VistaSocial rail cap)`);
  if (deck.slides?.[0]?.type !== 'hook') problems.push('slide 1 is not a hook');
  if (deck.slides?.length && deck.slides[deck.slides.length - 1].type !== 'cta') problems.push('last slide is not a cta');
  for (const [i, s] of (deck.slides || []).entries()) {
    if (!SLIDE_TYPES.includes(s.type)) problems.push(`slide ${i + 1}: unknown type "${s.type}"`);
    if (s.emphasis && s.headline && !s.headline.includes(s.emphasis)) {
      problems.push(`slide ${i + 1}: emphasis "${s.emphasis}" not found in headline`);
    }
  }
  if (/https?:\/\//i.test(deck.caption || '')) problems.push('caption contains a URL (kills carousel reach — move to first comment)');
  if (/[—–]/.test(JSON.stringify(deck))) problems.push('output contains em/en dashes (brand rule: normal hyphens only)');
  return problems;
}

async function main() {
  const { anglesFile, index, latest } = parseArgs();
  ensureDirs();

  const file = anglesFile || newestAnglesFile();
  const { angles } = JSON.parse(readFileSync(file, 'utf8'));

  let angle;
  if (latest || index === null) {
    angle = angles.find(a => a.format === 'carousel' && !a.deckFile);
    if (!angle) throw new Error(`No pending carousel angle in ${file}`);
  } else {
    angle = angles[index];
    if (!angle) throw new Error(`No angle at index ${index} in ${file}`);
  }

  const { dnaPrompt } = await loadGenerationDna();
  logger.info(`Generating deck: "${angle.title}"`);
  const deck = await generateJSON(dnaPrompt, DECK_PROMPT(angle), { maxTokens: 4096 });

  const problems = validateDeck(deck);
  if (problems.length) {
    logger.warn(`Deck violates constraints — fix before rendering:`);
    problems.forEach(p => logger.warn(`  - ${p}`));
  }

  deck.slug = slugify(deck.title || angle.title);
  deck.ideaRecordId = angle.ideaRecordId || null;
  deck.generatedAt = new Date().toISOString();
  deck.constraintProblems = problems;

  const out = join(QUEUE_DIR, `deck-${deck.slug}.json`);
  writeFileSync(out, JSON.stringify(deck, null, 2));

  // Mark the angle consumed so --latest moves on next run.
  angle.deckFile = out;
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), angles }, null, 2));

  logger.success(`Deck written: ${out} (${deck.slides.length} slides${problems.length ? `, ${problems.length} constraint problem(s)` : ''})`);
  console.log(out);
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) main().catch(e => { logger.error(e.message); process.exit(1); });
