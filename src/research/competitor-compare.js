import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_API_KEY, CLAUDE_MODEL } from '../config.js';
import { listRecords } from '../airtable/client.js';
import { REELS_TABLE, REELS_FIELDS } from '../airtable/schema.js';
import { logger } from '../utils/logger.js';
import { frameworkSystemSuffix } from '../utils/frameworks.js';

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const MODEL  = CLAUDE_MODEL;

const SYSTEM = `You are a competitive intelligence analyst for content creators.
You compare creators across engagement, content strategy, and topic positioning.
Return valid JSON only — no markdown, no explanation.${frameworkSystemSuffix()}`;

async function fetchCreatorSummary(username) {
  const records = await listRecords(REELS_TABLE, {
    filterFormula: `AND(
      {${REELS_FIELDS.username}} = "${username}",
      {${REELS_FIELDS.aiAnalyzed}} = TRUE()
    )`,
    fields: [
      REELS_FIELDS.mainTopic,
      REELS_FIELDS.topics,
      REELS_FIELDS.contentType,
      REELS_FIELDS.hookType,
      REELS_FIELDS.hookCategory,
      REELS_FIELDS.emotionalTone,
      REELS_FIELDS.engagementScore,
      REELS_FIELDS.engagementTier,
      REELS_FIELDS.views,
      REELS_FIELDS.likes,
      REELS_FIELDS.comments,
      REELS_FIELDS.ctaType,
    ],
  });

  if (!records.length) return null;

  const reels = records.map(r => r.fields);

  // Compute summary stats locally
  const scores  = reels.map(r => r[REELS_FIELDS.engagementScore] || 0);
  const views   = reels.map(r => r[REELS_FIELDS.views]           || 0);
  const tiers   = reels.map(r => r[REELS_FIELDS.engagementTier]);
  const high    = tiers.filter(t => t === 'HIGH').length;
  const mid     = tiers.filter(t => t === 'MID').length;
  const low     = tiers.filter(t => t === 'LOW').length;

  const avg = arr => arr.reduce((s, n) => s + n, 0) / arr.length;
  const topN = (arr, n) => {
    const freq = {};
    arr.filter(Boolean).forEach(v => { freq[v] = (freq[v] || 0) + 1; });
    return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, c]) => ({ value: k, count: c }));
  };

  const allTopics = reels.flatMap(r => {
    const t = r[REELS_FIELDS.topics] || '';
    return [r[REELS_FIELDS.mainTopic], ...t.split(',').map(s => s.trim())].filter(Boolean);
  });

  return {
    username,
    reelCount:           reels.length,
    avgEngagementScore:  parseFloat(avg(scores).toFixed(3)),
    avgViews:            Math.round(avg(views)),
    tierBreakdown: {
      high, mid, low,
      highPct: parseFloat((high / reels.length * 100).toFixed(1)),
      midPct:  parseFloat((mid  / reels.length * 100).toFixed(1)),
      lowPct:  parseFloat((low  / reels.length * 100).toFixed(1)),
    },
    topTopics:           topN(allTopics, 8),
    contentTypeMix:      topN(reels.map(r => r[REELS_FIELDS.contentType]), 5),
    topHookTypes:        topN(reels.map(r => r[REELS_FIELDS.hookType]), 5),
    topHookCategories:   topN(reels.map(r => r[REELS_FIELDS.hookCategory]), 4),
    topEmotionalTones:   topN(reels.map(r => r[REELS_FIELDS.emotionalTone]), 4),
    topCtaTypes:         topN(reels.map(r => r[REELS_FIELDS.ctaType]), 3),
  };
}

