import { task, logger } from "@trigger.dev/sdk/v3";
import { scrapeChannelVideosApify } from "../src/scrapers/apify-youtube.js";
import { normalizeApifyVideos }     from "../src/scrapers/youtube.js";
import { analyzeReels }             from "../src/analyzers/claude.js";
import { buildYTMetrics }           from "../src/utils/youtube-engagement.js";
import { loadBrandDna, renderBrandDnaPrompt } from "../src/brand/dna.js";
import { listRecords, createRecords, updateRecords } from "../src/airtable/client.js";
import {
  YT_CREATORS_TABLE, YT_CREATORS_FIELDS,
  YT_SHORTS_TABLE, YT_LONGFORM_TABLE, YT_VIDEOS_FIELDS,
} from "../src/airtable/schema.js";
import { YT_SHORTS_DURATION_MAX_S, CLAUDE_MODEL } from "../src/config.js";
import { toISODate, airtableFormula } from "../src/utils/helpers.js";

interface YtCreatorPayload {
  channelUsername:  string;
  displayName:      string;
  niche:            string;
  videoLimit:       number;
  contentTypes:     string[];          // ['Shorts'], ['Long-form'], or both
  fetchTranscripts: boolean;
}

/**
 * scrape-yt-creator — per-channel YouTube worker.
 *
 * Flow:
 *   1. Load Brand DNA (optional — analyzer still works without it).
 *   2. Scrape via Apify YouTube actor (cloud-safe; yt-dlp is blocked on
 *      cloud IPs).
 *   3. Normalize, compute engagement metrics, split into Shorts (≤ duration
 *      cutoff) and Long-form (> cutoff).
 *   4. Dedup against the destination table by Video ID, analyze new+unanalyzed
 *      via Claude with brand-fit scoring when DNA is loaded.
 *   5. Write to YouTube Shorts / YouTube Long-form depending on duration.
 *   6. Upsert the YT Creators row's Last Scraped + Subscribers.
 */
export const scrapeYtCreator = task({
  id: "scrape-yt-creator",
  maxDuration: 600,

  run: async (payload: YtCreatorPayload) => {
    const { channelUsername, displayName, videoLimit, contentTypes } = payload;
    logger.info(`scrape-yt-creator: @${channelUsername} (limit ${videoLimit})`);

    // Brand DNA — optional. Falls back to generic analysis if not loaded.
    let brandDnaPrompt: string | null = null;
    try {
      const dna = await loadBrandDna();
      brandDnaPrompt = renderBrandDnaPrompt(dna);
      logger.info(`Brand DNA loaded: "${dna.brandName}"`);
    } catch (e) {
      logger.warn(`Brand DNA not loaded — generic analysis. ${(e as Error).message}`);
    }

    // 1. Scrape
    const wantShortsOnly = contentTypes && contentTypes.length === 1 && contentTypes[0].toLowerCase().includes('short');
    const raw = await scrapeChannelVideosApify(channelUsername, videoLimit, { shortsOnly: wantShortsOnly });
    logger.info(`Apify: fetched ${raw.length} videos`);

    // 2. Normalize + metrics
    const videos = normalizeApifyVideos(raw, channelUsername)
      .map((v: any) => ({ ...v, ...buildYTMetrics(v) }));

    // 3. Split by duration. If contentTypes restricts to one, drop the others.
    const wantsShorts = !contentTypes || contentTypes.length === 0
      || contentTypes.some((t) => t.toLowerCase().includes('short'));
    const wantsLong = !contentTypes || contentTypes.length === 0
      || contentTypes.some((t) => t.toLowerCase().includes('long'));

    const shorts: any[]   = wantsShorts ? videos.filter((v: any) => (v.duration ?? 0) <= YT_SHORTS_DURATION_MAX_S) : [];
    const longform: any[] = wantsLong   ? videos.filter((v: any) => (v.duration ?? 0) >  YT_SHORTS_DURATION_MAX_S) : [];
    logger.info(`Split: ${shorts.length} shorts / ${longform.length} long-form`);

    // 4 + 5. Sync each bucket.
    const createdShorts = await syncYtBucket(YT_SHORTS_TABLE, shorts, channelUsername, brandDnaPrompt);
    const createdLong   = await syncYtBucket(YT_LONGFORM_TABLE, longform, channelUsername, brandDnaPrompt);

    // 6. Upsert YT Creators row (Last Scraped + Subscribers if we got any).
    const subs = videos[0]?.numberOfSubscribers || 0;
    await upsertYtCreator(payload, subs, videos.length);

    const summary = {
      channelUsername,
      fetched:        videos.length,
      shortsCreated:  createdShorts,
      longCreated:    createdLong,
    };
    logger.info(`Done for @${channelUsername}`, summary);
    return summary;
  },
});

/**
 * Sync a bucket of YouTube videos into its destination table. Dedup by
 * Video ID; analyze new + previously-unanalyzed items.
 */
