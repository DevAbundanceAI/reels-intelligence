#!/usr/bin/env node
/**
 * research-agent.js — Interactive research entry point
 *
 * Usage:
 *   node agents/research-agent.js --mode gap        --creator alexhormozi
 *   node agents/research-agent.js --mode trending   --days 14
 *   node agents/research-agent.js --mode hooks      --creator alexhormozi
 *   node agents/research-agent.js --mode compare    --creator alexhormozi --vs garyvee
 *   node agents/research-agent.js --mode deep       --creator alexhormozi --icp "coaches and consultants"
 *   node agents/research-agent.js --mode aggregate  --days 30
 *   node agents/research-agent.js --mode all        --creator alexhormozi
 *
 * Every run saves the report to the Analyses table in Airtable automatically.
 */

import { logger }                from '../src/utils/logger.js';
import { DEBUG, CLAUDE_MODEL }   from '../src/config.js';
import { runGapAnalysis }        from '../src/research/content-gap.js';
import { runTrendingAnalysis }   from '../src/research/trending.js';
import { runHookAnalysis }       from '../src/research/hook-patterns.js';
import { runCompare }            from '../src/research/competitor-compare.js';
import { runAggregateAnalysis }  from '../src/research/aggregate-analysis.js';
import { analyzeCreatorDeep }    from '../src/analyzers/claude.js';
import { listRecords, createRecords } from '../src/airtable/client.js';
import {
  REELS_TABLE, REELS_FIELDS,
  CREATORS_TABLE, CREATORS_FIELDS,
  ANALYSES_TABLE, ANALYSES_FIELDS,
} from '../src/airtable/schema.js';

// --- Parse CLI args ---
const args    = process.argv.slice(2);
const get     = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const mode    = get('--mode')    || 'gap';
const creator = get('--creator') || null;
const vs      = get('--vs')      || null;
const days    = parseInt(get('--days') || '30');
const icp     = get('--icp')     || '';

// --- Validation ---
const needsCreator = ['gap', 'hooks', 'compare', 'deep', 'all'];
if (needsCreator.includes(mode) && !creator) {
  logger.error(`Mode "${mode}" requires --creator flag`);
  logger.error('Example: node agents/research-agent.js --mode gap --creator alexhormozi');
  process.exit(1);
}
if (mode === 'compare' && !vs) {
  logger.error('Mode "compare" requires --vs flag');
  logger.error('Example: node agents/research-agent.js --mode compare --creator alexhormozi --vs garyvee');
  process.exit(1);
}

logger.info(`Research Agent starting — mode: ${mode}${creator ? ` | creator: @${creator}` : ''}${vs ? ` vs @${vs}` : ''}${mode === 'trending' || mode === 'aggregate' ? ` | days: ${days}` : ''}`);

// ─────────────────────────────────────────────────────────────
// Airtable: save analysis run to Analyses table
// ─────────────────────────────────────────────────────────────

/**
 * Look up a creator record ID from the Creators table by username.
 * Returns null for aggregate runs where creator is undefined.
 */
async function lookupCreatorId(username) {
  if (!username) return null;
  try {
    const records = await listRecords(CREATORS_TABLE, {
      filterFormula: `{${CREATORS_FIELDS.username}} = "${username}"`,
      maxRecords: 1,
      fields: [CREATORS_FIELDS.username],
    });
    return records.length ? records[0].id : null;
  } catch {
    return null;
  }
}

/**
 * Save a completed analysis run to the Airtable Analyses table.
 * Best-effort: logs a warning on failure but never throws.
 */
