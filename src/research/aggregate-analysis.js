import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_API_KEY, CLAUDE_MODEL } from '../config.js';
import { listRecords } from '../airtable/client.js';
import { REELS_TABLE, REELS_FIELDS, CREATORS_TABLE, CREATORS_FIELDS } from '../airtable/schema.js';
import { logger } from '../utils/logger.js';
import { frameworkSystemSuffix } from '../utils/frameworks.js';

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const MODEL  = CLAUDE_MODEL;

const SYSTEM = `You are a content intelligence analyst studying patterns across multiple Instagram creators.
You identify shared patterns, differentiation, saturation signals, and cross-creator opportunities.
Return valid JSON only — no markdown, no explanation.${frameworkSystemSuffix()}`;

/**
 * Fetch all analyzed reels across all creators within a time window.
 */
async function fetchAllReels(days) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const records = await listRecords(REELS_TABLE, {
    filterFormula: `AND(
      {${REELS_FIELDS.aiAnalyzed}} = TRUE(),
      IS_AFTER({${REELS_FIELDS.publishedAt}}, "${cutoffStr}")
    )`,
    fields: [
      REELS_FIELDS.username,
      REELS_FIELDS.reelId,
      REELS_FIELDS.mainTopic,
      REELS_FIELDS.topics,
      REELS_FIELDS.contentType,
      REELS_FIELDS.hookType,
      REELS_FIELDS.hookCategory,
      REELS_FIELDS.emotionalTone,
      REELS_FIELDS.engagementScore,
      REELS_FIELDS.engagementTier,
      REELS_FIELDS.views,
      REELS_FIELDS.hook,
      REELS_FIELDS.ctaType,
    ],
  });

  return records.map(r => ({
    username:        r.fields[REELS_FIELDS.username]        || '',
    reelId:          r.fields[REELS_FIELDS.reelId]          || '',
    mainTopic:       r.fields[REELS_FIELDS.mainTopic]       || '',
    topics:          (r.fields[REELS_FIELDS.topics] || '').split(',').map(t => t.trim()).filter(Boolean),
    contentType:     r.fields[REELS_FIELDS.contentType]     || '',
    hookType:        r.fields[REELS_FIELDS.hookType]        || '',
    hookCategory:    r.fields[REELS_FIELDS.hookCategory]    || '',
    emotionalTone:   r.fields[REELS_FIELDS.emotionalTone]   || '',
    engagementScore: r.fields[REELS_FIELDS.engagementScore] || 0,
    engagementTier:  r.fields[REELS_FIELDS.engagementTier]  || 'LOW',
    views:           r.fields[REELS_FIELDS.views]           || 0,
    hook:            r.fields[REELS_FIELDS.hook]            || '',
    ctaType:         r.fields[REELS_FIELDS.ctaType]         || '',
  }));
}

/**
 * Build per-creator summary stats from a list of reels.
 */
function buildCreatorSummaries(reels) {
  const byCreator = {};

  for (const reel of reels) {
    if (!byCreator[reel.username]) {
      byCreator[reel.username] = {
        username: reel.username,
        reels: [],
      };
    }
    byCreator[reel.username].reels.push(reel);
  }

  return Object.values(byCreator).map(({ username, reels: cr }) => {
    const scores    = cr.map(r => r.engagementScore);
    const avgScore  = scores.reduce((a, b) => a + b, 0) / scores.length;
    const highCount = cr.filter(r => r.engagementTier === 'HIGH').length;

    const topN = (key, n) => {
      const freq = {};
      cr.forEach(r => { if (r[key]) freq[r[key]] = (freq[r[key]] || 0) + 1; });
      return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, n).map(([v, c]) => ({ value: v, count: c }));
    };

    const allTopics = cr.flatMap(r => [r.mainTopic, ...r.topics].filter(Boolean));
    const topicFreq = {};
    allTopics.forEach(t => { topicFreq[t.toLowerCase()] = (topicFreq[t.toLowerCase()] || 0) + 1; });
    const topTopics = Object.entries(topicFreq).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t, c]) => ({ topic: t, count: c }));

    return {
      username,
      reelCount:          cr.length,
      avgEngagementScore: parseFloat(avgScore.toFixed(3)),
      highRate:           parseFloat((highCount / cr.length * 100).toFixed(1)),
      topTopics,
      topContentTypes:    topN('contentType', 3),
      topHookTypes:       topN('hookType', 3),
      topHookCategories:  topN('hookCategory', 3),
      topEmotionalTones:  topN('emotionalTone', 3),
    };
  });
}