async function syncYtBucket(table: string, items: any[], channelUsername: string, brandDnaPrompt: string | null): Promise<number> {
  if (items.length === 0) return 0;

  // Read existing by Video ID for this channel.
  const existing = await listRecords(table, {
    filterFormula: airtableFormula(YT_VIDEOS_FIELDS.channelUsername, channelUsername),
    fields: [YT_VIDEOS_FIELDS.videoId, YT_VIDEOS_FIELDS.aiAnalyzed],
  });
  const existingMap = new Map<string, { id: string; analyzed: boolean }>();
  for (const r of existing) {
    const vid = r.fields[YT_VIDEOS_FIELDS.videoId] as string;
    if (vid) existingMap.set(vid, { id: r.id, analyzed: r.fields[YT_VIDEOS_FIELDS.aiAnalyzed] === true });
  }

  const brandNew: any[] = [];
  const reanalyze: { item: any; airtableId: string }[] = [];
  let alreadyDone = 0;
  for (const v of items) {
    const m = existingMap.get(v.videoId);
    if (!m) brandNew.push(v);
    else if (!m.analyzed) reanalyze.push({ item: v, airtableId: m.id });
    else alreadyDone++;
  }
  logger.info(`${table}: ${brandNew.length} new, ${reanalyze.length} unanalyzed, ${alreadyDone} done`);

  // Analyze new
  let createdCount = 0;
  if (brandNew.length > 0) {
    // analyzeReels expects { caption, transcript, videoViewCount, ... }.
    // The normalizer already produces compatible fields except videoViewCount.
    const adapted = brandNew.map((v) => ({ ...v, videoViewCount: v.viewCount, likesCount: v.likeCount, commentsCount: v.commentCount }));
    const analyzed = await analyzeReels(adapted, { brandDnaPrompt });
    const payload = analyzed.map((v: any) => ytVideoToFields(v, true));
    try {
      const created = await createRecords(table, payload);
      createdCount = created.length;
    } catch (e) {
      logger.warn(`Batch write failed (${table}) — retrying one-by-one: ${(e as Error).message}`);
      for (const fields of payload) {
        try { await createRecords(table, [fields]); createdCount++; }
        catch (err) { logger.error(`Skipped ${fields[YT_VIDEOS_FIELDS.videoId]}: ${(err as Error).message}`); }
      }
    }
  }

  // Patch previously-unanalyzed
  if (reanalyze.length > 0) {
    const adapted = reanalyze.map(({ item: v }) => ({ ...v, videoViewCount: v.viewCount, likesCount: v.likeCount, commentsCount: v.commentCount }));
    const analyzed = await analyzeReels(adapted, { brandDnaPrompt });
    const payload = reanalyze.map(({ airtableId }, i) => ({
      id: airtableId,
      fields: ytVideoToFields({ ...reanalyze[i].item, aiAnalysis: analyzed[i]?.aiAnalysis }, true),
    }));
    await updateRecords(table, payload);
  }

  return createdCount;
}

function ytVideoToFields(v: any, analyzed: boolean): Record<string, any> {
  const a = v.aiAnalysis || {};
  const F = YT_VIDEOS_FIELDS;
  const now = toISODate();
  const out: Record<string, any> = {
    [F.videoId]:        v.videoId,
    [F.url]:            v.url,
    [F.channelUsername]:v.channelUsername,
    [F.channelId]:      v.channelId || '',
    [F.title]:          v.title,
    [F.description]:    (v.description || '').slice(0, 100000),
    [F.tags]:           v.tags || '',
    [F.transcript]:     (v.transcript || '').slice(0, 100000),
    [F.hook]:           a.hook || '',
    [F.views]:          v.viewCount,
    [F.likes]:          v.likeCount,
    [F.comments]:       v.commentCount,
    [F.duration]:       v.duration,
    [F.isShort]:        v.isShort === true,
    [F.engagementScore]: v.engagementScore,
    [F.likeRatio]:       v.likeRatio,
    [F.commentRatio]:    v.commentRatio,
    [F.engagementTier]:  v.engagementTier,
    [F.mainTopic]:      a.mainTopic    || '',
    [F.topics]:         (a.topics || []).join(', '),
    [F.contentType]:    a.contentType  || 'Other',
    [F.keyPoints]:      (a.keyPoints || []).join('\n• '),
    [F.targetAudience]: a.targetAudience || '',
    [F.emotionalTone]:  a.emotionalTone  || '',
    [F.hookType]:       a.hookType     || 'Other',
    [F.hookCategory]:   a.hookCategory || 'Other',
    [F.ctaType]:        a.ctaType      || 'None',
    [F.ctaPlacement]:   a.ctaPlacement || 'None',
    ...(a.brandFit       ? { 'Brand Fit':        a.brandFit }       : {}),
    ...(a.brandFitReason ? { 'Brand Fit Reason': a.brandFitReason } : {}),
    [F.aiAnalyzed]:     analyzed,
    [F.analyzedAt]:     analyzed ? now : null,
    [F.analysisModel]:  analyzed ? CLAUDE_MODEL : '',
    [F.publishedAt]:    v.publishedAt || null,
    [F.scrapedAt]:      v.scrapedAt || now,
  };
  return out;
}

async function upsertYtCreator(payload: YtCreatorPayload, subs: number, totalVideos: number): Promise<void> {
  const F = YT_CREATORS_FIELDS;
  const existing = await listRecords(YT_CREATORS_TABLE, {
    filterFormula: airtableFormula(F.channelUsername, payload.channelUsername),
    maxRecords: 1,
  });
  const fields: Record<string, any> = {
    [F.channelUsername]: payload.channelUsername,
    [F.displayName]:     payload.displayName || payload.channelUsername,
    [F.niche]:           payload.niche || '',
    [F.active]:          true,
    [F.lastScraped]:     toISODate(),
  };
  if (subs > 0)         fields[F.subscriberCount] = subs;
  if (totalVideos > 0)  fields[F.totalVideos]     = totalVideos;

  if (existing.length > 0) {
    await updateRecords(YT_CREATORS_TABLE, [{ id: existing[0].id, fields }]);
  } else {
    await createRecords(YT_CREATORS_TABLE, [fields]);
  }
}
