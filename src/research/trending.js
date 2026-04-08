import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_API_KEY, CLAUDE_MODEL } from '../config.js';
import { listRecords } from '../airtable/client.js';
import { REELS_TABLE, REELS_FIELDS } from '../airtable/schema.js';
import { logger } from '../utils/logger.js';
import { frameworkSystemSuffix } from '../utils/frameworks.js';

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const MODEL  = CLAUDE_MODEL;

const SYSTEM = `You are a content trends analyst for short-form video creators.
You identify rising topics, emerging angles, and momentum patterns from engagement data.
Return valid JSON only — no markdown, no explanation.${frameworkSystemSuffix()}`;

async function fetchReelsInWindow(daysStart, daysEnd) {
  const now   = new Date();
  const after  = new Date(now); after.setDate(now.getDate() - daysEnd);
  const before = new Date(now); before.setDate(now.getDate() - daysStart);

  const records = await listRecords(REELS_TABLE, {
    filterFormula: `AND(
      {${REELS_FIELDS.aiAnalyzed}} = TRUE(),
      IS_AFTER({${REELS_FIELDS.publishedAt}}, "${after.toISOString().slice(0, 10)}"),
      IS_BEFORE({${REELS_FIELDS.publishedAt}}, "${before.toISOString().slice(0, 10)}")
    )`,
    fields: [
      REELS_FIELDS.username,
      REELS_FIELDS.mainTopic,
      REELS_FIELDS.topics,
      REELS_FIELDS.hookType,
      REELS_FIELDS.contentType,
      REELS_FIELDS.engagementScore,
      REELS_FIELDS.engagementTier,
      REELS_FIELDS.publishedAt,
    ],
  });

  return records.map(r => ({
    username:        r.fields[REELS_FIELDS.username]        || '',
    mainTopic:       r.fields[REELS_FIELDS.mainTopic]       || '',
    topics:          (r.fields[REELS_FIELDS.topics] || '').split(',').map(t => t.trim()).filter(Boolean),
    hookType:        r.fields[REELS_FIELDS.hookType]        || '',
    contentType:     r.fields[REELS_FIELDS.contentType]     || '',
    engagementScore: r.fields[REELS_FIELDS.engagementScore] || 0,
    engagementTier:  r.fields[REELS_FIELDS.engagementTier]  || 'LOW',
    publishedAt:     r.fields[REELS_FIELDS.publishedAt]     || '',
  }));
}

function buildTopicIndex(reels) {
  const index = {};
  for (const reel of reels) {
    const allTopics = [reel.mainTopic, ...reel.topics].filter(Boolean);
    for (const topic of allTopics) {
      const key = topic.toLowerCase().trim();
      if (!key) continue;
      if (!index[key]) {
        index[key] = { topic, count: 0, totalEngagement: 0, creators: new Set(), highCount: 0 };
      }
      index[key].count++;
      index[key].totalEngagement += reel.engagementScore;
      index[key].creators.add(reel.username);
      if (reel.engagementTier === 'HIGH') index[key].highCount++;
    }
  }
  return Object.fromEntries(
    Object.entries(index).map(([k, v]) => [k, {
      topic:         v.topic,
      count:         v.count,
      avgEngagement: parseFloat((v.totalEngagement / v.count).toFixed(3)),
      creatorCount:  v.creators.size,
      creators:      [...v.creators],
      highCount:     v.highCount,
      highRate:      parseFloat((v.highCount / v.count * 100).toFixed(1)),
    }])
  );
}

