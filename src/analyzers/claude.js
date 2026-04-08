import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ANTHROPIC_API_KEY, CLAUDE_MODEL, CLAUDE_BATCH_SIZE } from '../config.js';
import { logger } from '../utils/logger.js';
import { frameworkSystemSuffix } from '../utils/frameworks.js';
import { parseClaudeJSON, toISODate, airtableFormula } from '../utils/helpers.js';
import { listRecords, createRecords } from '../airtable/client.js';
import { REELS_TABLE, REELS_FIELDS, ANALYSES_TABLE, ANALYSES_FIELDS } from '../airtable/schema.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(__dir, '..', '..', 'reports');

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const MODEL  = CLAUDE_MODEL;
const BATCH  = CLAUDE_BATCH_SIZE;

// ─────────────────────────────────────────────────────────────
// PART 1: PER-REEL BATCH ANALYSIS
// Runs on every daily scrape. Fast, lightweight, per-video.
// ─────────────────────────────────────────────────────────────

const BATCH_SYSTEM = `You are a content intelligence analyst specializing in short-form video for Instagram creators.
Your job is to analyze reel data and extract structured insights that help creators understand what topics perform well.
Always return valid JSON arrays only — no markdown, no explanation, no preamble.${frameworkSystemSuffix()}`;

const BATCH_PROMPT = (reels) => `Analyze these ${reels.length} Instagram reels and return a JSON array with one object per reel (same order as input).

Each object must have:
- "mainTopic": primary topic in 3-5 words (e.g. "Cold outreach scripts", "Morning routine habits")
- "topics": array of 2-4 short topic tags (e.g. ["Sales", "Mindset", "Entrepreneurship"])
- "contentType": one of: "Educational", "Story", "Motivational", "How-to", "Rant", "Case study", "List", "Q&A", "Other"
- "hook": the exact opening line or first sentence from transcript/caption (max 20 words)
- "hookType": one of: "Contrarian", "Question", "Curiosity Gap", "Pattern Interrupt", "Confession", "Direct Address", "Statistic", "Analogy", "Other"
- "hookCategory": one of: "Problem-Based", "Belief-Shifting", "Identity-Shifting", "Fear-Based", "Desire-Based", "Clarity-Based"
- "keyPoints": array of exactly 3 bullet points — the core insights or takeaways
- "targetAudience": who this reel speaks to (e.g. "Early-stage founders", "Sales reps", "Gym beginners")
- "emotionalTone": one of: "Inspiring", "Educational", "Entertaining", "Controversial", "Vulnerable", "Direct", "Humorous"
- "ctaType": call-to-action type if present — one of: "Comment", "Link", "Apply", "Join", "DM", "Subscribe", "None", "Other"
- "ctaPlacement": one of: "Early", "Mid", "End", "Multiple", "None"

If transcript is empty, analyze from caption only and note that in keyPoints.

Input reels:
${JSON.stringify(reels.map((r, i) => ({
  index: i,
  caption: r.caption?.slice(0, 500) || '',
  transcript: r.transcript?.slice(0, 1500) || '',
  views: r.videoViewCount,
  likes: r.likesCount,
  comments: r.commentsCount,
})))}

Return ONLY a JSON array of ${reels.length} objects. No other text.`;

function emptyAnalysis() {
  return {
    mainTopic:      'Unknown',
    topics:         [],
    contentType:    'Other',
    hook:           '',
    hookType:       'Other',
    hookCategory:   'Other',
    keyPoints:      ['Analysis unavailable — Claude parse error'],
    targetAudience: 'Unknown',
    emotionalTone:  'Unknown',
    ctaType:        'None',
    ctaPlacement:   'None',
  };
}

async function analyzeBatch(reels) {
  const msg = await client.messages.create({
    model:      MODEL,
    max_tokens: 4096,
    system:     BATCH_SYSTEM,
    messages:   [{ role: 'user', content: BATCH_PROMPT(reels) }],
  });

  const text = msg.content.map(c => c.text || '').join('');
  try {
    return parseClaudeJSON(text);
  } catch (e) {
    logger.warn('Claude returned unparseable JSON — returning empty analysis');
    logger.warn('Raw response:', text.slice(0, 300));
    return reels.map(() => emptyAnalysis());
  }
}

