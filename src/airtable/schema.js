import {
  AIRTABLE_REELS_TABLE,
  AIRTABLE_CREATORS_TABLE,
  AIRTABLE_RUNS_TABLE,
  AIRTABLE_ANALYSES_TABLE,
  AIRTABLE_CREATOR_ANALYSIS_TABLE,
  AIRTABLE_CUMULATIVE_ANALYSIS_TABLE,
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
