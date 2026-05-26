import { task, logger } from "@trigger.dev/sdk/v3";
import {
  scrapeIgHashtag,
} from "../src/scrapers/apify-ig-hashtag.js";
import {
  scrapeTikTokHashtag, scrapeTikTokProfile, normalizeTikTokItem,
} from "../src/scrapers/apify-tiktok.js";
import { scrapeChannelVideosApify } from "../src/scrapers/apify-youtube.js";
import { normalizeApifyVideos }     from "../src/scrapers/youtube.js";
import { analyzeReels }             from "../src/analyzers/claude.js";
import { buildMetrics }             from "../src/utils/engagement.js";
import { buildYTMetrics }           from "../src/utils/youtube-engagement.js";
import { loadBrandDna, renderBrandDnaPrompt } from "../src/brand/dna.js";
import {
  getExistingTrendingItems,
  classifyTrendingItems,
  syncTrendingItems,
  patchTrendingAnalysis,
  markSourceScraped,
} from "../src/airtable/trending-sync.js";
import {
  trendingTableFor,
  IG_TRENDING_TABLE, IG_TRENDING_FIELDS,
  YT_SHORTS_TRENDING_TABLE, YT_SHORTS_TRENDING_FIELDS,
  YT_LONGFORM_TRENDING_TABLE, YT_LONGFORM_TRENDING_FIELDS,
  TIKTOK_TRENDING_TABLE, TIKTOK_TRENDING_FIELDS,
} from "../src/airtable/schema.js";
import { YT_SHORTS_DURATION_MAX_S } from "../src/config.js";

interface SourcePayload {
  sourceRecordId: string;
  query:          string;
  sourceType:     string;  // "IG Hashtag" / "YT Shorts Trending" / "Niche Creator" / "TikTok Hashtag" / ...
  platform:       string;  // "Instagram" / "YouTube" / "TikTok"
  niche:          string;
  limit:          number;
}

/**
 * scrape-trending-source — per-source discovery worker.
 *
 * Routes by platform:
 *   - Instagram → apify-ig-hashtag.scrapeIgHashtag → IG Trending
 *   - YouTube   → apify-youtube.scrapeChannelVideosApify or trending feed,
 *                 split by duration → YT Shorts Trending / YT Long-form Trending
 *   - TikTok    → apify-tiktok.scrape{Hashtag,Profile} → TikTok Trending
 *
 * Analyzes through Brand DNA when available so trending content gets a
 * brand-fit score on insert.
 */
export const scrapeTrendingSource = task({
  id: "scrape-trending-source",
  maxDuration: 600,

  run: async (payload: SourcePayload) => {
    const { sourceRecordId, query, sourceType, platform, niche, limit } = payload;
    logger.info(`scrape-trending-source: ${platform || sourceType} / ${query}`);

    let brandDnaPrompt: string | null = null;
    try {
      const dna = await loadBrandDna();
      brandDnaPrompt = renderBrandDnaPrompt(dna);
    } catch (e) {
      logger.warn(`Brand DNA not loaded — generic analysis. ${(e as Error).message}`);
    }

    const platformLc = platform?.toLowerCase() || '';
    const typeLc     = sourceType?.toLowerCase() || '';
    let created = 0;

    if (platformLc.includes('instagram') || typeLc.includes('ig hashtag')) {
      created = await runIg(query, niche, limit, brandDnaPrompt);
    } else if (platformLc.includes('tiktok') || typeLc.includes('tiktok')) {
      created = await runTikTok(query, niche, limit, typeLc, brandDnaPrompt);
    } else if (platformLc.includes('youtube') || typeLc.includes('yt')) {
      created = await runYouTube(query, niche, limit, typeLc, brandDnaPrompt);
    } else {
      // Fall back to the table-routing helper
      const table = trendingTableFor(sourceType, platform);
      logger.warn(`Unknown platform/sourceType — defaulting to ${table}, no scrape performed`);
    }

    await markSourceScraped(sourceRecordId);
    logger.info(`Done. ${created} new records.`);
    return { created, sourceRecordId, query };
  },
});

// ─── Platform handlers ──────────────────────────────────────────────────────

