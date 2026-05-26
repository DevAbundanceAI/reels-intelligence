import { task, logger } from "@trigger.dev/sdk/v3";
import { scrapeReelUrl }            from "../src/scrapers/apify.js";
import { normalizeReels }           from "../src/scrapers/instagram.js";
import { scrapeTikTokUrl, normalizeTikTokItem } from "../src/scrapers/apify-tiktok.js";
import { scrapeChannelVideosApify } from "../src/scrapers/apify-youtube.js";
import { normalizeApifyVideos }     from "../src/scrapers/youtube.js";
import { analyzeReels }             from "../src/analyzers/claude.js";
import { buildMetrics }             from "../src/utils/engagement.js";
import { buildYTMetrics }           from "../src/utils/youtube-engagement.js";
import { loadBrandDna, renderBrandDnaPrompt } from "../src/brand/dna.js";
import { createRecords, updateRecords } from "../src/airtable/client.js";
import {
  CONTENT_IDEAS_TABLE, TRENDING_SOURCES_TABLE, TRENDING_SOURCES_FIELDS,
} from "../src/airtable/schema.js";
import { toISODate } from "../src/utils/helpers.js";
import { CLAUDE_MODEL } from "../src/config.js";

interface GenPayload {
  sourceRecordId:   string;
  url:              string;
  platformOverride: string | null;
  niche:            string;
}

/**
 * generate-from-url — handles a user-submitted URL.
 *
 * Flow:
 *   1. Detect platform from the URL (or use platformOverride from the form).
 *   2. Scrape that single piece of content with the matching Apify actor.
 *   3. Normalize + compute engagement metrics.
 *   4. Analyze through Brand DNA — produces aiAnalysis + brand-fit fields.
 *   5. Strict-mirror generate a modeled Content Idea row pointing back at
 *      the source URL. Source = "Modeled", Modeling Mode = "Strict Mirror".
 *   6. Mark the Trending Sources row as scraped so the watcher stops picking
 *      it up.
 */