/**
 * Per-reel batch analysis. Called by the daily Trigger.dev scrape task.
 * Returns reels with `aiAnalysis` property attached.
 * Skips reels where aiAnalyzed = true (token guard handled upstream in sync.js).
 */
export async function analyzeReels(reels) {
  logger.info(`Claude: analyzing ${reels.length} reels in batches of ${BATCH}`);

  const results = [];
  for (let i = 0; i < reels.length; i += BATCH) {
    const chunk = reels.slice(i, i + BATCH);
    logger.step(`Claude: batch ${Math.floor(i / BATCH) + 1} — ${chunk.length} reels`);

    // Log reels with no transcript so the user knows analysis is caption-only
    chunk.filter(r => !r.transcript?.trim()).forEach(r =>
      logger.info(`No transcript for reel ${r.reelId} — caption-only analysis`)
    );

    try {
      const analysis = await analyzeBatch(chunk);
      chunk.forEach((reel, j) => {
        results.push({ ...reel, aiAnalysis: analysis[j] || emptyAnalysis() });
      });
    } catch (e) {
      logger.error(`Claude batch failed — storing reels without analysis`, e.message);
      chunk.forEach(reel => {
        results.push({ ...reel, aiAnalysis: emptyAnalysis() });
      });
    }

    if (i + BATCH < reels.length) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  logger.success(`Claude: analysis complete for ${results.length} reels`);
  return results;
}


// ─────────────────────────────────────────────────────────────
// PART 1.5: RUN SUMMARY — saved to Analyses table after each creator scrape
// ─────────────────────────────────────────────────────────────

/**
 * Generate a markdown summary report for a creator run and save it to Airtable + disk.
 * Fetches analyzed reels directly from Airtable so metrics are accurate.
 *
 * @param {string} creatorName      — Instagram username
 * @param {string} creatorRecordId  — Airtable record ID in Creators table
 */
export async function generateAndSaveRunSummary(creatorName, creatorRecordId) {
  logger.info(`Generating run summary for @${creatorName}...`);

  // Fetch analyzed reels FROM Airtable — in-memory reels have no metrics applied
  let records;
  try {
    records = await listRecords(REELS_TABLE, {
      filterFormula: `AND(${airtableFormula(REELS_FIELDS.username, creatorName)}, {${REELS_FIELDS.aiAnalyzed}} = TRUE())`,
      fields: [
        REELS_FIELDS.engagementScore, REELS_FIELDS.engagementTier,
        REELS_FIELDS.views, REELS_FIELDS.likes,
        REELS_FIELDS.mainTopic, REELS_FIELDS.hookType, REELS_FIELDS.contentType,
      ],
    });
  } catch (e) {
    logger.warn(`Could not fetch reels from Airtable for summary: ${e.message}`);
    return;
  }

  if (!records.length) {
    logger.info(`No analyzed reels found for @${creatorName} — skipping summary`);
    return;
  }

  const tiers = { HIGH: 0, MID: 0, LOW: 0 };
  const topicCount = {};
  const hookTypeCount = {};
  const contentTypeCount = {};
  let totalScore = 0;
  let totalViews = 0;
  let totalLikes = 0;

  for (const rec of records) {
    const f = rec.fields;
    const tier = f[REELS_FIELDS.engagementTier] || 'LOW';
    tiers[tier] = (tiers[tier] || 0) + 1;
    totalScore += parseFloat(f[REELS_FIELDS.engagementScore] || 0);
    totalViews += parseInt(f[REELS_FIELDS.views] || 0);
    totalLikes += parseInt(f[REELS_FIELDS.likes] || 0);

    const topic = f[REELS_FIELDS.mainTopic];
    if (topic && topic !== 'Unknown') topicCount[topic] = (topicCount[topic] || 0) + 1;

    const hookType = f[REELS_FIELDS.hookType];
    if (hookType && hookType !== 'Other') hookTypeCount[hookType] = (hookTypeCount[hookType] || 0) + 1;

    const ct = f[REELS_FIELDS.contentType];
    if (ct && ct !== 'Other') contentTypeCount[ct] = (contentTypeCount[ct] || 0) + 1;
  }

  const n = records.length;
  const avgScore = (totalScore / n).toFixed(4);
  const avgViews = Math.round(totalViews / n).toLocaleString();
  const topTopics = Object.entries(topicCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topHooks  = Object.entries(hookTypeCount).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const topTypes  = Object.entries(contentTypeCount).sort((a, b) => b[1] - a[1]).slice(0, 3);

  const summaryPrompt = `Write a concise markdown analysis report for @${creatorName}'s Instagram Reels.

Data:
- Reels analyzed: ${n}
- Engagement tiers: ${tiers.HIGH} HIGH, ${tiers.MID} MID, ${tiers.LOW} LOW
- Avg engagement score: ${avgScore}
- Avg views: ${avgViews}
- Avg likes: ${Math.round(totalLikes / n).toLocaleString()}
- Top topics: ${topTopics.map(([t, c]) => `${t} (${c})`).join(', ')}
- Top hook types: ${topHooks.map(([h, c]) => `${h} (${c})`).join(', ')}
- Top content types: ${topTypes.map(([t, c]) => `${t} (${c})`).join(', ')}

Write a markdown report with these sections:
## Summary
## Engagement Breakdown
## Top Topics
## Hook & Content Patterns
## Key Takeaways (3 bullet points)

Be specific and actionable. Max 400 words.`;

  let reportContent = '';
  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: summaryPrompt }],
    });
    reportContent = msg.content.map(c => c.text || '').join('').trim();
  } catch (e) {
    reportContent = `## Summary\n@${creatorName} — ${n} reels analyzed on ${toISODate()}\n\n## Engagement Breakdown\n- HIGH: ${tiers.HIGH} | MID: ${tiers.MID} | LOW: ${tiers.LOW}\n- Avg score: ${avgScore} | Avg views: ${avgViews}\n\n## Top Topics\n${topTopics.map(([t, c]) => `- ${t} (${c} reels)`).join('\n')}\n\n## Hook Types\n${topHooks.map(([h, c]) => `- ${h} (${c} reels)`).join('\n')}`;
  }

  // Write markdown file to reports/
  let reportFile = '';
  try {
    if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
    const baseName = `analysis-${creatorName}-${toISODate()}`;
    let filePath = join(REPORTS_DIR, `${baseName}.md`);
    let version = 2;
    while (existsSync(filePath)) {
      filePath = join(REPORTS_DIR, `${baseName}-v${version++}.md`);
    }
    writeFileSync(filePath, reportContent, 'utf8');
    reportFile = filePath;
    logger.success(`Report written: ${filePath}`);
  } catch (e) {
    logger.warn(`Could not write report file: ${e.message}`);
  }

  // Save to Analyses table
  try {
    await createRecords(ANALYSES_TABLE, [{
      [ANALYSES_FIELDS.creatorName]:   creatorName,
      [ANALYSES_FIELDS.analysisType]:  'Gap',
      [ANALYSES_FIELDS.runAt]:         toISODate(),
      [ANALYSES_FIELDS.completed]:     true,
      [ANALYSES_FIELDS.reelsAnalyzed]: n,
      [ANALYSES_FIELDS.reportContent]: reportContent,
      [ANALYSES_FIELDS.reportFile]:    reportFile,
      [ANALYSES_FIELDS.modelUsed]:     MODEL,
      [ANALYSES_FIELDS.notes]:         `Tiers: ${tiers.HIGH}H/${tiers.MID}M/${tiers.LOW}L | Avg score: ${avgScore} | Avg views: ${avgViews}`,
    }]);
    logger.success(`Run summary saved to Analyses table for @${creatorName}`);
  } catch (e) {
    logger.warn(`Could not save run summary to Analyses table: ${e.message}`);
  }
}


