import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_API_KEY, CLAUDE_MODEL } from '../config.js';
import { listRecords } from '../airtable/client.js';
import { REELS_TABLE, REELS_FIELDS, CREATORS_TABLE, CREATORS_FIELDS } from '../airtable/schema.js';
import { logger } from '../utils/logger.js';
import { frameworkSystemSuffix } from '../utils/frameworks.js';

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const MODEL  = CLAUDE_MODEL;

const SYSTEM = `You are a content strategist analyzing Instagram creator data.
You identify content gaps, weak spots, and untapped opportunities based on topic coverage and engagement data.
Return valid JSON only — no markdown, no explanation.${frameworkSystemSuffix()}`;

/**
 * Pull all reels for a username from Airtable.
 * Returns only the fields needed for gap analysis.
 */
async function fetchCreatorTopics(username, days = 90) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const records = await listRecords(REELS_TABLE, {
    filterFormula: `AND(
      {${REELS_FIELDS.username}} = "${username}",
      {${REELS_FIELDS.aiAnalyzed}} = TRUE(),
      IS_AFTER({${REELS_FIELDS.publishedAt}}, "${cutoffStr}")
    )`,
    fields: [
      REELS_FIELDS.reelId,
      REELS_FIELDS.mainTopic,
      REELS_FIELDS.topics,
      REELS_FIELDS.hookType,
      REELS_FIELDS.hookCategory,
      REELS_FIELDS.contentType,
      REELS_FIELDS.engagementScore,
      REELS_FIELDS.engagementTier,
      REELS_FIELDS.views,
    ],
  });

  return records.map(r => ({
    reelId:          r.fields[REELS_FIELDS.reelId],
    mainTopic:       r.fields[REELS_FIELDS.mainTopic]    || '',
    topics:          (r.fields[REELS_FIELDS.topics] || '').split(',').map(t => t.trim()).filter(Boolean),
    hookType:        r.fields[REELS_FIELDS.hookType]     || '',
    hookCategory:    r.fields[REELS_FIELDS.hookCategory] || '',
    contentType:     r.fields[REELS_FIELDS.contentType]  || '',
    engagementScore: r.fields[REELS_FIELDS.engagementScore] || 0,
    engagementTier:  r.fields[REELS_FIELDS.engagementTier]  || 'LOW',
    views:           r.fields[REELS_FIELDS.views]        || 0,
  }));
}

/**
 * Get all active creators except the target one.
 */
async function fetchCompetitorUsernames(excludeUsername) {
  const records = await listRecords(CREATORS_TABLE, {
    filterFormula: `AND({${CREATORS_FIELDS.active}} = TRUE(), {${CREATORS_FIELDS.username}} != "${excludeUsername}")`,
    fields: [CREATORS_FIELDS.username, CREATORS_FIELDS.displayName, CREATORS_FIELDS.niche],
  });
  return records.map(r => ({
    username:    r.fields[CREATORS_FIELDS.username],
    displayName: r.fields[CREATORS_FIELDS.displayName] || r.fields[CREATORS_FIELDS.username],
    niche:       r.fields[CREATORS_FIELDS.niche] || '',
  }));
}

/**
 * Aggregate topic frequency + avg engagement across a set of reels.
 * Returns sorted topic summary array.
 */
