import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_API_KEY, CLAUDE_MODEL } from '../config.js';
import { listRecords } from '../airtable/client.js';
import { REELS_TABLE, REELS_FIELDS } from '../airtable/schema.js';
import { logger } from '../utils/logger.js';
import { frameworkSystemSuffix } from '../utils/frameworks.js';

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const MODEL  = CLAUDE_MODEL;

const SYSTEM = `You are a copywriting analyst specializing in short-form video hooks.
You identify structural patterns that separate high-performing hooks from weak ones.
Return valid JSON only — no markdown, no explanation.${frameworkSystemSuffix()}`;

async function fetchHooksForCreator(username) {
  const records = await listRecords(REELS_TABLE, {
    filterFormula: `AND(
      {${REELS_FIELDS.username}} = "${username}",
      {${REELS_FIELDS.aiAnalyzed}} = TRUE(),
      {${REELS_FIELDS.hook}} != ""
    )`,
    fields: [
      REELS_FIELDS.hook,
      REELS_FIELDS.hookType,
      REELS_FIELDS.hookCategory,
      REELS_FIELDS.engagementScore,
      REELS_FIELDS.engagementTier,
      REELS_FIELDS.views,
      REELS_FIELDS.contentType,
    ],
  });

  return records.map(r => ({
    hook:            r.fields[REELS_FIELDS.hook]            || '',
    hookType:        r.fields[REELS_FIELDS.hookType]        || 'Other',
    hookCategory:    r.fields[REELS_FIELDS.hookCategory]    || 'Other',
    engagementScore: r.fields[REELS_FIELDS.engagementScore] || 0,
    engagementTier:  r.fields[REELS_FIELDS.engagementTier]  || 'LOW',
    views:           r.fields[REELS_FIELDS.views]           || 0,
    contentType:     r.fields[REELS_FIELDS.contentType]     || '',
  }));
}