// ─────────────────────────────────────────────────────────────
// PART 2: POPPY DEEP ANALYSIS PROTOCOL
// Run manually or on-demand for a single creator's reel set.
// 5 sequential prompts — each builds on the last.
// Call: analyzeCreatorDeep(reels, creatorName, icp)
// ─────────────────────────────────────────────────────────────

const DEEP_SYSTEM = `You are a world-class content strategist and short-form video analyst.
You analyze Instagram creator content with precision and depth to extract replicable formulas.
Always return valid JSON only — no markdown, no explanation, no preamble.${frameworkSystemSuffix()}`;

/**
 * PROMPT A — Hook Analysis
 * Extracts exact hook text, type, and category for every reel.
 * Finds patterns across the full set.
 */
async function runHookAnalysis(reels, creatorName) {
  logger.step(`Deep analysis A: Hook Analysis for @${creatorName}`);

  const prompt = `I'm analyzing @${creatorName}'s ${reels.length} Instagram reels.

For EACH reel, extract:
1. "exactHook": the exact opening line/hook (first 5-10 words from transcript, or caption if no transcript)
2. "hookType": one of: Contrarian, Question, Curiosity Gap, Pattern Interrupt, Confession, Direct Address, Statistic, Analogy, Other
3. "hookCategory": one of: Problem-Based, Belief-Shifting, Identity-Shifting, Fear-Based, Desire-Based, Clarity-Based

Then provide "patterns":
- "topHookTypes": top 3 most common hook types with count
- "topHookCategories": top 3 most common hook categories with count
- "repeatingPattern": any hook structure appearing in 5+ videos (describe it, or null)
- "mostUniqueHook": the single most standout hook and why

Input reels (index, caption, transcript excerpt):
${JSON.stringify(reels.map((r, i) => ({
  index: i,
  caption: (r.caption || '').slice(0, 300),
  transcript: (r.transcript || '').slice(0, 400),
})))}

Return JSON: { "perReel": [...], "patterns": {...} }`;

  const msg = await client.messages.create({
    model: MODEL, max_tokens: 4096, system: DEEP_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });

  return parseClaudeJSON(msg.content.map(c => c.text || '').join(''));
}

