/**
 * Stage 1 — angle miner.
 *
 * Reads the research corpus (HIGH/MID brand-fit reels + the latest research
 * report per type) and asks Claude for original content angles in the brand's
 * voice. Each angle becomes a Content Ideas row (Status: Idea) and all angles
 * are saved to queue/angles-<date>.json for the generators.
 *
 * Research tables are READ-ONLY here (repo rule).
 *
 * Usage: node content-engine/mine-angles.js [--limit 5]
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import { listRecords, createRecords } from '../src/airtable/client.js';
import {
  REELS_TABLE, REELS_FIELDS,
  ANALYSES_TABLE, ANALYSES_FIELDS,
  CONTENT_IDEAS_TABLE,
} from '../src/airtable/schema.js';
import { CLAUDE_MODEL } from '../src/config.js';
import { toISODate } from '../src/utils/helpers.js';
import { logger } from '../src/utils/logger.js';
import {
  ensureDirs, QUEUE_DIR, loadGenerationDna, generateJSON,
  extractRawJSON, trimResearch, todayStamp,
} from './shared.js';

const PILLARS = ['Authority', 'Myth-busting', 'How-to', 'Story', 'Contrarian take', 'Proof'];

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag, dflt) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : dflt;
  };
  return { limit: parseInt(get('--limit', '5'), 10) };
}

const OUTLIER_MULTIPLE = 3;   // views ≥ 3x the creator's median = outlier
const OUTLIER_MIN_BASELINE = 4; // need this many reels from a creator to trust a baseline

/**
 * Fetch the analyzed-reel corpus and compute two views of it:
 *  - fitReels:  HIGH/MID brand-fit reels (what resonates AND fits us)
 *  - outliers:  reels that massively overperformed their own creator's
 *               median views. An outlier is the strongest "model this
 *               structure" signal regardless of topic fit — the FORMAT
 *               traveled, even if the content must be ours.
 */
async function fetchReelCorpus() {
  const F = REELS_FIELDS;
  const records = await listRecords(REELS_TABLE, {
    filterFormula: `{${F.aiAnalyzed}} = TRUE()`,
    fields: [F.hook, F.hookType, F.mainTopic, F.keyPoints, F.topics, F.views,
             F.engagementTier, F.username, F.brandFit, F.contentType],
    maxRecords: 500,
  });

  const reels = records.map(r => ({
    creator:     r.fields[F.username],
    topic:       r.fields[F.mainTopic],
    hook:        r.fields[F.hook],
    hookType:    r.fields[F.hookType],
    contentType: r.fields[F.contentType],
    keyPoints:   r.fields[F.keyPoints],
    tier:        r.fields[F.engagementTier],
    brandFit:    r.fields[F.brandFit],
    views:       r.fields[F.views] || 0,
  }));

  // Per-creator median views → outlier multiple.
  const byCreator = {};
  for (const r of reels) {
    if (!r.creator || !r.views) continue;
    (byCreator[r.creator] ||= []).push(r.views);
  }
  const median = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  const baselines = {};
  for (const [creator, views] of Object.entries(byCreator)) {
    if (views.length >= OUTLIER_MIN_BASELINE) baselines[creator] = median(views);
  }

  const outliers = reels
    .filter(r => baselines[r.creator] && r.brandFit !== 'BANNED')
    .map(r => ({ ...r, outlierMultiple: +(r.views / baselines[r.creator]).toFixed(1) }))
    .filter(r => r.outlierMultiple >= OUTLIER_MULTIPLE)
    .sort((a, b) => b.outlierMultiple - a.outlierMultiple)
    .slice(0, 12);

  const fitReels = reels
    .filter(r => r.brandFit === 'HIGH' || r.brandFit === 'MID')
    .slice(0, 40)
    .map(({ views, ...rest }) => rest);

  return { fitReels, outliers };
}

async function fetchResearch() {
  const F = ANALYSES_FIELDS;
  const records = await listRecords(ANALYSES_TABLE, {
    fields: [F.analysisType, F.runAt, F.reportContent],
    maxRecords: 60,
  });
  // Newest report per Analysis Type.
  const newest = {};
  for (const r of records) {
    const type = r.fields[F.analysisType];
    const at   = r.fields[F.runAt] || '';
    if (!type || !r.fields[F.reportContent]) continue;
    if (!newest[type] || at > newest[type].at) {
      newest[type] = { at, content: r.fields[F.reportContent] };
    }
  }
  const research = {};
  for (const [type, { content }] of Object.entries(newest)) {
    const trimmed = trimResearch(type, extractRawJSON(content));
    if (trimmed) research[type] = trimmed;
    else logger.warn(`Research report "${type}" had no usable Raw JSON block — skipped`);
  }
  return research;
}

