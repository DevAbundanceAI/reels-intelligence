/**
 * youtube.js — Normalizes raw yt-dlp JSON into clean video objects.
 * Mirrors the role of instagram.js for Reels.
 *
 * Key design decision:
 *   normalizeVideo() sets `caption` = title + description
 *   This allows the existing analyzeReels() function to work unchanged on YouTube videos,
 *   since analyzeReels() reads `.caption` for the text content.
 */

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Convert yt-dlp's upload_date ('YYYYMMDD') to ISO date string ('YYYY-MM-DD').
 * Returns null if unparseable.
 */
function parseUploadDate(uploadDate) {
  if (!uploadDate || typeof uploadDate !== 'string' || uploadDate.length !== 8) return null;
  return `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`;
}

// ─── Normalizer ──────────────────────────────────────────────────────────────

/**
 * Convert one raw yt-dlp JSON object into a clean, flat video object.
 *
 * @param {object} raw             — single yt-dlp --dump-json entry
 * @param {string} channelUsername — @handle without @ (fallback if raw doesn't have it)
 * @param {string|null} transcript — plain text from fetchVideoTranscript(), or null
 * @returns {object} normalized video
 */
export function normalizeVideo(raw, channelUsername, transcript = null) {
  const title       = raw.title        || '';
  const description = (raw.description || '').slice(0, 5000);
  const duration    = parseInt(raw.duration || 0);

  // Flat-playlist entries use 'url' for the video URL; full dump-json uses 'webpage_url'
  const videoUrl    = raw.webpage_url || raw.url || `https://www.youtube.com/watch?v=${raw.id}`;
  const isShort     = (duration > 0 && duration <= 180) || videoUrl.includes('/shorts/');

  // Flat-playlist has playlist_uploader_id; full dump-json has uploader_id
  const rawHandle   = raw.uploader_id || raw.playlist_uploader_id || '';
  const resolvedHandle = rawHandle.replace(/^@/, '') || channelUsername;

  // Channel ID: full dump-json → channel_id; flat-playlist → playlist_channel_id
  const channelId   = raw.channel_id || raw.playlist_channel_id || '';

  return {
    // Identity
    videoId:         raw.id,
    url:             videoUrl,
    channelUsername: resolvedHandle,
    channelId,

    // Content
    title,
    description,
    tags:            (raw.tags || []).join(', '),
    transcript:      transcript || '',
    hook:            '',   // filled by Claude analysis

    // IMPORTANT: caption alias — analyzeReels() reads .caption for AI analysis text
    caption:         `${title}\n\n${description}`.slice(0, 2000),

    // Raw counts — flat-playlist only has view_count; like_count/comment_count require auth
    viewCount:       parseInt(raw.view_count    || 0),
    likeCount:       parseInt(raw.like_count    || 0),
    commentCount:    parseInt(raw.comment_count || 0),
    duration,
    isShort,

    // Timestamps — flat-playlist may not have upload_date
    publishedAt:     parseUploadDate(raw.upload_date),
    scrapedAt:       new Date().toISOString().split('T')[0],
  };
}

/**
 * Normalize an array of raw yt-dlp objects.
 * Filters out entries with no id (e.g. playlist metadata entries).
 */
export function normalizeVideos(rawArray, channelUsername, transcripts = {}) {
  return rawArray
    .filter(raw => raw && raw.id)
    .map(raw => normalizeVideo(raw, channelUsername, transcripts[raw.id] || null));
}
