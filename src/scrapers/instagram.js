/**
 * Normalizes raw Apify reel data into a clean, consistent shape.
 * Apify's schema can vary between actor versions — this is the adapter layer.
 */

export function normalizeReel(raw, username) {
  const shortCode = raw.shortCode || raw.id || extractShortCode(raw.url);
  const reelUrl   = shortCode
    ? `https://www.instagram.com/reel/${shortCode}/`
    : (raw.url || '');

  return {
    // Identity
    reelId:      shortCode || raw.id,
    url:         reelUrl,
    username:    raw.ownerUsername || raw.username || username,
    ownerId:     raw.ownerId || raw.ownerProfileUrl || null,

    // Content
    caption:     raw.caption || raw.description || '',
    transcript:  raw.transcript || raw.subtitles || '',
    hashtags:    extractHashtags(raw.caption || raw.description || ''),
    mentions:    extractMentions(raw.caption || raw.description || ''),
    audioTitle:  raw.musicInfo?.songName || raw.audioTitle || null,

    // Metrics (raw counts — scoring happens in engagement.js)
    videoViewCount: parseInt(raw.videoViewCount || raw.playsCount || 0),
    likesCount:     parseInt(raw.likesCount || raw.likeCount || 0),
    commentsCount:  parseInt(raw.commentsCount || raw.commentCount || 0),
    sharesCount:    parseInt(raw.sharesCount || 0),
    duration:       raw.videoDuration || raw.duration || null,

    // Timestamps
    publishedAt:   raw.timestamp || raw.takenAtTimestamp || null,
    scrapedAt:     new Date().toISOString(),
  };
}

export function normalizeReels(rawArray, username) {
  return rawArray
    .map(r => normalizeReel(r, username))
    .filter(r => r.reelId); // drop any that have no ID
}

function extractShortCode(url) {
  if (!url) return null;
  const match = url.match(/\/reel\/([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

function extractHashtags(text) {
  const matches = text.match(/#[\w]+/g) || [];
  return matches.map(h => h.toLowerCase());
}

function extractMentions(text) {
  const matches = text.match(/@[\w.]+/g) || [];
  return matches.map(m => m.toLowerCase());
}
