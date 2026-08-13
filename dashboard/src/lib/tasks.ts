// Static catalog of every Trigger.dev task the pipeline runs.
// Kept in code (not Airtable) because adding a new task requires a
// deploy anyway — there's no value in making this dynamic.

export type TaskKind = 'cron' | 'orchestrator' | 'worker';

export interface TaskDef {
  id: string;
  label: string;
  kind: TaskKind;
  /** cron expression if applicable, otherwise null (event-triggered) */
  schedule: string | null;
  /** one-line description of what the task does */
  description: string;
  /** Airtable tables this task writes to (for the "today's output" panel) */
  outputs: string[];
  /** Friendly persona name (used by the agent-card view) */
  persona: string;
  /** Short role label shown under the persona name */
  role: string;
}

export const TASKS: TaskDef[] = [
  {
    id: 'watch-creators',
    label: 'Watch IG Creators',
    kind: 'cron',
    schedule: '*/15 * * * *',
    description: 'Polls the Creators table for new active rows and fans out scrape-creator.',
    outputs: [],
    persona: 'Scout',
    role: 'IG Watcher',
  },
  {
    id: 'watch-yt-creators',
    label: 'Watch YT Creators',
    kind: 'cron',
    schedule: '*/15 * * * *',
    description: 'Polls the YouTube Creators table for new active rows and fans out scrape-yt-creator.',
    outputs: [],
    persona: 'Hawk',
    role: 'YT Watcher',
  },
  {
    id: 'watch-trending-sources',
    label: 'Watch Trending Sources',
    kind: 'cron',
    schedule: '*/15 * * * *',
    description: 'Picks up form submissions and Force Rescrape flags from the Trending Sources table.',
    outputs: [],
    persona: 'Pulse',
    role: 'Form Watcher',
  },
  {
    id: 'daily-scrape',
    label: 'Daily IG Scrape',
    kind: 'orchestrator',
    schedule: '0 8 1,15 * *',
    description: 'Bi-weekly IG creator fan-out (1st and 15th @ 08:00 UTC).',
    outputs: [],
    persona: 'Harvest',
    role: 'IG Orchestrator',
  },
  {
    id: 'daily-youtube-scrape',
    label: 'Daily YT Scrape',
    kind: 'orchestrator',
    schedule: '0 9 1,15 * *',
    description: 'Bi-weekly YouTube creator fan-out (1st and 15th @ 09:00 UTC).',
    outputs: [],
    persona: 'Reaper',
    role: 'YT Orchestrator',
  },
  {
    id: 'daily-trending-scrape',
    label: 'Daily Trending Scrape',
    kind: 'orchestrator',
    schedule: '0 7 * * *',
    description: 'Daily trending feed fan-out @ 07:00 UTC.',
    outputs: [],
    persona: 'Tide',
    role: 'Trending Orchestrator',
  },
  {
    id: 'scrape-creator',
    label: 'Scrape IG Creator',
    kind: 'worker',
    schedule: null,
    description: 'Per-creator Instagram scrape via Apify, then Claude analysis with Brand DNA scoring.',
    outputs: ['Reels', 'Creators', 'Analyses'],
    persona: 'Digger',
    role: 'IG Scraper',
  },
  {
    id: 'scrape-yt-creator',
    label: 'Scrape YT Creator',
    kind: 'worker',
    schedule: null,
    description: 'Per-channel YouTube scrape, splits into Shorts and Long-form, runs Brand DNA scoring.',
    outputs: ['YouTube Shorts', 'YouTube Long-form', 'YouTube Creators'],
    persona: 'Miner',
    role: 'YT Scraper',
  },
  {
    id: 'scrape-trending-source',
    label: 'Scrape Trending Source',
    kind: 'worker',
    schedule: null,
    description: 'Scrapes a single trending source (IG hashtag, YT trending, TikTok, or direct URL).',
    outputs: ['IG Trending', 'YT Shorts Trending', 'YT Long-form Trending', 'TikTok Trending'],
    persona: 'Sifter',
    role: 'Trending Router',
  },
  {
    id: 'generate-from-url',
    label: 'Generate From URL',
    kind: 'worker',
    schedule: null,
    description: 'Strict-mirror modeled Content Idea generator from a single submitted URL.',
    outputs: ['Content Ideas'],
    persona: 'Muse',
    role: 'Idea Generator',
  },
];

export function getTask(id: string): TaskDef | undefined {
  return TASKS.find((t) => t.id === id);
}

export const TASKS_BY_KIND: Record<TaskKind, TaskDef[]> = {
  cron: TASKS.filter((t) => t.kind === 'cron'),
  orchestrator: TASKS.filter((t) => t.kind === 'orchestrator'),
  worker: TASKS.filter((t) => t.kind === 'worker'),
};