/**
 * PROMPT B — Title/Caption Analysis
 * Word count, structure, power words, timeframes, numbers.
 */
async function runTitleAnalysis(reels, creatorName) {
  logger.step(`Deep analysis B: Title/Caption Analysis for @${creatorName}`);

  const prompt = `For @${creatorName}'s ${reels.length} reels, analyze the captions/titles.

For EACH reel:
1. "wordCount": number of words in caption
2. "structure": one of: Question, How-To, Contrarian, Number-Based, Benefit-Based, Problem-Based, Story-Based, Other
3. "powerWords": array of strong/emotional words used (e.g. "Secret", "Never", "Why", "Finally", "Stop")
4. "hasTimeframe": true/false — does caption mention a time period?
5. "timeframe": the timeframe if present (e.g. "30 days", "in 2024"), else null
6. "hasNumber": true/false
7. "number": the number if present, else null

Then "patterns":
- "avgWordCount": average word count across all captions
- "mostCommonStructure": most frequent structure type
- "top5PowerWords": top 5 power words by frequency
- "timeframeUsage": percentage of captions using a timeframe
- "numberUsage": percentage of captions using a number
- "titleFormulas": array of 3 exact reusable title templates (e.g. "How I [result] in [timeframe] without [obstacle]")

Input reels:
${JSON.stringify(reels.map((r, i) => ({
  index: i,
  caption: (r.caption || '').slice(0, 400),
})))}

Return JSON: { "perReel": [...], "patterns": {...} }`;

  const msg = await client.messages.create({
    model: MODEL, max_tokens: 4096, system: DEEP_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });

  return parseClaudeJSON(msg.content.map(c => c.text || '').join(''));
}

/**
 * PROMPT C — Video Structure Analysis
 * Hook length, problem setup, framework naming, proof type, CTA.
 * Uses a representative sample (up to 15 reels with transcripts).
 */
