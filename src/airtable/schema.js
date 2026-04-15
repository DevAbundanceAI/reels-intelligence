import {
  AIRTABLE_REELS_TABLE,
  AIRTABLE_CREATORS_TABLE,
  AIRTABLE_RUNS_TABLE,
  AIRTABLE_ANALYSES_TABLE,
  AIRTABLE_CREATOR_ANALYSIS_TABLE,
  AIRTABLE_CUMULATIVE_ANALYSIS_TABLE,
  AIRTABLE_YT_VIDEOS_TABLE,
  AIRTABLE_YT_CREATORS_TABLE,
  AIRTABLE_YT_RUNS_TABLE,
  AIRTABLE_CONTENT_IDEAS_TABLE,
  AIRTABLE_CONTENT_CALENDAR_TABLE,
} from '../config.js';

/**
 * Airtable field names — single source of truth.
 * If you rename a field in Airtable, change it here only.
 */

export const REELS_TABLE = AIRTABLE_REELS_TABLE;

export const REELS_FIELDS = {
  // Identity
  reelId:         'Reel ID',          // Single line text — unique, used for dedup
  url:            'URL',              // URL field
  username:       'Username',         // Single line text
  creatorRecord:  'Creator',          // Link to Creators table

  // Content
  caption:        'Caption',          // Long text
  transcript:     'Transcript',       // Long text
  hashtags:       'Hashtags',         // Long text (comma-separated)
  hook:           'Hook',             // Single line text — exact opening words
  audioTitle:     'Audio',            // Single line text

  // Metrics
  views:          'Views',            // Number — videoViewCount (raw impressions)
  playCount:      'Play Count',       // Number — videoPlayCount (includes replays)
  likes:          'Likes',            // Number
  comments:       'Comments',         // Number
  shares:         'Shares',           // Number
  duration:       'Duration (s)',     // Number

  // Engagement scoring
  engagementScore: 'Engagement Score',  // Number (4 decimal places)
  likeRatio:       'Like Ratio %',      // Number
  commentRatio:    'Comment Ratio %',   // Number
  engagementTier:  'Engagement Tier',   // Single select: HIGH / MID / LOW

  // AI Analysis — per-reel (daily batch)
  mainTopic:      'Main Topic',       // Single line text
  topics:         'Topics',           // Long text (comma-separated)
  contentType:    'Content Type',     // Single select: Educational, Story, Motivational, How-to, Rant, Case study, List, Q&A, Other
  keyPoints:      'Key Points',       // Long text
  targetAudience: 'Target Audience',  // Single line text
  emotionalTone:  'Emotional Tone',   // Single select: Inspiring, Educational, Entertaining, Controversial, Vulnerable, Direct, Humorous

  // Hook classification — Poppy Protocol Prompt A
  hookType:       'Hook Type',        // Single select: Contrarian, Question, Curiosity Gap, Pattern Interrupt, Confession, Direct Address, Statistic, Analogy, Other
  hookCategory:   'Hook Category',    // Single select: Problem-Based, Belief-Shifting, Identity-Shifting, Fear-Based, Desire-Based, Clarity-Based

  // CTA classification — Poppy Protocol Prompt D
  ctaType:        'CTA Type',         // Single select: Comment, Link, Apply, Join, DM, Subscribe, None, Other
  ctaPlacement:   'CTA Placement',    // Single select: Early, Mid, End, Multiple, None

  // Content longevity
  contentLongevity: 'Content Longevity', // Single select: Evergreen / Trending / Time-Sensitive

  // Content format depth
  contentFormat:  'Content Format',   // Single select: Short-form / Long-form (Claude-classified)

  // Analysis status — token-save guard
  aiAnalyzed:     'AI Analyzed',      // Checkbox — true only after Claude completes successfully
  analyzedAt:     'Analyzed At',      // Date — when Claude analysis ran
  analysisModel:  'Analysis Model',   // Single line text — e.g. claude-opus-4-5 (audit trail)

  // Timestamps
  publishedAt:    'Published At',     // Date
  scrapedAt:      'Scraped At',       // Date
};

export const CREATORS_TABLE = AIRTABLE_CREATORS_TABLE;

export const CREATORS_FIELDS = {
  username:       'Username',         // Single line text — unique
  displayName:    'Display Name',     // Single line text
  niche:          'Niche',            // Single line text
  active:         'Active',           // Checkbox
  lastScraped:    'Last Scraped',     // Date
  totalReels:     'Total Reels',      // Number
  followersCount: 'Followers',        // Number — fetched via Apify profile scraper
};

export const RUNS_TABLE = AIRTABLE_RUNS_TABLE;

export const RUNS_FIELDS = {
  runAt:        'Run At',             // Date
  creatorsRun:  'Creators Run',       // Number
  reelsFetched: 'Reels Fetched',      // Number
  reelsNew:     'Reels New',          // Number
  errors:       'Errors',             // Long text
  status:       'Status',             // Single select: Success / Partial / Failed
};

export const ANALYSES_TABLE = AIRTABLE_ANALYSES_TABLE;

