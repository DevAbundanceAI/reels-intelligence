/**
 * Engagement scoring — all formulas in one place.
 * Comments weighted 3x: they signal intent, not passive scroll.
 */

export function computeEngagementScore(views, likes, comments) {
  if (!views || views === 0) return 0;
  return ((likes + comments * 3) / views) * 100;
}

export function computeLikeRatio(views, likes) {
  if (!views || views === 0) return 0;
  return (likes / views) * 100;
}

export function computeCommentRatio(views, comments) {
  if (!views || views === 0) return 0;
  return (comments / views) * 100;
}

export function scoreToTier(score) {
  if (score >= 5) return 'HIGH';
  if (score >= 2) return 'MID';
  return 'LOW';
}

/**
 * Returns a full metrics object ready to write to Airtable.
 */
export function buildMetrics(reel) {
  const views    = reel.videoViewCount || 0;
  const likes    = reel.likesCount     || 0;
  const comments = reel.commentsCount  || 0;
  const score    = computeEngagementScore(views, likes, comments);

  return {
    views,
    likes,
    comments,
    engagementScore:  parseFloat(score.toFixed(4)),
    likeRatio:        parseFloat(computeLikeRatio(views, likes).toFixed(4)),
    commentRatio:     parseFloat(computeCommentRatio(views, comments).toFixed(4)),
    engagementTier:   scoreToTier(score),
  };
}