async function runHookPrompt(highHooks, lowHooks, username) {
  const prompt = `Analyze hooks from @${username}'s Instagram reels.

HIGH engagement hooks (engagement score >= 5%):
${JSON.stringify(highHooks.map(h => ({ hook: h.hook, hookType: h.hookType, hookCategory: h.hookCategory, engagementScore: h.engagementScore })), null, 2)}

LOW engagement hooks (engagement score < 2%):
${JSON.stringify(lowHooks.map(h => ({ hook: h.hook, hookType: h.hookType, hookCategory: h.hookCategory, engagementScore: h.engagementScore })), null, 2)}

Identify:

1. "winningPatterns": structural patterns that appear in HIGH hooks but not LOW.
   For each: { pattern, example, whyItWorks, template (fill-in-the-blank), avgEngagement }

2. "avoidPatterns": structures that correlate with LOW engagement.
   For each: { pattern, example, whyItFails }

3. "topOpeningWords": first words/phrases that appear in HIGH hooks most often.
   For each: { phrase, frequency, avgEngagement }

4. "hookTypePerformance": for each hookType, compare HIGH vs LOW performance.
   Format: [{ hookType, highCount, lowCount, verdict: "use more" | "use less" | "neutral" }]

5. "hookCategoryPerformance": same but for hookCategory.

6. "bestHookFormulas": 5 specific fill-in-the-blank hook templates extracted from top performers.
   Each must be immediately usable: { formula, example, bestFor }

Return JSON with those 6 keys.`;

  const msg = await client.messages.create({
    model: MODEL, max_tokens: 3000, system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = msg.content.map(c => c.text || '').join('');
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

function formatReport(username, result, meta) {
  const { winningPatterns, avoidPatterns, topOpeningWords, hookTypePerformance, hookCategoryPerformance, bestHookFormulas } = result;
  const date = new Date().toISOString().slice(0, 10);

  const lines = [
    `# Hook Pattern Analysis — @${username}`,
    `Generated: ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`,
    `Data: ${meta.totalHooks} hooks analyzed | ${meta.highCount} HIGH tier | ${meta.lowCount} LOW tier`,
    '',
    '---',
    '',
    '## Winning Hook Patterns',
    '',
  ];

  winningPatterns.forEach((p, i) => {
    lines.push(`### ${i + 1}. ${p.pattern}`);
    lines.push(`- **Example**: "${p.example}"`);
    lines.push(`- **Why it works**: ${p.whyItWorks}`);
    lines.push(`- **Template**: \`${p.template}\``);
    if (p.avgEngagement) lines.push(`- **Avg engagement**: ${p.avgEngagement}%`);
    lines.push('');
  });

  lines.push('---', '', '## Hook Formulas — Copy These', '');
  bestHookFormulas.forEach((f, i) => {
    lines.push(`### ${i + 1}. \`${f.formula}\``);
    lines.push(`- **Example**: "${f.example}"`);
    lines.push(`- **Best for**: ${f.bestFor}`);
    lines.push('');
  });

  lines.push('---', '', '## Top Opening Words/Phrases', '');
  topOpeningWords.forEach(w => {
    lines.push(`- **"${w.phrase}"** — ${w.frequency}x | avg engagement: ${w.avgEngagement}%`);
  });

  lines.push('', '---', '', '## Hook Type Performance', '');
  hookTypePerformance.forEach(h => {
    const verdict = h.verdict === 'use more' ? '✓ use more' : h.verdict === 'use less' ? '✗ use less' : '→ neutral';
    lines.push(`- **${h.hookType}**: HIGH ${h.highCount} / LOW ${h.lowCount} — ${verdict}`);
  });

  lines.push('', '---', '', '## Hook Category Performance', '');
  hookCategoryPerformance.forEach(h => {
    const verdict = h.verdict === 'use more' ? '✓ use more' : h.verdict === 'use less' ? '✗ use less' : '→ neutral';
    lines.push(`- **${h.hookCategory}**: HIGH ${h.highCount} / LOW ${h.lowCount} — ${verdict}`);
  });

  lines.push('', '---', '', '## Patterns to Avoid', '');
  avoidPatterns.forEach((p, i) => {
    lines.push(`### ${i + 1}. ${p.pattern}`);
    lines.push(`- **Example**: "${p.example}"`);
    lines.push(`- **Why it fails**: ${p.whyItFails}`);
    lines.push('');
  });

  lines.push('---', '', '## Raw JSON', '```json', JSON.stringify(result, null, 2), '```');
  lines.push('', `*Reels Intelligence Framework — hooks-${username}-${date}.md*`);

  return lines.join('\n');
}

export async function runHookAnalysis(username) {
  logger.info(`Hook analysis: starting for @${username}`);

  const hooks = await fetchHooksForCreator(username);
  if (!hooks.length) {
    throw new Error(`No hooks found for @${username}. Run the scraper first.`);
  }

  const highHooks = hooks.filter(h => h.engagementTier === 'HIGH');
  const lowHooks  = hooks.filter(h => h.engagementTier === 'LOW');

  logger.step(`Total hooks: ${hooks.length} | HIGH: ${highHooks.length} | LOW: ${lowHooks.length}`);

  if (highHooks.length < 3) {
    logger.warn('Fewer than 3 HIGH tier hooks — results may be limited. Scrape more reels first.');
  }

  logger.info('Running Claude hook pattern analysis...');
  const result = await runHookPrompt(highHooks, lowHooks, username);

  const meta = { totalHooks: hooks.length, highCount: highHooks.length, lowCount: lowHooks.length };
  const report = formatReport(username, result, meta);

  const { writeFileSync, mkdirSync, existsSync } = await import('fs');
  const { join } = await import('path');

  const reportsDir = join(process.cwd(), 'reports');
  mkdirSync(reportsDir, { recursive: true });

  const date     = new Date().toISOString().slice(0, 10);
  let   fileName = `hooks-${username}-${date}.md`;
  let   filePath = join(reportsDir, fileName);
  let   version  = 2;
  while (existsSync(filePath)) {
    fileName = `hooks-${username}-${date}-v${version}.md`;
    filePath = join(reportsDir, fileName);
    version++;
  }

  writeFileSync(filePath, report, 'utf8');
  logger.success(`Hook report saved: ${filePath}`);

  return { report, result, filePath };
}
