# Engagement Score Formula

## Formula
```
engagementScore = ((likes + comments × 3) / views) × 100
likeRatio       = (likes / views) × 100
commentRatio    = (comments / views) × 100
```

## Why comments × 3?
Comments signal active intent. Someone typing a response chose to stop scrolling, form a thought, and act. A like is a reflex. This weighting surfaces reels that genuinely stopped people, not just ones that got a casual double-tap.

## Tiers
| Tier | Score     | What it means |
|------|-----------|---------------|
| HIGH | ≥ 5%      | Exceptional — worth studying closely |
| MID  | 2% – 5%  | Solid performer |
| LOW  | < 2%      | Below average — may still be useful for topic research |

## Example
- Views: 500,000 | Likes: 18,000 | Comments: 2,200
- engagementScore = (18,000 + 2,200×3) / 500,000 × 100 = (18,000 + 6,600) / 500,000 × 100 = 4.92% → **MID**

## Adjusting the formula
Edit `src/utils/engagement.js` — the `computeEngagementScore` function.
Change the comment weight (currently `3`) to shift what you value.