export const ANALYSES_FIELDS = {
  creator:       'Creator',          // Link to Creators table (creator record ID)
  creatorName:   'Creator Name',     // Single line text — username for display / aggregate label
  analysisType:  'Analysis Type',    // Single select: Deep, Gap, Hooks, Trending, Compare, Aggregate
  runAt:         'Run At',           // Date+time (ISO string)
  completed:     'Completed',        // Checkbox — true when report finished writing
  reelsAnalyzed: 'Reels Analyzed',   // Number
  icp:           'ICP',              // Single line text — ideal customer profile (deep analysis)
  reportContent: 'Report Content',   // Long text — full markdown report stored here
  modelUsed:     'Model Used',       // Single line text — e.g. claude-opus-4-5
  notes:         'Notes',            // Long text — any extra context
  reportFile:    'Report File',      // Single line text — local file path (NOTE: Airtable attachment
                                     // fields require a public URL; this stores local path only)
};

// ── Creator Analysis — one record per creator, upserted after each run ──────
export const CREATOR_ANALYSIS_TABLE = AIRTABLE_CREATOR_ANALYSIS_TABLE;

export const CREATOR_ANALYSIS_FIELDS = {
  username:           'Username',           // Single line text — unique key
  displayName:        'Display Name',       // Single line text
  totalReels:         'Total Reels',        // Number
  avgEngagementScore: 'Avg Engagement Score', // Number (4 decimal)
  highCount:          'HIGH Count',         // Number
  midCount:           'MID Count',          // Number
  lowCount:           'LOW Count',          // Number
  topTopics:          'Top Topics',         // Long text — comma-separated
  topHookTypes:       'Top Hook Types',     // Long text
  topContentTypes:    'Top Content Types',  // Long text
  contentFormula:     'Content Formula',    // Long text — Claude-generated (populated by deep analysis)
  keyTakeaways:       'Key Takeaways',      // Long text — Claude-generated
  reportFile:         'Report File',        // Single line text — local file path
  lastAnalyzed:       'Last Analyzed',      // Date
};

// ── Cumulative Analysis — one record per multi-creator run ───────────────────
export const CUMULATIVE_ANALYSIS_TABLE = AIRTABLE_CUMULATIVE_ANALYSIS_TABLE;

export const CUMULATIVE_ANALYSIS_FIELDS = {
  runDate:                  'Run Date',                      // Date
  creators:                 'Creators',                      // Long text — comma-separated
  creatorCount:             'Creator Count',                 // Number
  totalReels:               'Total Reels',                   // Number
  avgEngagementScore:       'Avg Engagement Score',          // Number (4 decimal)
  topPerformingCreator:     'Top Performing Creator',        // Single line text
  topTopics:                'Top Topics',                    // Long text
  crossCreatorHookPatterns: 'Cross-Creator Hook Patterns',   // Long text
  reportContent:            'Report Content',                // Long text
  reportFile:               'Report File',                   // Single line text
};

// ── YouTube Videos — one record per video, mirrors Reels table ───────────────
export const YT_VIDEOS_TABLE = AIRTABLE_YT_VIDEOS_TABLE;

export const YT_VIDEOS_FIELDS = {
  // Identity
  videoId:         'Video ID',          // Single line text — unique dedup key (yt-dlp id)
  url:             'URL',               // URL field
  channelUsername: 'Channel Username',  // Single line text — @handle without @
  channelId:       'Channel ID',        // Single line text — UCxxx from yt-dlp
  creatorRecord:   'Creator',           // Link to YouTube Creators table

  // Content
  title:           'Title',             // Single line text
  description:     'Description',       // Long text
  tags:            'Tags',              // Long text — comma-separated
  transcript:      'Transcript',        // Long text — from yt-dlp auto-captions
  hook:            'Hook',              // Single line text — opening line (filled by Claude)

  // Metrics
  views:           'Views',             // Number precision:0
  likes:           'Likes',             // Number precision:0
  comments:        'Comments',          // Number precision:0
  duration:        'Duration (s)',      // Number precision:0
  isShort:         'Is Short',          // Checkbox — duration ≤ 180s or /shorts/ URL

  // Engagement scoring (YouTube thresholds: HIGH ≥3%, MID ≥1%, LOW <1% like ratio)
  engagementScore: 'Engagement Score',  // Number precision:4
  likeRatio:       'Like Ratio %',      // Number precision:4
  commentRatio:    'Comment Ratio %',   // Number precision:4
  engagementTier:  'Engagement Tier',   // Single select: HIGH / MID / LOW

  // AI Analysis — same fields as Reels for cross-platform compatibility
  mainTopic:       'Main Topic',        // Single line text
  topics:          'Topics',            // Long text — comma-separated
  contentType:     'Content Type',      // Single select: Educational, Story, etc.
  keyPoints:       'Key Points',        // Long text
  targetAudience:  'Target Audience',   // Single line text
  emotionalTone:   'Emotional Tone',    // Single select
  hookType:        'Hook Type',         // Single select
  hookCategory:    'Hook Category',     // Single select
  ctaType:         'CTA Type',          // Single select
  ctaPlacement:    'CTA Placement',     // Single select

  // Content longevity
  contentLongevity: 'Content Longevity', // Single select: Evergreen / Trending / Time-Sensitive

  // Content format depth
  contentFormat:   'Content Format',    // Single select: Short-form / Long-form (Claude-classified)

  // Analysis guard — token-save flag (mirrors Reels pattern)
  aiAnalyzed:      'AI Analyzed',       // Checkbox — true only after Claude succeeds
  analyzedAt:      'Analyzed At',       // Date
  analysisModel:   'Analysis Model',    // Single line text

  // Timestamps
  publishedAt:     'Published At',      // Date
  scrapedAt:       'Scraped At',        // Date
};