async function saveAnalysisToAirtable({ type, creatorName, reportContent, reelCount = 0, icpValue = '' }) {
  try {
    const creatorId = await lookupCreatorId(creatorName);

    const fields = {
      [ANALYSES_FIELDS.creatorName]:   creatorName || 'All Creators',
      [ANALYSES_FIELDS.analysisType]:  type,
      [ANALYSES_FIELDS.runAt]:         new Date().toISOString().slice(0, 10),
      [ANALYSES_FIELDS.completed]:     true,
      [ANALYSES_FIELDS.reelsAnalyzed]: reelCount,
      [ANALYSES_FIELDS.reportContent]: (reportContent || '').slice(0, 100000),
      [ANALYSES_FIELDS.modelUsed]:     CLAUDE_MODEL,
    };

    if (icpValue) fields[ANALYSES_FIELDS.icp] = icpValue;

    // Analyses table links to Creators via a linked record field (if creator exists)
    // The MCP setup creates this as a link field — we store the record ID array
    if (creatorId) {
      fields[ANALYSES_FIELDS.creator] = [creatorId];
    }

    await createRecords(ANALYSES_TABLE, [fields]);
    logger.success(`Saved to Analyses table: ${type}${creatorName ? ` — @${creatorName}` : ' — All Creators'}`);
  } catch (e) {
    logger.warn(`Could not save to Analyses table: ${e.message}`);
    logger.warn('(This is non-critical — your report file was still saved successfully)');
  }
}

// ─────────────────────────────────────────────────────────────
// Run research modes
// ─────────────────────────────────────────────────────────────

const results = {};

