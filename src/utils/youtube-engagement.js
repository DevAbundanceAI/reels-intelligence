/**
 * youtube-engagement.js — YouTube-specific engagement scoring
 *
 * YouTube thresholds differ from Instagram:
 *   HIGH  ≥ 3% like ratio (likes / views × 100)
 *   MID   ≥ 1%
 *   LOW   < 1%
 */

/**
 * Like ratio as a percentage (primary YouTube engagement signal).
 * Views of 0 → 0 to avoid divide-by-zero.
 */
export function computeYTLikeRatio(views, likes) {
  if (!views || views === 0) return 0;
  return (likes / views) * 100;
}

/**
 * Comment ratio as a percentage.
 */
export function computeYTCommentRatio(views, comments) {
  if (!views || views === 0) return 0;
  return (comments / views) * 100;
}

/**
 * Composite engagement score — weighted sum of like ratio and comment ratio.
 * Weights: likes carry more signal than comments on YouTube.
 * Score is expressed as a 0–100 scale (or above for viral content).
 */
export function computeYTEngagementScore(views, likes, comments) {
  const likeRatio    = computeYTLikeRatio(views, likes);
  const commentRatio = computeYTCommentRatio(views, comments);
  // 70% like ratio + 30% comment ratio, both already in percent terms
  return likeRatio * 0.7 + commentRatio * 0.3;
}

/**
 * Map engagement score to HIGH / MID / LOW tier using like-ratio thresholds.
 * @param {number} likeRatio — already in percent (0–100+)
 */
export function ytScoreToTier(likeRatio) {
  if (likeRatio >= 3) return 'HIGH';
  if (likeRatio >= 1) return 'MID';
  return 'LOW';
}

/**
 * Build the full engagement metric block for a normalized video.
 * Expects: { viewCount, likeCount, commentCount }
 * Returns: { views, likes, comments, engagementScore, likeRatio, commentRatio, engagementTier }
 */
export function buildYTMetrics(video) {
  const views    = parseInt(video.viewCount   || 0);
  const likes    = parseInt(video.likeCount   || 0);
  const comments = parseInt(video.commentCount || 0);

  const likeRatio      = computeYTLikeRatio(views, likes);
  const commentRatio   = computeYTCommentRatio(views, comments);
  const engagementScore = computeYTEngagementScore(views, likes, comments);
  const engagementTier = ytScoreToTier(likeRatio);

  return { views, likes, comments, engagementScore, likeRatio, commentRatio, engagementTier };
}