async function runComparePrompt(summaryA, summaryB) {
  const prompt = `Compare two Instagram creators head-to-head.

Creator A: @${summaryA.username}
${JSON.stringify(summaryA, null, 2)}

Creator B: @${summaryB.username}
${JSON.stringify(summaryB, null, 2)}

Provide:
1. "engagementWinner": who has stronger overall engagement and the key reason why (2 sentences)
2. "topicOverlap": topics both creators cover — where they compete directly (array of strings)
3. "creatorAEdge": specific areas where Creator A outperforms — topics, formats, or strategies (array of { area, detail })
4. "creatorBEdge": same for Creator B (array of { area, detail })
5. "contentStrategyDiff": how their overall content strategies differ in approach (3 sentences)
6. "audiencePositioning": how their audiences likely differ based on topic/tone data (2 sentences)
7. "recommendationsForA": 4 specific, actionable recommendations for Creator A based on this comparison.
   Each must be concrete — not generic. (array of { rec, rationale, specificExample })
8. "stealFromB": the single most impactful thing Creator A could directly adopt from Creator B's strategy

Return JSON with those 8 keys.`;

  const msg = await client.messages.create({
    model: MODEL, max_tokens: 3000, system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = msg.content.map(c => c.text || '').join('');
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

function formatReport(summaryA, summaryB, result) {
  const { engagementWinner, topicOverlap, creatorAEdge, creatorBEdge, contentStrategyDiff, audiencePositioning, recommendationsForA, stealFromB } = result;
  const date = new Date().toISOString().slice(0, 10);

  const row = (label, a, b) => `| ${label} | ${a} | ${b} |`;

  const lines = [
    `# Competitor Comparison — @${summaryA.username} vs @${summaryB.username}`,
    `Generated: ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`,
    `Data: @${summaryA.username} ${summaryA.reelCount} reels | @${summaryB.username} ${summaryB.reelCount} reels`,
    '',
    '---',
    '',
    '## Head-to-Head Stats',
    '',
    `| Metric | @${summaryA.username} | @${summaryB.username} |`,
    '|--------|--------|--------|',
    row('Reels analyzed',        summaryA.reelCount,                           summaryB.reelCount),
    row('Avg engagement score',  `${summaryA.avgEngagementScore}%`,            `${summaryB.avgEngagementScore}%`),
    row('Avg views',             summaryA.avgViews.toLocaleString(),            summaryB.avgViews.toLocaleString()),
    row('HIGH tier %',           `${summaryA.tierBreakdown.highPct}%`,          `${summaryB.tierBreakdown.highPct}%`),
    row('MID tier %',            `${summaryA.tierBreakdown.midPct}%`,           `${summaryB.tierBreakdown.midPct}%`),
    row('LOW tier %',            `${summaryA.tierBreakdown.lowPct}%`,           `${summaryB.tierBreakdown.lowPct}%`),
    row('Top content type',      summaryA.contentTypeMix[0]?.value || '—',      summaryB.contentTypeMix[0]?.value || '—'),
    row('Top hook type',         summaryA.topHookTypes[0]?.value   || '—',      summaryB.topHookTypes[0]?.value   || '—'),
    '',
    '---',
    '',
    '## Engagement Winner',
    '',
    engagementWinner,
    '',
    '---',
    '',
    `## @${summaryA.username}'s Edge`,
    '',
    ...creatorAEdge.map(e => `- **${e.area}**: ${e.detail}`),
    '',
    '---',
    '',
    `## @${summaryB.username}'s Edge`,
    '',
    ...creatorBEdge.map(e => `- **${e.area}**: ${e.detail}`),
    '',
    '---',
    '',
    '## Topic Overlap — Where You Compete Directly',
    '',
    ...topicOverlap.map(t => `- ${t}`),
    '',
    '---',
    '',
    '## Content Strategy Difference',
    '',
    contentStrategyDiff,
    '',
    '## Audience Positioning',
    '',
    audiencePositioning,
    '',
    '---',
    '',
    `## Recommendations for @${summaryA.username}`,
    '',
  ];

  recommendationsForA.forEach((r, i) => {
    lines.push(`### ${i + 1}. ${r.rec}`);
    lines.push(`- **Rationale**: ${r.rationale}`);
    lines.push(`- **Example**: ${r.specificExample}`);
    lines.push('');
  });

  lines.push('---', '', `## The One Thing to Steal from @${summaryB.username}`, '', stealFromB, '');
  lines.push('---', '', '## Raw JSON', '```json', JSON.stringify(result, null, 2), '```');
  lines.push('', `*Reels Intelligence Framework — compare-${summaryA.username}-vs-${summaryB.username}-${date}.md*`);

  return lines.join('\n');
}

export async function runCompare(usernameA, usernameB) {
  logger.info(`Competitor compare: @${usernameA} vs @${usernameB}`);

  const [summaryA, summaryB] = await Promise.all([
    fetchCreatorSummary(usernameA),
    fetchCreatorSummary(usernameB),
  ]);

  if (!summaryA) throw new Error(`No analyzed reels found for @${usernameA}`);
  if (!summaryB) throw new Error(`No analyzed reels found for @${usernameB}`);
  if (summaryA.reelCount < 5) logger.warn(`@${usernameA} only has ${summaryA.reelCount} reels — results may be weak`);
  if (summaryB.reelCount < 5) logger.warn(`@${usernameB} only has ${summaryB.reelCount} reels — results may be weak`);

  logger.info('Running Claude comparison...');
  const result = await runComparePrompt(summaryA, summaryB);

  const report = formatReport(summaryA, summaryB, result);

  const { writeFileSync, mkdirSync, existsSync } = await import('fs');
  const { join } = await import('path');

  const reportsDir = join(process.cwd(), 'reports');
  mkdirSync(reportsDir, { recursive: true });

  const date     = new Date().toISOString().slice(0, 10);
  let   fileName = `compare-${usernameA}-vs-${usernameB}-${date}.md`;
  let   filePath = join(reportsDir, fileName);
  let   version  = 2;
  while (existsSync(filePath)) {
    fileName = `compare-${usernameA}-vs-${usernameB}-${date}-v${version}.md`;
    filePath = join(reportsDir, fileName);
    version++;
  }

  writeFileSync(filePath, report, 'utf8');
  logger.success(`Compare report saved: ${filePath}`);

  return { report, result, filePath };
}