/**
 * Build cross-creator topic saturation map.
 * Returns topics sorted by how many creators cover them.
 */
function buildTopicSaturationMap(reels) {
  const topicCreators = {};

  for (const reel of reels) {
    const allTopics = [reel.mainTopic, ...reel.topics].filter(Boolean);
    for (const topic of allTopics) {
      const key = topic.toLowerCase().trim();
      if (!key) continue;
      if (!topicCreators[key]) topicCreators[key] = { topic, creators: new Set(), count: 0, totalEngagement: 0 };
      topicCreators[key].creators.add(reel.username);
      topicCreators[key].count++;
      topicCreators[key].totalEngagement += reel.engagementScore;
    }
  }

  return Object.values(topicCreators)
    .map(t => ({
      topic:         t.topic,
      creatorCount:  t.creators.size,
      creators:      [...t.creators],
      totalReels:    t.count,
      avgEngagement: parseFloat((t.totalEngagement / t.count).toFixed(3)),
    }))
    .sort((a, b) => b.creatorCount - a.creatorCount);
}

/**
 * Main Claude call for aggregate cross-creator analysis.
 */
async function runAggregatePrompt(creatorSummaries, saturationMap, totalReels, days) {
  const prompt = `Analyze content patterns across ${creatorSummaries.length} Instagram creators (${totalReels} reels, last ${days} days).

Creator summaries:
${JSON.stringify(creatorSummaries, null, 2)}

Topic saturation (how many creators cover each topic):
${JSON.stringify(saturationMap.slice(0, 60), null, 2)}

Provide:

1. "commonHookPatterns": hook types and categories that appear across ALL or most creators — and what this reveals about what's working in the space right now.
   Format: [{ pattern, creatorsCovering, insight, whatItMeans }]

2. "contentOwnership": which creator "owns" which topic area — where one creator clearly dominates a topic compared to others.
   Format: [{ topic, dominantCreator, why, otherCreatorsInSpace }]

3. "saturatedTopics": topics covered by 3+ creators where incremental engagement is likely low — the space is crowded.
   Format: [{ topic, creatorCount, avgEngagement, warningSign }]

4. "whitespaceOpportunities": topic areas that appear in 0–1 creators but show high engagement in the data — underserved gaps.
   Format: [{ topic, opportunity, suggestedAngle, whichCreatorCouldOwnIt }]

5. "bestPerformingHookType": the single hook type producing the highest avg engagement across ALL creators — and why.
   Format: { hookType, avgEngagement, whyItWorks, exampleTemplate }

6. "creatorDifferentiationMap": for each creator, their single most unique strategic trait vs the group.
   Format: [{ creator, uniqueTrait, whatSetsThemApart, replicabilityScore: 1-5 }]

7. "landscapeInsight": 3-sentence summary of the overall content landscape based on this data — what's oversaturated, what's emerging, and what the smart move is for a new creator entering this space.

Return JSON with those 7 keys.`;

  const msg = await client.messages.create({
    model: MODEL, max_tokens: 4096, system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = msg.content.map(c => c.text || '').join('');
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

/**
 * Format aggregate analysis result as a markdown report.
 */
function formatReport(result, meta) {
  const {
    commonHookPatterns,
    contentOwnership,
    saturatedTopics,
    whitespaceOpportunities,
    bestPerformingHookType,
    creatorDifferentiationMap,
    landscapeInsight,
  } = result;

  const date = new Date().toISOString().slice(0, 10);

  const lines = [
    `# Aggregate Analysis — All Creators`,
    `Generated: ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`,
    `Data: ${meta.creatorCount} creators | ${meta.totalReels} reels | last ${meta.days} days`,
    `Creators: ${meta.creators.join(', ')}`,
    '',
    '---',
    '',
    '## Landscape Overview',
    '',
    landscapeInsight,
    '',
    '---',
    '',
    '## Best Performing Hook Type Across All Creators',
    '',
    `**${bestPerformingHookType.hookType}** — avg engagement: ${bestPerformingHookType.avgEngagement}%`,
    '',
    `**Why it works**: ${bestPerformingHookType.whyItWorks}`,
    '',
    `**Template**: \`${bestPerformingHookType.exampleTemplate}\``,
    '',
    '---',
    '',
    '## Common Hook Patterns Across Creators',
    '',
  ];

  commonHookPatterns.forEach((p, i) => {
    lines.push(`### ${i + 1}. ${p.pattern}`);
    lines.push(`- **Creators using it**: ${Array.isArray(p.creatorsCovering) ? p.creatorsCovering.join(', ') : p.creatorsCovering}`);
    lines.push(`- **Insight**: ${p.insight}`);
    lines.push(`- **What it means**: ${p.whatItMeans}`);
    lines.push('');
  });

  lines.push('---', '', '## Content Ownership Map', '*Who dominates which topic*', '');
  contentOwnership.forEach((c, i) => {
    lines.push(`### ${i + 1}. ${c.topic} → @${c.dominantCreator}`);
    lines.push(`- **Why they own it**: ${c.why}`);
    if (c.otherCreatorsInSpace?.length) {
      lines.push(`- **Others in space**: ${Array.isArray(c.otherCreatorsInSpace) ? c.otherCreatorsInSpace.join(', ') : c.otherCreatorsInSpace}`);
    }
    lines.push('');
  });

  lines.push('---', '', '## Whitespace Opportunities', '*Low competition, high potential*', '');
  whitespaceOpportunities.forEach((w, i) => {
    lines.push(`### ${i + 1}. ${w.topic}`);
    lines.push(`- **Opportunity**: ${w.opportunity}`);
    lines.push(`- **Suggested angle**: ${w.suggestedAngle}`);
    lines.push(`- **Best placed creator**: ${w.whichCreatorCouldOwnIt}`);
    lines.push('');
  });

  lines.push('---', '', '## Saturated Topics', '*High competition — enter with a differentiated angle or avoid*', '');
  saturatedTopics.forEach((s, i) => {
    lines.push(`### ${i + 1}. ${s.topic}`);
    lines.push(`- **Covered by**: ${s.creatorCount} creators | avg engagement: ${s.avgEngagement}%`);
    lines.push(`- **Warning**: ${s.warningSign}`);
    lines.push('');
  });

  lines.push('---', '', '## Creator Differentiation Map', '');
  creatorDifferentiationMap.forEach(c => {
    lines.push(`### @${c.creator}`);
    lines.push(`- **Unique trait**: ${c.uniqueTrait}`);
    lines.push(`- **What sets them apart**: ${c.whatSetsThemApart}`);
    lines.push(`- **Replicability** (1–5): ${c.replicabilityScore}`);
    lines.push('');
  });

  lines.push('---', '', '## Raw JSON', '```json', JSON.stringify(result, null, 2), '```');
  lines.push('', `*Reels Intelligence Framework — aggregate-${date}.md*`);

  return lines.join('\n');
}

/**
 * Main export. Runs cross-creator aggregate analysis across all active creators.
 * Returns { report: string (markdown), result: object, filePath: string, reelCount: number }
 */
export async function runAggregateAnalysis({ days = 30 } = {}) {
  logger.info(`Aggregate analysis: fetching all creators' reels (last ${days} days)`);

  const allReels = await fetchAllReels(days);

  if (!allReels.length) {
    throw new Error(`No analyzed reels found in the last ${days} days. Run the scraper first.`);
  }

  const creators = [...new Set(allReels.map(r => r.username))].filter(Boolean);
  logger.step(`Found ${allReels.length} reels across ${creators.length} creators: ${creators.join(', ')}`);

  if (creators.length < 2) {
    throw new Error(`Aggregate analysis needs at least 2 creators with data. Only found: ${creators.join(', ')}`);
  }

  const creatorSummaries  = buildCreatorSummaries(allReels);
  const saturationMap     = buildTopicSaturationMap(allReels);

  logger.step(`Built summaries for ${creatorSummaries.length} creators | ${saturationMap.length} unique topics`);

  logger.info('Running Claude aggregate analysis...');
  const result = await runAggregatePrompt(creatorSummaries, saturationMap, allReels.length, days);

  const meta = {
    days,
    creatorCount: creators.length,
    totalReels:   allReels.length,
    creators,
  };

  const report = formatReport(result, meta);

  const { writeFileSync, mkdirSync, existsSync } = await import('fs');
  const { join } = await import('path');

  const reportsDir = join(process.cwd(), 'reports');
  mkdirSync(reportsDir, { recursive: true });

  const date     = new Date().toISOString().slice(0, 10);
  let   fileName = `aggregate-${date}.md`;
  let   filePath = join(reportsDir, fileName);
  let   version  = 2;
  while (existsSync(filePath)) {
    fileName = `aggregate-${date}-v${version}.md`;
    filePath = join(reportsDir, fileName);
    version++;
  }

  writeFileSync(filePath, report, 'utf8');
  logger.success(`Aggregate report saved: ${filePath}`);

  return { report, result, filePath, reelCount: allReels.length };
}
