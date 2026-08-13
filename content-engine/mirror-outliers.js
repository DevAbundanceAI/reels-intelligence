/**
 * Strict-mirror outlier reels.
 *
 * Finds the reels that massively overperformed their own creator's median
 * views, and for each one writes a MIRROR script: the structure copied
 * exactly (hook formula, beat sequence, pacing, CTA pattern), substance
 * swapped to the brand only where the original topic is not ours. Every
 * mirror lands in Content Ideas + Content Calendar (In Production) for
 * human review — clearly labeled MIRROR with the source URL.
 *
 * Free to run: uses only already-scraped reels in Airtable. No Apify.
 *
 * Usage: node content-engine/mirror-outliers.js [--top 5] [--min-multiple 3]
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import { listRecords, createRecords } from '../src/airtable/client.js';
import { REELS_TABLE, REELS_FIELDS, CONTENT_IDEAS_TABLE, CONTENT_CALENDAR_TABLE } from '../src/airtable/schema.js';
import { CLAUDE_MODEL } from '../src/config.js';
import { toISODate } from '../src/utils/helpers.js';
import { logger } from '../src/utils/logger.js';
import {
  ensureDirs, SCRIPTS_DIR, loadGenerationDna, generateText, slugify, todayStamp,
} from './shared.js';

const MIN_BASELINE = 4;

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : dflt; };
  return {
    top: parseInt(get('--top', '5'), 10),
    minMultiple: parseFloat(get('--min-multiple', '3')),
  };
}

async function findOutliers(minMultiple) {
  const F = REELS_FIELDS;
  const records = await listRecords(REELS_TABLE, {
    filterFormula: `{${F.aiAnalyzed}} = TRUE()`,
    fields: [F.username, F.url, F.views, F.hook, F.hookType, F.hookCategory,
             F.transcript, F.caption, F.mainTopic, F.keyPoints, F.contentType,
             F.ctaType, F.ctaPlacement, F.duration, F.emotionalTone, F.brandFit],
  });
  const reels = records.map(r => ({
    creator:    r.fields[F.username],
    url:        r.fields[F.url],
    views:      r.fields[F.views] || 0,
    hook:       r.fields[F.hook] || '',
    hookType:   r.fields[F.hookType],
    hookCategory: r.fields[F.hookCategory],
    transcript: r.fields[F.transcript] || '',
    caption:    r.fields[F.caption] || '',
    topic:      r.fields[F.mainTopic],
    keyPoints:  r.fields[F.keyPoints],
    contentType:r.fields[F.contentType],
    ctaType:    r.fields[F.ctaType],
    ctaPlacement: r.fields[F.ctaPlacement],
    duration:   r.fields[F.duration],
    tone:       r.fields[F.emotionalTone],
    brandFit:   r.fields[F.brandFit],
  }));

  const byCreator = {};
  for (const r of reels) if (r.creator && r.views) (byCreator[r.creator] ||= []).push(r.views);
  const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const base = {};
  for (const [c, v] of Object.entries(byCreator)) if (v.length >= MIN_BASELINE) base[c] = median(v);

  return reels
    .filter(r => base[r.creator] && r.brandFit !== 'BANNED')
    .map(r => ({ ...r, multiple: +(r.views / base[r.creator]).toFixed(1) }))
    .filter(r => r.multiple >= minMultiple)
    // A mirror needs source material: require a real transcript or at least a
    // substantial hook+keyPoints. Meme reposts with emoji captions can't be mirrored.
    .filter(r => r.transcript.length > 200 || (r.hook.length > 15 && (r.keyPoints || '').length > 40))
    .sort((a, b) => b.multiple - a.multiple);
}

const MIRROR_PROMPT = (reel) => `Below is a competitor reel that did ${reel.multiple}x its creator's normal views. Write a MIRROR of it for the brand: copy the structure EXACTLY, change only what must change.

Source reel (@${reel.creator}, ${reel.views.toLocaleString()} views, ${reel.multiple}x outlier):
- Hook: ${reel.hook}
- Hook type: ${reel.hookType} / ${reel.hookCategory}
- Topic: ${reel.topic}
- Key points: ${reel.keyPoints}
- CTA: ${reel.ctaType} (${reel.ctaPlacement})
- Tone: ${reel.tone} | Duration: ${reel.duration || '?'}s
- Transcript:
${reel.transcript.slice(0, 2500) || '(no transcript — mirror from hook, caption, and key points)'}
- Caption: ${reel.caption.slice(0, 400)}

MIRROR RULES — this is a strict mirror, not an adaptation:
1. Keep the hook FORMULA word-for-word where possible; swap only the subject noun/phrase if the original subject is not the brand's.
2. Keep the exact beat sequence, pacing, sentence rhythm, and where the CTA lands.
3. Keep the same emotional register and the same number of beats.
4. Swap substance to the brand's world ONLY where the original substance does not apply. If the topic already fits the brand, keep it nearly verbatim.
5. Still obey Forbidden Topics and never invent statistics; if the original cites a number we cannot claim, replace it with a Brand DNA credibility stat or make the claim numberless.

Return clean markdown:

# MIRROR: <title>

**Source:** @${reel.creator} — ${reel.multiple}x outlier — ${reel.url}
**What is copied:** <one line: the exact structural elements kept>
**What is swapped:** <one line>

## Teleprompter
<the mirrored script, beat by beat, matching the source's structure — mark each beat [0-3s], [3-10s] etc. to mirror the source pacing>

## Shot list
| Beat | Spoken line (ref) | Visual | On-screen text |
|---|---|---|---|
<rows>

## Caption
<mirrored caption in brand voice, no URLs>

No em dashes or en dashes anywhere - normal hyphens only.`;

async function main() {
  const { top, minMultiple } = parseArgs();
  ensureDirs();

  const outliers = await findOutliers(minMultiple);
  logger.info(`${outliers.length} mirrorable outliers (≥${minMultiple}x with usable source material)`);
  if (!outliers.length) { logger.error('Nothing to mirror.'); process.exit(1); }

  const { dnaPrompt } = await loadGenerationDna();
  const picked = outliers.slice(0, top);

  for (const reel of picked) {
    logger.step(`Mirroring ${reel.multiple}x @${reel.creator}: "${(reel.hook || reel.topic || '').slice(0, 60)}"`);
    let script = await generateText(dnaPrompt, MIRROR_PROMPT(reel), { maxTokens: 4096 });
    if (/[—–]/.test(script)) script = script.replace(/\s*[—–]\s*/g, ' - ');

    const slug = slugify(`mirror-${reel.creator}-${reel.topic || reel.hook}`);
    const file = join(SCRIPTS_DIR, `${todayStamp()}-${slug}.md`);
    writeFileSync(file, script);

    const [idea] = await createRecords(CONTENT_IDEAS_TABLE, [{
      'Title':           `MIRROR ${reel.multiple}x: ${reel.topic || reel.hook.slice(0, 40)}`,
      'Platform':        'Instagram',
      'Content Type':    reel.contentType || 'Story',
      'Status':          'Idea',
      'Source Platform': 'Instagram',
      'Source Creators': `@${reel.creator}`,
      'Source Topics':   reel.topic || '',
      'Trend Basis':     `${reel.multiple}x the creator's median views (${reel.views.toLocaleString()} views)`,
      'Hook':            reel.hook.slice(0, 250),
      'Hook Type':       reel.hookType || 'Other',
      'Key Points':      reel.keyPoints || '',
      'CTA':             reel.ctaType || '',
      'Predicted Tier':  'HIGH',
      'Generated At':    toISODate(),
      'Generated By':    `content-engine mirror-outliers ${CLAUDE_MODEL}`,
      'Notes':           `STRICT MIRROR of ${reel.url}\nScript: ${file}`,
    }]);

    await createRecords(CONTENT_CALENDAR_TABLE, [{
      'Idea Title':   `MIRROR ${reel.multiple}x @${reel.creator}`,
      'Idea':         [idea.id],
      'Platform':     'Instagram',
      'Content Type': reel.contentType || 'Story',
      'Status':       'In Production',
      'Brief':        `STRICT MIRROR of a ${reel.multiple}x outlier by @${reel.creator}\nSource: ${reel.url}\n\n${script}`,
      'Hook':         reel.hook.slice(0, 250),
      'CTA':          reel.ctaType || '',
      'Created At':   toISODate(),
      'Notes':        `content-engine mirror — review against source before filming`,
    }]);
    logger.success(`  staged: ${file}`);
  }

  logger.success(`${picked.length} mirrors staged in Content Calendar (In Production) for review.`);
}

main().catch(e => { logger.error(e.message); process.exit(1); });