async function runStructureAnalysis(reels, creatorName) {
  logger.step(`Deep analysis C: Structure Analysis for @${creatorName}`);

  // Prioritize reels that have transcripts — structure analysis needs content
  const withTranscript = reels.filter(r => r.transcript && r.transcript.length > 100);
  const sample = withTranscript.slice(0, 15);

  if (sample.length < 3) {
    logger.warn('Structure analysis: fewer than 3 reels have transcripts — results may be limited');
  }

  const prompt = `For @${creatorName}, analyze the video structure of these ${sample.length} reels.

For EACH reel:
1. "hookLength": one of: "0-5s", "5-15s", "15s+"
2. "hasProblemSetup": true/false
3. "problemSetupLength": approximate length if present — "brief" / "moderate" / "extended" / null
4. "frameworkNamed": true/false — does the creator give their method a name? (e.g. "The X System")
5. "frameworkName": the name if present, else null
6. "proofType": one of: Story, Case Study, Data/Statistic, Personal Experience, Client Result, None
7. "ctaType": one of: Comment, Link, Apply, Join, DM, Subscribe, None, Other
8. "ctaPlacement": one of: Early, Mid, End, Multiple, None

Then "patterns":
- "mostCommonHookLength": most frequent hook length
- "problemSetupRate": percentage of videos with a problem setup
- "frameworkNamingRate": percentage that name their framework
- "mostCommonProofType": most frequent proof type
- "ctaPattern": describe the CTA pattern in 1 sentence
- "idealVideoArc": describe the creator's typical video structure in 3-4 sentences

Input reels:
${JSON.stringify(sample.map((r, i) => ({
  index: i,
  transcript: (r.transcript || '').slice(0, 800),
  views: r.views,
  engagementTier: r.engagementTier,
})))}

Return JSON: { "perReel": [...], "patterns": {...} }`;

  const msg = await client.messages.create({
    model: MODEL, max_tokens: 4096, system: DEEP_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });

  return parseClaudeJSON(msg.content.map(c => c.text || '').join(''));
}

/**
 * PROMPT D — Engagement Correlation
 * Which hook types, content types, and structures correlate with HIGH engagement.
 * Uses the per-reel batch analysis results + engagement metrics.
 */
async function runEngagementCorrelation(reels, hookAnalysis, titleAnalysis, creatorName) {
  logger.step(`Deep analysis D: Engagement Correlation for @${creatorName}`);

  // Build a flat dataset combining metrics + analysis results
  const dataset = reels.map((r, i) => ({
    index:           i,
    engagementScore: r.engagementScore,
    engagementTier:  r.engagementTier,
    views:           r.views,
    hookType:        hookAnalysis.perReel?.[i]?.hookType || 'Unknown',
    hookCategory:    hookAnalysis.perReel?.[i]?.hookCategory || 'Unknown',
    titleStructure:  titleAnalysis.perReel?.[i]?.structure || 'Unknown',
    hasNumber:       titleAnalysis.perReel?.[i]?.hasNumber || false,
    hasTimeframe:    titleAnalysis.perReel?.[i]?.hasTimeframe || false,
  }));

  const prompt = `Analyze what drives HIGH engagement for @${creatorName} based on this dataset of ${dataset.length} reels.

Identify:
1. "topHookTypesForHigh": which hook types appear most in HIGH engagement tier reels
2. "topHookCategoriesForHigh": which hook categories appear most in HIGH tier
3. "titleStructureCorrelation": which title structures correlate with higher engagement scores
4. "numberImpact": do titles with numbers perform better or worse? (compare avg engagement)
5. "timeframeImpact": do titles with timeframes perform better or worse?
6. "bestPerformingFormula": 1-2 sentence description of the combination that most reliably produces HIGH engagement
7. "avoidFormula": 1-2 sentence description of combinations that correlate with LOW engagement

Dataset:
${JSON.stringify(dataset)}

Return JSON with those 7 keys.`;

  const msg = await client.messages.create({
    model: MODEL, max_tokens: 2048, system: DEEP_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });

  return parseClaudeJSON(msg.content.map(c => c.text || '').join(''));
}