const ANGLES_PROMPT = (n, corpus, research) => `Using the Brand DNA above and the research corpus below, propose ${n} ORIGINAL content angles the brand should publish on Instagram.

The research shows what works for competitors. Your angles must be the brand's OWN take — inspired by the gaps, hook patterns, and whitespace, never a mirror of a competitor's post.

Research corpus:

### OUTLIER reels (each did ${OUTLIER_MULTIPLE}x+ its own creator's median views — the format traveled)
These are the strongest signals. MODEL THE STRUCTURE — the hook mechanic, the
format, the pacing implied by the key points — but replace the substance with
the brand's own. outlierMultiple = how many times the creator's normal reach it did.
${JSON.stringify(corpus.outliers)}

### High-brand-fit competitor reels (what resonates in our space)
${JSON.stringify(corpus.fitReels)}

### Research findings (latest per mode)
${JSON.stringify(research)}

Return a JSON array of exactly ${n} objects:
- "title": working title, max 10 words
- "pillar": one of ${JSON.stringify(PILLARS)}
- "format": "carousel" or "reel" — carousels for frameworks/lists/data, reels for story/energy angles. Mix both.
- "angle": 2-3 sentences — the specific take and why it fits the brand's Big Idea and ICP pain
- "hookOptions": array of 3 hook lines in the brand voice (each max 15 words)
- "keyPoints": array of 3-5 core points the piece will make
- "chartIdea": null, or (only if a real stat from the Brand DNA credibility section or research numbers supports it) {"kind": "bar"|"line", "labels": [...], "values": [...], "unit": "...", "claim": "one line"}
- "sourceRefs": array of short strings citing which research finding or outlier inspired it (e.g. "outlier 8.2x @handle: confession hook", "gap: pricing transparency")
- "modeledFrom": null, or (when an outlier inspired the structure) {"creator": "...", "hook": "...", "outlierMultiple": N, "whatWasBorrowed": "structure element, not content"}
- "targetAudience": who this speaks to, in ICP terms

Return ONLY the JSON array.`;

async function main() {
  const { limit } = parseArgs();
  ensureDirs();

  const { dna, dnaPrompt } = await loadGenerationDna();
  logger.info(`Mining ${limit} angles for "${dna.brandName}"`);

  const [corpus, research] = await Promise.all([fetchReelCorpus(), fetchResearch()]);
  logger.info(`Corpus: ${corpus.fitReels.length} HIGH/MID-fit reels, ${corpus.outliers.length} outliers (${OUTLIER_MULTIPLE}x+), research modes: ${Object.keys(research).join(', ') || '(none)'}`);
  if (corpus.outliers.length) {
    for (const o of corpus.outliers.slice(0, 5)) {
      logger.info(`  outlier ${o.outlierMultiple}x @${o.creator}: "${(o.hook || o.topic || '').slice(0, 60)}"`);
    }
  }
  if (corpus.fitReels.length === 0 && corpus.outliers.length === 0 && Object.keys(research).length === 0) {
    logger.error('No corpus at all. Run a scrape and at least one research mode first (e.g. node agents/research-agent.js --mode trending).');
    process.exit(1);
  }

  const angles = await generateJSON(dnaPrompt, ANGLES_PROMPT(limit, corpus, research), { maxTokens: 8192 });
  if (!Array.isArray(angles) || angles.length === 0) {
    logger.error('Claude returned no angles');
    process.exit(1);
  }

  // Persist locally for the generators.
  const stamp = todayStamp();
  const queuePath = join(QUEUE_DIR, `angles-${stamp}.json`);
  writeFileSync(queuePath, JSON.stringify({ brand: dna.brandName, minedAt: new Date().toISOString(), angles }, null, 2));

  // One Content Ideas row per angle.
  const rows = angles.map(a => ({
    'Title':           a.title,
    'Platform':        'Instagram',
    'Content Type':    a.format === 'reel' ? 'Story' : 'Educational',
    'Status':          'Idea',
    'Source Platform': 'Instagram',
    'Source Topics':   (a.sourceRefs || []).join(', '),
    'Trend Basis':     a.angle || '',
    'Hook':            (a.hookOptions || [])[0] || '',
    'Key Points':      (a.keyPoints || []).join('\n• '),
    'Target Audience': a.targetAudience || '',
    'Predicted Tier':  'MID',
    'Generated At':    toISODate(),
    'Generated By':    `content-engine mine-angles ${CLAUDE_MODEL}`,
    'Notes':           `format: ${a.format}\npillar: ${a.pillar}\nhooks:\n- ${(a.hookOptions || []).join('\n- ')}${a.chartIdea ? `\nchart: ${JSON.stringify(a.chartIdea)}` : ''}${a.modeledFrom ? `\nmodeled from: ${a.modeledFrom.outlierMultiple}x @${a.modeledFrom.creator} (${a.modeledFrom.whatWasBorrowed})` : ''}`,
  }));
  const created = await createRecords(CONTENT_IDEAS_TABLE, rows);
  angles.forEach((a, i) => { a.ideaRecordId = created[i]?.id; });
  writeFileSync(queuePath, JSON.stringify({ brand: dna.brandName, minedAt: new Date().toISOString(), angles }, null, 2));

  logger.success(`${angles.length} angles → Content Ideas (Status: Idea) + ${queuePath}`);
  for (const a of angles) {
    logger.info(`  [${a.format}] ${a.title} (${a.pillar}) — ${a.ideaRecordId}`);
  }
}

main().catch(e => { logger.error(e.message); process.exit(1); });