async function runIg(query: string, niche: string, limit: number, brandDnaPrompt: string | null): Promise<number> {
  const items = await scrapeIgHashtag(query, limit);
  if (items.length === 0) return 0;

  // Tag lineage and compute metrics
  const enriched: any[] = items.map((it: any) => ({
    ...it,
    ...buildMetrics(it),
    sourceHashtag: query.replace(/^#/, ''),
    niche,
  }));

  const existing = await getExistingTrendingItems(IG_TRENDING_TABLE, IG_TRENDING_FIELDS.id);
  const { brandNew, needsAnalysis } = classifyTrendingItems(enriched, 'reelId', existing);
  if (brandNew.length === 0 && needsAnalysis.length === 0) return 0;

  let createdCount = 0;
  if (brandNew.length > 0) {
    const adapted = brandNew.map((r) => ({ ...r, videoViewCount: r.views, likesCount: r.likes, commentsCount: r.comments }));
    const analyzed = await analyzeReels(adapted, { brandDnaPrompt });
    createdCount = await syncTrendingItems(IG_TRENDING_TABLE, IG_TRENDING_FIELDS, analyzed);
  }
  if (needsAnalysis.length > 0) {
    const adapted = needsAnalysis.map(({ item }) => ({ ...item, videoViewCount: item.views, likesCount: item.likes, commentsCount: item.comments }));
    const analyzed = await analyzeReels(adapted, { brandDnaPrompt });
    await patchTrendingAnalysis(IG_TRENDING_TABLE, IG_TRENDING_FIELDS,
      needsAnalysis.map(({ airtableId }, i) => ({ item: { ...needsAnalysis[i].item, aiAnalysis: analyzed[i]?.aiAnalysis }, airtableId })));
  }
  return createdCount;
}

async function runTikTok(query: string, niche: string, limit: number, typeLc: string, brandDnaPrompt: string | null): Promise<number> {
  const raw = typeLc.includes('profile') || query.startsWith('@')
    ? await scrapeTikTokProfile(query, limit)
    : await scrapeTikTokHashtag(query, limit);
  if (raw.length === 0) return 0;

  const items = raw.map(normalizeTikTokItem).map((it) => ({
    ...it,
    ...buildMetrics({ ...it, views: it.views, likes: it.likes, comments: it.comments }),
    shareRatio: it.views > 0 ? (it.shares / it.views) * 100 : 0,
    source: query,
    niche,
  }));

  const existing = await getExistingTrendingItems(TIKTOK_TRENDING_TABLE, TIKTOK_TRENDING_FIELDS.id);
  const { brandNew, needsAnalysis } = classifyTrendingItems(items, 'reelId', existing);
  if (brandNew.length === 0 && needsAnalysis.length === 0) return 0;

  let createdCount = 0;
  if (brandNew.length > 0) {
    const adapted = brandNew.map((r) => ({ ...r, videoViewCount: r.views, likesCount: r.likes, commentsCount: r.comments }));
    const analyzed = await analyzeReels(adapted, { brandDnaPrompt });
    createdCount = await syncTrendingItems(TIKTOK_TRENDING_TABLE, TIKTOK_TRENDING_FIELDS, analyzed);
  }
  if (needsAnalysis.length > 0) {
    const adapted = needsAnalysis.map(({ item }) => ({ ...item, videoViewCount: item.views, likesCount: item.likes, commentsCount: item.comments }));
    const analyzed = await analyzeReels(adapted, { brandDnaPrompt });
    await patchTrendingAnalysis(TIKTOK_TRENDING_TABLE, TIKTOK_TRENDING_FIELDS,
      needsAnalysis.map(({ airtableId }, i) => ({ item: { ...needsAnalysis[i].item, aiAnalysis: analyzed[i]?.aiAnalysis }, airtableId })));
  }
  return createdCount;
}

async function runYouTube(query: string, niche: string, limit: number, typeLc: string, brandDnaPrompt: string | null): Promise<number> {
  // Treat query as a channel/handle. The hashtag-style YT trending feed lives
  // behind the same Apify actor; pass through and let normalize do the work.
  const raw = await scrapeChannelVideosApify(query, limit, { shortsOnly: false });
  if (raw.length === 0) return 0;

  const videos = normalizeApifyVideos(raw, query).map((v: any) => ({
    ...v,
    ...buildYTMetrics(v),
    source: query,
    niche,
  }));

  // Force routing if sourceType explicitly says shorts/long
  let shorts: any[]; let longform: any[];
  if (typeLc.includes('long')) {
    shorts = []; longform = videos;
  } else if (typeLc.includes('short')) {
    shorts = videos; longform = [];
  } else {
    shorts   = videos.filter((v: any) => (v.duration ?? 0) <= YT_SHORTS_DURATION_MAX_S);
    longform = videos.filter((v: any) => (v.duration ?? 0) >  YT_SHORTS_DURATION_MAX_S);
  }

  const a = await runYtBucket(shorts,   YT_SHORTS_TRENDING_TABLE,   YT_SHORTS_TRENDING_FIELDS,   brandDnaPrompt);
  const b = await runYtBucket(longform, YT_LONGFORM_TRENDING_TABLE, YT_LONGFORM_TRENDING_FIELDS, brandDnaPrompt);
  return a + b;
}

async function runYtBucket(items: any[], table: string, fields: any, brandDnaPrompt: string | null): Promise<number> {
  if (items.length === 0) return 0;
  // Normalize the field map's `id` field to "Video ID" for YT tables.
  const idField = fields.id;
  const existing = await getExistingTrendingItems(table, idField);
  // For YT, key is `videoId` not `reelId`. Adapt the classifier input.
  const adaptedItems = items.map((v: any) => ({ ...v, reelId: v.videoId }));
  const { brandNew, needsAnalysis } = classifyTrendingItems(adaptedItems, 'reelId', existing);

  let createdCount = 0;
  if (brandNew.length > 0) {
    const adapted = brandNew.map((v) => ({ ...v, videoViewCount: v.viewCount, likesCount: v.likeCount, commentsCount: v.commentCount }));
    const analyzed = await analyzeReels(adapted, { brandDnaPrompt });
    // Map fields back: title/description for YT, etc.
    const ytItems = analyzed.map((a: any) => ({
      ...a,
      username:   a.channelUsername,
      caption:    `${a.title}\n\n${a.description}`,
      hashtags:   a.tags ? a.tags.split(', ') : [],
    }));
    createdCount = await syncTrendingItems(table, fields, ytItems);
  }
  if (needsAnalysis.length > 0) {
    const adapted = needsAnalysis.map(({ item }) => ({ ...item, videoViewCount: item.viewCount, likesCount: item.likeCount, commentsCount: item.commentCount }));
    const analyzed = await analyzeReels(adapted, { brandDnaPrompt });
    await patchTrendingAnalysis(table, fields,
      needsAnalysis.map(({ airtableId }, i) => ({
        item: {
          ...needsAnalysis[i].item,
          aiAnalysis: analyzed[i]?.aiAnalysis,
          username: needsAnalysis[i].item.channelUsername,
          caption: `${needsAnalysis[i].item.title}\n\n${needsAnalysis[i].item.description}`,
        },
        airtableId,
      })));
  }
  return createdCount;
}