async function runTrendingPrompt(recentIndex, olderIndex, days, creatorCount) {
  // Compare topics: recent window vs older window
  const recentTopics = Object.values(recentIndex).sort((a, b) => b.count - a.count);

  // Label each topic with momentum
  const labeled = recentTopics.map(t => {
    const older = olderIndex[t.topic.toLowerCase().trim()];
    const isNew = !older;
    const momentum = isNew ? 'emerging'
      : t.count > older.count * 1.5 ? 'rising'
      : t.count < older.count * 0.7 ? 'declining'
      : 'stable';
    return { ...t, momentum, olderCount: older?.count || 0, olderAvgEngagement: older?.avgEngagement || 0 };
  });

  const prompt = `Analyze trending content topics across ${creatorCount} Instagram creators over the last ${days} days vs the prior ${days} days.

Recent window topics (with momentum labels):
${JSON.stringify(labeled.slice(0, 50), null, 2)}

For each trending/emerging topic:
1. Why is this resonating RIGHT NOW? (1 sentence, be specific)
2. What's the freshest angle that isn't saturated yet?
3. Which creator niches would benefit most from this topic?
4. What hook type works best for this topic based on the data?

Return JSON:
{
  "trending": [top 10 rising/emerging topics, each with: { topic, momentum, count, avgEngagement, highRate, whyNow, freshAngle, bestNiches, bestHookType }],
  "declining": [top 5 declining topics with: { topic, olderCount, recentCount, whyDecline }],
  "emergingGems": [top 3 NEW topics with high engagement that just appeared: { topic, avgEngagement, highRate, opportunity }],
  "overallInsight": "2 sentence summary of the content landscape shift happening right now"
}`;

  const msg = await client.messages.create({
    model: MODEL, max_tokens: 3000, system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = msg.content.map(c => c.text || '').join('');
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

function formatReport(result, meta) {
  const { trending, declining, emergingGems, overallInsight } = result;
  const date = new Date().toISOString().slice(0, 10);

  const lines = [
    `# Trending Topics Report`,
    `Generated: ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`,
    `Window: last ${meta.days} days vs prior ${meta.days} days | ${meta.recentCount} recent reels | ${meta.olderCount} prior reels | ${meta.creatorCount} creators`,
    '',
    '---',
    '',
    `## Overall Insight`,
    '',
    overallInsight,
    '',
    '---',
    '',
    '## Trending Topics',
    '',
  ];

  trending.forEach((t, i) => {
    const badge = t.momentum === 'emerging' ? 'Emerging' : 'Rising';
    lines.push(`### ${i + 1}. ${t.topic} — ${badge}`);
    lines.push(`- **Reels**: ${t.count} | **Avg engagement**: ${t.avgEngagement}% | **HIGH rate**: ${t.highRate}%`);
    lines.push(`- **Why now**: ${t.whyNow}`);
    lines.push(`- **Fresh angle**: ${t.freshAngle}`);
    lines.push(`- **Best niches**: ${Array.isArray(t.bestNiches) ? t.bestNiches.join(', ') : t.bestNiches}`);
    lines.push(`- **Best hook type**: ${t.bestHookType}`);
    lines.push('');
  });

  lines.push('---', '', '## Emerging Gems', '*New topics that just appeared with strong engagement*', '');
  emergingGems.forEach((g, i) => {
    lines.push(`### ${i + 1}. ${g.topic}`);
    lines.push(`- **Avg engagement**: ${g.avgEngagement}% | **HIGH rate**: ${g.highRate}%`);
    lines.push(`- **Opportunity**: ${g.opportunity}`);
    lines.push('');
  });

  lines.push('---', '', '## Declining Topics', '*Pull back on these or find a fresh angle*', '');
  declining.forEach((d, i) => {
    lines.push(`### ${i + 1}. ${d.topic}`);
    lines.push(`- **Prior reels**: ${d.olderCount} → **Recent reels**: ${d.recentCount}`);
    lines.push(`- **Why declining**: ${d.whyDecline}`);
    lines.push('');
  });

  lines.push('---', '', '## Raw JSON', '```json', JSON.stringify(result, null, 2), '```');
  lines.push('', `*Reels Intelligence Framework — trending-${date}.md*`);

  return lines.join('\n');
}

export async function runTrendingAnalysis({ days = 30 } = {}) {
  logger.info(`Trending analysis: comparing last ${days} days vs prior ${days} days`);

  // Recent window: 0 to N days ago
  const recentReels = await fetchReelsInWindow(0, days);
  // Older window: N to 2N days ago
  const olderReels  = await fetchReelsInWindow(days, days * 2);

  logger.step(`Recent: ${recentReels.length} reels | Older: ${olderReels.length} reels`);

  if (!recentReels.length) {
    throw new Error(`No analyzed reels in the last ${days} days. Widen the window or run the scraper.`);
  }

  const recentIndex = buildTopicIndex(recentReels);
  const olderIndex  = buildTopicIndex(olderReels);
  const creatorCount = new Set(recentReels.map(r => r.username)).size;

  logger.info('Running Claude trending analysis...');
  const result = await runTrendingPrompt(recentIndex, olderIndex, days, creatorCount);

  const meta = {
    days,
    recentCount: recentReels.length,
    olderCount:  olderReels.length,
    creatorCount,
  };

  const report = formatReport(result, meta);

  const { writeFileSync, mkdirSync, existsSync } = await import('fs');
  const { join } = await import('path');

  const reportsDir = join(process.cwd(), 'reports');
  mkdirSync(reportsDir, { recursive: true });

  const date     = new Date().toISOString().slice(0, 10);
  let   fileName = `trending-${date}.md`;
  let   filePath = join(reportsDir, fileName);
  let   version  = 2;
  while (existsSync(filePath)) {
    fileName = `trending-${date}-v${version}.md`;
    filePath = join(reportsDir, fileName);
    version++;
  }

  writeFileSync(filePath, report, 'utf8');
  logger.success(`Trending report saved: ${filePath}`);

  return { report, result, filePath };
}