try {
  // ── Gap Analysis ────────────────────────────────────────────
  if (mode === 'gap' || mode === 'all') {
    logger.info('\n── Running Content Gap Analysis...');
    results.gap = await runGapAnalysis(creator, { days });
    logger.success(`Gap report: ${results.gap.filePath}`);
    await saveAnalysisToAirtable({
      type:          'Gap',
      creatorName:   creator,
      reportContent: results.gap.report,
      reelCount:     results.gap.result?.hardGaps?.length ?? 0,
    });
  }

  // ── Trending Analysis ───────────────────────────────────────
  if (mode === 'trending' || mode === 'all') {
    logger.info('\n── Running Trending Topics Analysis...');
    results.trending = await runTrendingAnalysis({ days });
    logger.success(`Trending report: ${results.trending.filePath}`);
    await saveAnalysisToAirtable({
      type:          'Trending',
      creatorName:   null,
      reportContent: results.trending.report,
    });
  }

  // ── Hook Pattern Analysis ───────────────────────────────────
  if (mode === 'hooks' || mode === 'all') {
    logger.info('\n── Running Hook Pattern Analysis...');
    results.hooks = await runHookAnalysis(creator);
    logger.success(`Hooks report: ${results.hooks.filePath}`);
    await saveAnalysisToAirtable({
      type:          'Hooks',
      creatorName:   creator,
      reportContent: results.hooks.report,
    });
  }

  // ── Competitor Comparison ───────────────────────────────────
  if (mode === 'compare') {
    logger.info(`\n── Running Competitor Comparison: @${creator} vs @${vs}...`);
    results.compare = await runCompare(creator, vs);
    logger.success(`Compare report: ${results.compare.filePath}`);
    await saveAnalysisToAirtable({
      type:          'Compare',
      creatorName:   creator,
      reportContent: results.compare.report,
      icpValue:      vs ? `vs @${vs}` : '',
    });
  }

  // ── Aggregate Analysis ──────────────────────────────────────
  if (mode === 'aggregate') {
    logger.info(`\n── Running Aggregate Analysis across all creators (last ${days} days)...`);
    results.aggregate = await runAggregateAnalysis({ days });
    logger.success(`Aggregate report: ${results.aggregate.filePath}`);
    await saveAnalysisToAirtable({
      type:          'Aggregate',
      creatorName:   null,
      reportContent: results.aggregate.report,
      reelCount:     results.aggregate.reelCount,
    });
  }

  // ── Poppy Deep Analysis ─────────────────────────────────────
  if (mode === 'deep' || mode === 'all') {
    logger.info(`\n── Running Poppy Deep Analysis for @${creator}...`);

    // Fetch analyzed reels from Airtable for this creator
    const records = await listRecords(REELS_TABLE, {
      filterFormula: `AND(
        {${REELS_FIELDS.username}} = "${creator}",
        {${REELS_FIELDS.aiAnalyzed}} = TRUE()
      )`,
      fields: Object.values(REELS_FIELDS),
    });

    if (records.length < 10) {
      logger.warn(`Only ${records.length} reels found for @${creator}. Deep analysis works best with 20+.`);
    }

    // Map Airtable records back to the reel shape analyzeCreatorDeep expects
    const reels = records.map(r => ({
      reelId:          r.fields[REELS_FIELDS.reelId],
      username:        r.fields[REELS_FIELDS.username],
      caption:         r.fields[REELS_FIELDS.caption]    || '',
      transcript:      r.fields[REELS_FIELDS.transcript]  || '',
      engagementScore: r.fields[REELS_FIELDS.engagementScore] || 0,
      engagementTier:  r.fields[REELS_FIELDS.engagementTier]  || 'LOW',
      views:           r.fields[REELS_FIELDS.views]       || 0,
      likes:           r.fields[REELS_FIELDS.likes]       || 0,
      comments:        r.fields[REELS_FIELDS.comments]    || 0,
    }));

    const deepResult = await analyzeCreatorDeep(reels, creator, icp);

    // Save deep report
    const { writeFileSync, mkdirSync, existsSync } = await import('fs');
    const { join } = await import('path');

    const reportsDir = join(process.cwd(), 'reports');
    mkdirSync(reportsDir, { recursive: true });

    const date     = new Date().toISOString().slice(0, 10);
    let   fileName = `deep-${creator}-${date}.md`;
    let   filePath = join(reportsDir, fileName);
    let   version  = 2;
    while (existsSync(filePath)) {
      fileName = `deep-${creator}-${date}-v${version}.md`;
      filePath = join(reportsDir, fileName);
      version++;
    }

    const reportLines = [
      `# Poppy Deep Analysis — @${creator}`,
      `Generated: ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`,
      `Reels analyzed: ${reels.length}${icp ? ` | ICP: ${icp}` : ''}`,
      '',
      '---',
      '',
      '## Hook Analysis',
      '```json',
      JSON.stringify(deepResult.hookAnalysis?.patterns || {}, null, 2),
      '```',
      '',
      '## Title/Caption Analysis',
      '```json',
      JSON.stringify(deepResult.titleAnalysis?.patterns || {}, null, 2),
      '```',
      '',
      '## Structure Analysis',
      '```json',
      JSON.stringify(deepResult.structureAnalysis?.patterns || {}, null, 2),
      '```',
      '',
      '## Engagement Correlation',
      '```json',
      JSON.stringify(deepResult.correlationAnalysis || {}, null, 2),
      '```',
      '',
      '## Synthesis',
      '```json',
      JSON.stringify(deepResult.synthesis || {}, null, 2),
      '```',
      '',
      '---',
      '',
      '### Replicable Templates',
      '',
      ...(deepResult.synthesis?.replicableTemplates || []).map((t, i) => `${i + 1}. ${t}`),
      '',
      '### Content Formula',
      '',
      deepResult.synthesis?.contentFormula || '',
      '',
      '### Unique Philosophy',
      '',
      deepResult.synthesis?.uniquePhilosophy || '',
      '',
      '### Red Flags — Do NOT Copy',
      '',
      ...(deepResult.synthesis?.redFlags || []).map(f => `- ${f}`),
      '',
      `*Reels Intelligence Framework — deep-${creator}-${date}.md*`,
    ];

    const deepReportContent = reportLines.join('\n');
    writeFileSync(filePath, deepReportContent, 'utf8');
    results.deep = { filePath };
    logger.success(`Deep report: ${filePath}`);

    await saveAnalysisToAirtable({
      type:          'Deep',
      creatorName:   creator,
      reportContent: deepReportContent,
      reelCount:     reels.length,
      icpValue:      icp,
    });
  }

  // ── Summary ─────────────────────────────────────────────────
  logger.info('\n─────────── RESEARCH COMPLETE ───────────');
  Object.entries(results).forEach(([key, val]) => {
    if (val?.filePath) logger.success(`${key.padEnd(12)} → ${val.filePath}`);
  });

} catch (e) {
  logger.error(`Research agent failed: ${e.message}`);
  if (DEBUG) console.error(e);
  process.exit(1);
}