function aggregateTopics(reels) {
  const topicMap = {}; // topic → { count, totalEngagement, coveredBy: Set }

  for (const reel of reels) {
    const allTopics = [reel.mainTopic, ...reel.topics].filter(Boolean);
    for (const topic of allTopics) {
      const key = topic.toLowerCase().trim();
      if (!key) continue;
      if (!topicMap[key]) topicMap[key] = { topic, count: 0, totalEngagement: 0, coveredBy: new Set() };
      topicMap[key].count++;
      topicMap[key].totalEngagement += reel.engagementScore;
      if (reel.username) topicMap[key].coveredBy.add(reel.username);
    }
  }

  return Object.values(topicMap)
    .map(t => ({
      topic:         t.topic,
      count:         t.count,
      avgEngagement: parseFloat((t.totalEngagement / t.count).toFixed(3)),
      coveredBy:     [...t.coveredBy],
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Main Claude call — identifies gaps, weak spots, and opportunities.
 */
async function runGapPrompt(username, creatorTopics, competitorTopics, competitorList) {
  const prompt = `Creator A is @${username}.

@${username} covers these topics (with avg engagement score):
${JSON.stringify(creatorTopics.slice(0, 60), null, 2)}

Their competitors (${competitorList.map(c => '@' + c.username).join(', ')}) collectively cover:
${JSON.stringify(competitorTopics.slice(0, 80), null, 2)}

Identify exactly:

1. "hardGaps": topics competitors cover FREQUENTLY (count >= 3) that @${username} has NEVER posted about.
   For each: { "topic", "frequency": how many competitor reels cover it, "coveredBy": which creators, "avgCompetitorEngagement", "opportunity": why this gap matters in 1 sentence }

2. "weakSpots": topics BOTH cover but where @${username}'s avg engagement is significantly lower than competitors.
   For each: { "topic", "creatorAvgEngagement", "competitorAvgEngagement", "gap": numeric difference, "suggestion": what to try differently }

3. "opportunities": 5 specific content angles @${username} could own based on the gaps — angles that are NOT saturated yet.
   For each: { "angle", "basedOnGap": which hard gap it fills, "hookSuggestion": a specific hook to open with, "whyNow": timing rationale }

4. "strengthsToDoubleDown": topics where @${username} OUTPERFORMS competitors — these are worth posting MORE of.
   For each: { "topic", "creatorAvgEngagement", "competitorAvgEngagement", "advantage": numeric difference }

Return JSON with keys: hardGaps, weakSpots, opportunities, strengthsToDoubleDown`;

  const msg = await client.messages.create({
    model: MODEL, max_tokens: 4096, system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = msg.content.map(c => c.text || '').join('');
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

/**
 * Format the gap analysis result as a markdown report.
 */
function formatReport(username, result, meta) {
  const { hardGaps, weakSpots, opportunities, strengthsToDoubleDown } = result;
  const date = new Date().toISOString().slice(0, 10);

  const lines = [
    `# Content Gap Analysis — @${username}`,
    `Generated: ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`,
    `Data window: last ${meta.days} days | ${meta.creatorReelCount} creator reels | ${meta.competitorReelCount} competitor reels across ${meta.competitorCount} creators`,
    `Competitors analyzed: ${meta.competitors.map(c => '@' + c.username).join(', ')}`,
    '',
    '---',
    '',
    '## Hard Gaps — Topics you\'ve never covered',
    `*${hardGaps.length} gaps found*`,
    '',
  ];

  hardGaps.forEach((g, i) => {
    lines.push(`### ${i + 1}. ${g.topic}`);
    lines.push(`- **Competitor frequency**: ${g.frequency} reels`);
    lines.push(`- **Covered by**: ${g.coveredBy.map(u => '@' + u).join(', ')}`);
    lines.push(`- **Avg competitor engagement**: ${g.avgCompetitorEngagement}%`);
    lines.push(`- **Opportunity**: ${g.opportunity}`);
    lines.push('');
  });

  lines.push('---', '', '## Weak Spots — Topics you cover but underperform on', '');
  weakSpots.forEach((w, i) => {
    lines.push(`### ${i + 1}. ${w.topic}`);
    lines.push(`- **Your avg engagement**: ${w.creatorAvgEngagement}%`);
    lines.push(`- **Competitor avg**: ${w.competitorAvgEngagement}%`);
    lines.push(`- **Gap**: -${w.gap}%`);
    lines.push(`- **Suggestion**: ${w.suggestion}`);
    lines.push('');
  });

  lines.push('---', '', '## Opportunities — Angles to own right now', '');
  opportunities.forEach((o, i) => {
    lines.push(`### ${i + 1}. ${o.angle}`);
    lines.push(`- **Fills gap**: ${o.basedOnGap}`);
    lines.push(`- **Hook suggestion**: "${o.hookSuggestion}"`);
    lines.push(`- **Why now**: ${o.whyNow}`);
    lines.push('');
  });

  lines.push('---', '', '## Strengths — Double down on these', '');
  strengthsToDoubleDown.forEach((s, i) => {
    lines.push(`### ${i + 1}. ${s.topic}`);
    lines.push(`- **Your avg engagement**: ${s.creatorAvgEngagement}%`);
    lines.push(`- **Competitor avg**: ${s.competitorAvgEngagement}%`);
    lines.push(`- **Your advantage**: +${s.advantage}%`);
    lines.push('');
  });

  lines.push('---', '', '## Raw JSON', '```json', JSON.stringify(result, null, 2), '```');
  lines.push('', `*Reels Intelligence Framework — gap-${username}-${date}.md*`);

  return lines.join('\n');
}

/**
 * Main export. Runs full gap analysis for a creator vs all active competitors.
 * Returns { report: string (markdown), result: object, filePath: string }
 */
export async function runGapAnalysis(username, { days = 90 } = {}) {
  logger.info(`Gap analysis: starting for @${username} (last ${days} days)`);

  // 1. Fetch creator reels
  const creatorReels = await fetchCreatorTopics(username, days);
  if (!creatorReels.length) {
    throw new Error(`No analyzed reels found for @${username} in the last ${days} days. Run the scraper first.`);
  }
  logger.step(`Fetched ${creatorReels.length} reels for @${username}`);

  // Tag with username for coveredBy tracking
  const taggedCreatorReels = creatorReels.map(r => ({ ...r, username }));

  // 2. Fetch competitors
  const competitors = await fetchCompetitorUsernames(username);
  if (!competitors.length) {
    throw new Error('No other active creators in Airtable to compare against. Add competitors to config/targets.json.');
  }
  logger.step(`Found ${competitors.length} competitors: ${competitors.map(c => '@' + c.username).join(', ')}`);

  // 3. Fetch all competitor reels
  const competitorReels = [];
  for (const competitor of competitors) {
    const reels = await fetchCreatorTopics(competitor.username, days);
    reels.forEach(r => competitorReels.push({ ...r, username: competitor.username }));
    logger.step(`@${competitor.username}: ${reels.length} reels`);
  }

  if (!competitorReels.length) {
    throw new Error('No analyzed competitor reels found. Scrape competitor data first.');
  }

  // 4. Aggregate topics for both sides
  const creatorTopicSummary    = aggregateTopics(taggedCreatorReels);
  const competitorTopicSummary = aggregateTopics(competitorReels);

  logger.step(`Creator topics: ${creatorTopicSummary.length} unique | Competitor topics: ${competitorTopicSummary.length} unique`);

  // 5. Claude gap analysis
  logger.info('Running Claude gap analysis...');
  const result = await runGapPrompt(username, creatorTopicSummary, competitorTopicSummary, competitors);

  // 6. Format report
  const meta = {
    days,
    creatorReelCount:   creatorReels.length,
    competitorReelCount: competitorReels.length,
    competitorCount:    competitors.length,
    competitors,
  };
  const report = formatReport(username, result, meta);

  // 7. Save to reports/
  const { writeFileSync, mkdirSync } = await import('fs');
  const { join } = await import('path');

  const reportsDir = join(process.cwd(), 'reports');
  mkdirSync(reportsDir, { recursive: true });

  const date     = new Date().toISOString().slice(0, 10);
  let   fileName = `gap-${username}-${date}.md`;
  let   filePath = join(reportsDir, fileName);

  // Never overwrite existing reports
  let version = 2;
  const { existsSync } = await import('fs');
  while (existsSync(filePath)) {
    fileName = `gap-${username}-${date}-v${version}.md`;
    filePath = join(reportsDir, fileName);
    version++;
  }

  writeFileSync(filePath, report, 'utf8');
  logger.success(`Gap report saved: ${filePath}`);

  return { report, result, filePath };
}
