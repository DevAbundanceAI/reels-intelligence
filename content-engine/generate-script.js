/**
 * Stage 2b — short-form video script generator.
 *
 * Takes one mined angle (format: reel) and writes a teleprompter script plus
 * a per-beat shot list. Two CTA tails (link tail to use now, keyword tail
 * archived for a future DM funnel) — the proven EH 16-script pattern.
 *
 * Usage:
 *   node content-engine/generate-script.js --angles queue/angles-<date>.json --index 2
 *   node content-engine/generate-script.js --latest
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { logger } from '../src/utils/logger.js';
import {
  ensureDirs, QUEUE_DIR, SCRIPTS_DIR, loadGenerationDna, generateText,
  slugify, todayStamp,
} from './shared.js';

const SCRIPT_PROMPT = (angle) => `Write a short-form video script (30-45 seconds spoken) for the angle below, in the brand voice from the Brand DNA above. The founder films this to camera.

Angle:
${JSON.stringify(angle, null, 2)}

Return clean markdown in EXACTLY this structure:

# <Title>

**Angle:** <one line>  |  **Pillar:** <pillar>  |  **Length target:** <seconds>s

## Teleprompter

### Hook (0-3s)
<1-2 spoken lines. Must stop the scroll. No throat-clearing.>

### Body
<Numbered beats. Each beat = 1-3 spoken sentences. 3-5 beats total. Conversational, founder energy, no jargon.>

### CTA tail A — LINK (use now)
<Spoken close pointing to the link in bio / comments. 1-2 lines.>

### CTA tail B — KEYWORD (archive for DM funnel phase)
<Same energy, but "comment WORD and I'll send it to you". 1-2 lines.>

## Shot list

| Beat | Spoken line (short ref) | Visual | On-screen text | B-roll suggestion |
|---|---|---|---|---|
<one row per beat including hook and CTA — Visual = framing/action for the founder shot; On-screen text = max 6 words; B-roll = a realistic cutaway that exists or is easily filmed>

## Caption
<2-3 short paragraphs, brand voice, no URLs, ends with a comment prompt>

**Hashtags:** <8-12>

Rules: film the body ONCE, then both tails back to back (do not reshoot). No em dashes or en dashes anywhere - normal hyphens only. Never invent statistics.`;

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

async function main() {
  const { anglesFile, index, latest } = parseArgs();
  ensureDirs();

  const file = anglesFile || newestAnglesFile();
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const { angles } = parsed;

  let angle;
  if (latest || index === null) {
    angle = angles.find(a => a.format === 'reel' && !a.scriptFile);
    if (!angle) throw new Error(`No pending reel angle in ${file}`);
  } else {
    angle = angles[index];
    if (!angle) throw new Error(`No angle at index ${index} in ${file}`);
  }

  const { dnaPrompt } = await loadGenerationDna();
  logger.info(`Generating script: "${angle.title}"`);
  let script = await generateText(dnaPrompt, SCRIPT_PROMPT(angle), { maxTokens: 4096 });

  if (/[—–]/.test(script)) {
    logger.warn('Script contained em/en dashes — normalizing to hyphens (brand rule)');
    script = script.replace(/\s*[—–]\s*/g, ' - ');
  }

  const slug = slugify(angle.title);
  const out = join(SCRIPTS_DIR, `${todayStamp()}-${slug}.md`);
  writeFileSync(out, script);

  angle.scriptFile = out;
  writeFileSync(file, JSON.stringify(parsed, null, 2));

  logger.success(`Script written: ${out}`);
  console.log(out);
}

main().catch(e => { logger.error(e.message); process.exit(1); });