export const generateFromUrl = task({
  id: "generate-from-url",
  maxDuration: 600,

  run: async (payload: GenPayload) => {
    const { sourceRecordId, url, platformOverride, niche } = payload;
    logger.info(`generate-from-url: ${url}`);

    let brandDnaPrompt: string | null = null;
    let brandName = '';
    try {
      const dna = await loadBrandDna();
      brandDnaPrompt = renderBrandDnaPrompt(dna);
      brandName = dna.brandName;
    } catch (e) {
      logger.warn(`Brand DNA not loaded — strict-mirror without brand voice. ${(e as Error).message}`);
    }

    const platform = (platformOverride || detectPlatform(url) || '').toLowerCase();
    logger.info(`Detected platform: ${platform || 'unknown'}`);

    // 1 + 2. Scrape and normalize.
    const item = await scrapeOne(url, platform);
    if (!item) {
      await markFailure(sourceRecordId, "Scrape returned no items");
      return { error: "no items", url };
    }

    // 3. Analyze (single-item batch).
    const adapted = [{ ...item, videoViewCount: item.views, likesCount: item.likes, commentsCount: item.comments }];
    const [analyzed] = await analyzeReels(adapted, { brandDnaPrompt });
    const a = analyzed.aiAnalysis || {};

    // If Brand DNA marked it BANNED, log and exit without generating.
    if (a.brandFit === 'BANNED') {
      logger.warn(`Brand DNA marked source BANNED — skipping idea generation`);
      await markGenerated(sourceRecordId, "BANNED — skipped");
      return { skipped: true, reason: 'BANNED', url };
    }

    // 4. Strict-mirror generate a Content Ideas row.
    const ideaFields = strictMirrorIdea({
      sourceUrl:  url,
      platform,
      niche,
      brandName,
      hook:       a.hook,
      hookType:   a.hookType,
      hookCat:    a.hookCategory,
      mainTopic:  a.mainTopic,
      keyPoints:  a.keyPoints || [],
      cta:        a.ctaType,
      targetAud:  a.targetAudience,
      brandFit:   a.brandFit,
      brandFitReason: a.brandFitReason,
    });
    const created = await createRecords(CONTENT_IDEAS_TABLE, [ideaFields]);
    const ideaId = created[0]?.id;
    logger.info(`Created Content Idea ${ideaId}`);

    // 5. Stamp the Trending Sources row.
    await markGenerated(sourceRecordId, `Generated idea ${ideaId}`);

    return { ideaId, url, brandFit: a.brandFit };
  },
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function detectPlatform(url: string): string {
  if (/tiktok\.com/i.test(url))   return 'tiktok';
  if (/instagram\.com/i.test(url))return 'instagram';
  if (/(youtube\.com|youtu\.be)/i.test(url)) return 'youtube';
  return '';
}

async function scrapeOne(url: string, platform: string): Promise<any | null> {
  if (platform === 'instagram') {
    const raw = await scrapeReelUrl(url, 1);
    const reels = normalizeReels(raw, '');
    if (reels.length === 0) return null;
    const r: any = reels[0];
    return { ...r, ...buildMetrics(r) };
  }
  if (platform === 'tiktok') {
    const raw = await scrapeTikTokUrl(url);
    if (raw.length === 0) return null;
    const t = normalizeTikTokItem(raw[0]);
    return { ...t, ...buildMetrics(t) };
  }
  if (platform === 'youtube') {
    // YouTube actor expects channel handle, not URL — extract video URL pass-through
    const raw = await scrapeChannelVideosApify(url, 1, { shortsOnly: false });
    if (raw.length === 0) return null;
    const v: any = normalizeApifyVideos(raw, '')[0];
    return { ...v, ...buildYTMetrics(v), caption: `${v.title}\n\n${v.description}` };
  }
  return null;
}

function strictMirrorIdea(input: any): Record<string, any> {
  const now = toISODate();
  return {
    'Title':              `MIRROR: ${input.mainTopic || 'Untitled source'}`,
    'Platform':           normalizePlatform(input.platform),
    'Content Type':       'Story',
    'Status':             'Idea',
    'Source Platform':    normalizePlatform(input.platform),
    'Source Topics':      input.mainTopic || '',
    'Trend Basis':        input.brandFitReason || '',
    'Hook':               input.hook || '',
    'Hook Type':          input.hookType || 'Other',
    'Hook Category':      input.hookCat  || 'Clarity-Based',
    'Key Points':         (input.keyPoints || []).join('\n• '),
    'CTA':                input.cta || '',
    'Target Audience':    input.targetAud || '',
    'Predicted Tier':     'MID',
    'Generated At':       now,
    'Generated By':       `generate-from-url ${CLAUDE_MODEL}`,
    'Source':             'Modeled',
    'Source Videos':      input.sourceUrl,
    'Modeled From Niche': input.niche || '',
    'Modeling Mode':      'Strict Mirror',
    'Patterns Borrowed':  `hook:${input.hookType || ''} | cta:${input.cta || ''}`,
    'Notes':              `Brand fit: ${input.brandFit || 'N/A'} — ${input.brandFitReason || ''}\nSource: ${input.sourceUrl}`,
    'Modeled Creators':   '',
  };
}

function normalizePlatform(p: string): string {
  if (!p) return 'Instagram';
  const lc = p.toLowerCase();
  if (lc.includes('tiktok'))   return 'TikTok';
  if (lc.includes('youtube'))  return 'YouTube';
  return 'Instagram';
}

async function markGenerated(sourceRecordId: string, note: string): Promise<void> {
  await updateRecords(TRENDING_SOURCES_TABLE, [{
    id: sourceRecordId,
    fields: {
      [TRENDING_SOURCES_FIELDS.lastScraped]: toISODate(),
    },
  }]);
  logger.info(`Marked source ${sourceRecordId}: ${note}`);
}

async function markFailure(sourceRecordId: string, _note: string): Promise<void> {
  // Still stamp Last Scraped so the watcher stops re-firing.
  await updateRecords(TRENDING_SOURCES_TABLE, [{
    id: sourceRecordId,
    fields: { [TRENDING_SOURCES_FIELDS.lastScraped]: toISODate() },
  }]);
}