/**
 * PROMPT E — Synthesis
 * Final strategic summary. The "so what" of the entire protocol.
 */
async function runSynthesis(reels, creatorName, icp, hookAnalysis, titleAnalysis, structureAnalysis, correlationAnalysis) {
  logger.step(`Deep analysis E: Synthesis for @${creatorName}`);

  const prompt = `Based on the complete analysis of @${creatorName}'s ${reels.length} reels, provide a strategic synthesis.

Analysis summaries available:
- Hook patterns: ${JSON.stringify(hookAnalysis.patterns)}
- Title patterns: ${JSON.stringify(titleAnalysis.patterns)}
- Structure patterns: ${JSON.stringify(structureAnalysis.patterns)}
- Engagement correlations: ${JSON.stringify(correlationAnalysis)}

Answer:
1. "contentFormula": what is @${creatorName}'s content formula? (2 sentences max)
2. "memorabilityFactors": top 3 reasons their videos are memorable
3. "singleBestThing": if you could copy ONE thing about their approach, what is it?
4. "uniquePhilosophy": their unique angle or worldview (e.g. "systems over tactics", "proof over hype")
5. "contentFeel": one of: Educational, Entertaining, Transformational, Inspirational, Tactical
6. "audienceWants": if their audience is "${icp || 'creators and entrepreneurs'}", what do they actually want from this content? (3 bullet points)
7. "replicableTemplates": 3 fill-in-the-blank templates for hooks, titles, or video arcs that a new creator could use immediately
8. "redFlags": anything this creator does that should NOT be copied (e.g. relies on personal fame, specific niche that doesn't transfer)

Return JSON with those 8 keys.`;

  const msg = await client.messages.create({
    model: MODEL, max_tokens: 2048, system: DEEP_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });

  return parseClaudeJSON(msg.content.map(c => c.text || '').join(''));
}

/**
 * MAIN EXPORT: Full Poppy Deep Analysis Protocol
 *
 * Runs 5 sequential Claude prompts on a creator's reel set.
 * Use for on-demand deep research — NOT the daily scrape.
 * Call this from research-agent.js or trigger/research-report.ts
 *
 * @param {Array}  reels        — normalized + metrics-enriched reels for ONE creator
 * @param {string} creatorName  — Instagram username
 * @param {string} icp          — ideal customer profile (optional, improves synthesis)
 * @returns {Object}            — full structured report
 */
export async function analyzeCreatorDeep(reels, creatorName, icp = '') {
  logger.info(`Starting Poppy Deep Analysis for @${creatorName} (${reels.length} reels)`);

  if (reels.length < 10) {
    logger.warn(`Deep analysis works best with 20-30 reels. Only ${reels.length} provided.`);
  }

  const report = {
    creatorName,
    reelCount:   reels.length,
    analyzedAt:  new Date().toISOString(),
    icp,
  };

  try {
    // A: Hook analysis
    report.hookAnalysis = await runHookAnalysis(reels, creatorName);
    await new Promise(r => setTimeout(r, 2000));

    // B: Title analysis
    report.titleAnalysis = await runTitleAnalysis(reels, creatorName);
    await new Promise(r => setTimeout(r, 2000));

    // C: Structure analysis
    report.structureAnalysis = await runStructureAnalysis(reels, creatorName);
    await new Promise(r => setTimeout(r, 2000));

    // D: Engagement correlation (uses outputs from A + B)
    report.correlationAnalysis = await runEngagementCorrelation(
      reels, report.hookAnalysis, report.titleAnalysis, creatorName
    );
    await new Promise(r => setTimeout(r, 2000));

    // E: Synthesis (uses all previous outputs)
    report.synthesis = await runSynthesis(
      reels, creatorName, icp,
      report.hookAnalysis, report.titleAnalysis,
      report.structureAnalysis, report.correlationAnalysis
    );

    logger.success(`Poppy Deep Analysis complete for @${creatorName}`);
  } catch (e) {
    logger.error(`Deep analysis failed at a prompt step`, e.message);
    report.error = e.message;
  }

  return report;
}