// ── YouTube Creators — one record per tracked channel ────────────────────────
export const YT_CREATORS_TABLE = AIRTABLE_YT_CREATORS_TABLE;

export const YT_CREATORS_FIELDS = {
  channelUsername: 'Channel Username',  // Single line text — unique key
  displayName:     'Display Name',      // Single line text
  channelId:       'Channel ID',        // Single line text
  niche:           'Niche',             // Single line text
  active:          'Active',            // Checkbox
  subscriberCount: 'Subscribers',       // Number precision:0
  totalVideos:     'Total Videos',      // Number precision:0
  lastScraped:     'Last Scraped',      // Date
};

// ── YouTube Runs — log of every YouTube pipeline run ─────────────────────────
export const YT_RUNS_TABLE = AIRTABLE_YT_RUNS_TABLE;

export const YT_RUNS_FIELDS = {
  runAt:          'Run At',             // Date
  creatorsRun:    'Creators Run',       // Number precision:0
  videosFetched:  'Videos Fetched',     // Number precision:0
  videosNew:      'Videos New',         // Number precision:0
  errors:         'Errors',             // Long text
  status:         'Status',             // Single select: Success / Partial / Failed
};

// ── Content Ideas — generated marketing ideas, Airtable is the brain ─────────
export const CONTENT_IDEAS_TABLE = AIRTABLE_CONTENT_IDEAS_TABLE;

export const CONTENT_IDEAS_FIELDS = {
  title:                   'Title',                     // Single line text — idea title
  platform:                'Platform',                  // Single select: Instagram / YouTube / Both
  contentType:             'Content Type',              // Single select: Educational, Story, etc.
  status:                  'Status',                    // Single select: Idea / Approved / Scheduled / Published / Archived

  // Inspiration source
  sourcePlatform:          'Source Platform',           // Single select: Instagram / YouTube / Cross-Platform
  sourceCreators:          'Source Creators',           // Long text — comma-separated @handles
  sourceTopics:            'Source Topics',             // Long text
  trendBasis:              'Trend Basis',               // Long text — why this is timely

  // Content blueprint
  hook:                    'Hook',                      // Single line text — suggested opening
  hookType:                'Hook Type',                 // Single select
  keyPoints:               'Key Points',                // Long text — 3 bullet content arc
  cta:                     'CTA',                       // Single line text
  targetAudience:          'Target Audience',           // Single line text

  // Predicted performance
  predictedTier:           'Predicted Tier',            // Single select: HIGH / MID / LOW
  confidenceScore:         'Confidence Score',          // Number precision:2 — 0–100
  competitorEngagementAvg: 'Competitor Avg Engagement', // Number precision:4

  // Meta
  generatedAt:             'Generated At',              // Date
  generatedBy:             'Generated By',              // Single line text — which agent mode
  notes:                   'Notes',                     // Long text
};

// ── Content Calendar — scheduled posts linked to Content Ideas ────────────────
export const CONTENT_CALENDAR_TABLE = AIRTABLE_CONTENT_CALENDAR_TABLE;

export const CONTENT_CALENDAR_FIELDS = {
  // Scheduling
  scheduledDate:   'Scheduled Date',    // Date
  platform:        'Platform',          // Single select: Instagram / YouTube / Both
  postTime:        'Post Time',         // Single line text — e.g. "9:00 AM EST"

  // Content reference
  ideaTitle:       'Idea Title',        // Single line text — denormalized for quick view
  ideaRecord:      'Idea',              // Link to Content Ideas table
  contentType:     'Content Type',      // Single select

  // Production status
  status:          'Status',            // Single select: Planning / In Production / Ready / Posted / Skipped
  assignedTo:      'Assigned To',       // Single line text

  // Brief
  brief:           'Brief',             // Long text — full production brief
  hook:            'Hook',              // Single line text — finalized hook
  keyPoints:       'Key Points',        // Long text
  cta:             'CTA',               // Single line text

  // Post-publish actuals
  actualViews:     'Actual Views',      // Number precision:0
  actualLikes:     'Actual Likes',      // Number precision:0
  actualEngScore:  'Actual Eng Score',  // Number precision:4

  // Meta
  createdAt:       'Created At',        // Date
  notes:           'Notes',             // Long text
};
