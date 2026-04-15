#!/usr/bin/env node
/**
 * bootstrap-v3.js — Creates YouTube + Marketing tables introduced in the v3 update.
 * Idempotent: safe to re-run, skips existing tables/fields.
 *
 * New tables:
 *   YouTube Videos, YouTube Creators, YouTube Runs,
 *   Content Ideas, Content Calendar
 *
 * Run: node agents/bootstrap-v3.js
 */

import '../src/config.js';
import { AIRTABLE_API_KEY, AIRTABLE_BASE_ID } from '../src/config.js';
import { logger } from '../src/utils/logger.js';

const BASE_URL = `https://api.airtable.com/v0/meta/bases/${AIRTABLE_BASE_ID}`;
const headers  = {
  Authorization:  `Bearer ${AIRTABLE_API_KEY}`,
  'Content-Type': 'application/json',
};

async function req(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${path}: ${JSON.stringify(json)}`);
  return json;
}

async function addField(tableId, field) {
  try {
    await req('POST', `/tables/${tableId}/fields`, field);
    logger.info(`    + ${field.name}`);
  } catch (e) {
    if (e.message.includes('DUPLICATE_FIELD_NAME') || e.message.includes('already exists')) {
      logger.info(`    ~ ${field.name} already exists`);
    } else {
      logger.warn(`    ✗ ${field.name}: ${e.message}`);
    }
  }
}

async function ensureTable(existingMap, name, description, fields) {
  if (existingMap[name]) {
    logger.info(`~ Table "${name}" already exists`);
    const tableId       = existingMap[name].id;
    const existingFields = existingMap[name].fields.map(f => f.name);
    const toAdd         = fields.filter(f => !existingFields.includes(f.name));
    if (toAdd.length > 0) {
      logger.info(`  Adding ${toAdd.length} missing field(s)...`);
      for (const field of toAdd) await addField(tableId, field);
    } else {
      logger.info(`  All fields present`);
    }
    return tableId;
  }

  const [first, ...rest] = fields;
  const result = await req('POST', '/tables', { name, description, fields: [first] });
  logger.success(`✓ Table "${name}" created (${result.id})`);
  for (const field of rest) await addField(result.id, field);
  return result.id;
}

// ─── Field definitions ────────────────────────────────────────────────────────

const SINGLE_SELECTS = {
  engagementTier: { name: 'Engagement Tier', type: 'singleSelect', options: { choices: [
    { name: 'HIGH', color: 'greenBright' },
    { name: 'MID',  color: 'yellowBright' },
    { name: 'LOW',  color: 'redBright' },
  ]}},
  contentType: { name: 'Content Type', type: 'singleSelect', options: { choices: [
    { name: 'Educational' }, { name: 'Story' }, { name: 'Motivational' },
    { name: 'How-to' }, { name: 'Rant' }, { name: 'Case study' },
    { name: 'List' }, { name: 'Q&A' }, { name: 'Other' },
  ]}},
  emotionalTone: { name: 'Emotional Tone', type: 'singleSelect', options: { choices: [
    { name: 'Inspiring' }, { name: 'Educational' }, { name: 'Entertaining' },
    { name: 'Controversial' }, { name: 'Vulnerable' }, { name: 'Direct' }, { name: 'Humorous' },
  ]}},
  hookType: { name: 'Hook Type', type: 'singleSelect', options: { choices: [
    { name: 'Contrarian' }, { name: 'Question' }, { name: 'Curiosity Gap' },
    { name: 'Pattern Interrupt' }, { name: 'Confession' }, { name: 'Direct Address' },
    { name: 'Statistic' }, { name: 'Analogy' }, { name: 'Other' },
  ]}},
  hookCategory: { name: 'Hook Category', type: 'singleSelect', options: { choices: [
    { name: 'Problem-Based' }, { name: 'Belief-Shifting' }, { name: 'Identity-Shifting' },
    { name: 'Fear-Based' }, { name: 'Desire-Based' }, { name: 'Clarity-Based' },
  ]}},
  ctaType: { name: 'CTA Type', type: 'singleSelect', options: { choices: [
    { name: 'Comment' }, { name: 'Link' }, { name: 'Apply' }, { name: 'Join' },
    { name: 'DM' }, { name: 'Subscribe' }, { name: 'None' }, { name: 'Other' },
  ]}},
  ctaPlacement: { name: 'CTA Placement', type: 'singleSelect', options: { choices: [
    { name: 'Early' }, { name: 'Mid' }, { name: 'End' }, { name: 'Multiple' }, { name: 'None' },
  ]}},
  runStatus: { name: 'Status', type: 'singleSelect', options: { choices: [
    { name: 'Success', color: 'greenBright' },
    { name: 'Partial', color: 'yellowBright' },
    { name: 'Failed',  color: 'redBright' },
  ]}},
  platform: { name: 'Platform', type: 'singleSelect', options: { choices: [
    { name: 'Instagram' }, { name: 'YouTube' }, { name: 'Both' },
  ]}},
  sourcePlatform: { name: 'Source Platform', type: 'singleSelect', options: { choices: [
    { name: 'Instagram' }, { name: 'YouTube' }, { name: 'Cross-Platform' },
  ]}},
  ideaStatus: { name: 'Status', type: 'singleSelect', options: { choices: [
    { name: 'Idea',      color: 'grayBright'   },
    { name: 'Approved',  color: 'blueBright'   },
    { name: 'Scheduled', color: 'yellowBright' },
    { name: 'Published', color: 'greenBright'  },
    { name: 'Archived',  color: 'redBright'    },
  ]}},
  predictedTier: { name: 'Predicted Tier', type: 'singleSelect', options: { choices: [
    { name: 'HIGH', color: 'greenBright' },
    { name: 'MID',  color: 'yellowBright' },
    { name: 'LOW',  color: 'redBright' },
  ]}},
  calendarStatus: { name: 'Status', type: 'singleSelect', options: { choices: [
    { name: 'Planning',      color: 'grayBright'   },
    { name: 'In Production', color: 'blueBright'   },
    { name: 'Ready',         color: 'tealBright'   },
    { name: 'Posted',        color: 'greenBright'  },
    { name: 'Skipped',       color: 'redBright'    },
  ]}},
};

const num0  = (name) => ({ name, type: 'number',       options: { precision: 0 } });
const num4  = (name) => ({ name, type: 'number',       options: { precision: 4 } });
const num2  = (name) => ({ name, type: 'number',       options: { precision: 2 } });
const text  = (name) => ({ name, type: 'singleLineText' });
const long  = (name) => ({ name, type: 'multilineText' });
const check = (name) => ({ name, type: 'checkbox',     options: { icon: 'check', color: 'greenBright' } });
const date  = (name) => ({ name, type: 'date',         options: { dateFormat: { name: 'iso' } } });

// ─── YouTube Videos ──────────────────────────────────────────────────────────
const ytVideosFields = [
  text('Video ID'),
  text('URL'),
  text('Channel Username'),
  text('Channel ID'),
  text('Title'),
  long('Description'),
  long('Tags'),
  long('Transcript'),
  text('Hook'),
  num0('Views'),
  num0('Likes'),
  num0('Comments'),
  num0('Duration (s)'),
  check('Is Short'),
  num4('Engagement Score'),
  num4('Like Ratio %'),
  num4('Comment Ratio %'),
  SINGLE_SELECTS.engagementTier,
  text('Main Topic'),
  long('Topics'),
  SINGLE_SELECTS.contentType,
  long('Key Points'),
  text('Target Audience'),
  SINGLE_SELECTS.emotionalTone,
  SINGLE_SELECTS.hookType,
  SINGLE_SELECTS.hookCategory,
  SINGLE_SELECTS.ctaType,
  SINGLE_SELECTS.ctaPlacement,
  check('AI Analyzed'),
  date('Analyzed At'),
  text('Analysis Model'),
  date('Published At'),
  date('Scraped At'),
];

// ─── YouTube Creators ─────────────────────────────────────────────────────────
const ytCreatorsFields = [
  text('Channel Username'),
  text('Display Name'),
  text('Channel ID'),
  text('Niche'),
  check('Active'),
  num0('Subscribers'),
  num0('Total Videos'),
  date('Last Scraped'),
];

// ─── YouTube Runs ─────────────────────────────────────────────────────────────
const ytRunsFields = [
  date('Run At'),
  num0('Creators Run'),
  num0('Videos Fetched'),
  num0('Videos New'),
  long('Errors'),
  SINGLE_SELECTS.runStatus,
];

// ─── Content Ideas ────────────────────────────────────────────────────────────
const contentIdeasFields = [
  text('Title'),
  SINGLE_SELECTS.platform,
  SINGLE_SELECTS.contentType,
  SINGLE_SELECTS.ideaStatus,
  SINGLE_SELECTS.sourcePlatform,
  long('Source Creators'),
  long('Source Topics'),
  long('Trend Basis'),
  text('Hook'),
  SINGLE_SELECTS.hookType,
  long('Key Points'),
  text('CTA'),
  text('Target Audience'),
  SINGLE_SELECTS.predictedTier,
  num2('Confidence Score'),
  num4('Competitor Avg Engagement'),
  date('Generated At'),
  text('Generated By'),
  long('Notes'),
];

// ─── Content Calendar ─────────────────────────────────────────────────────────
// Note: the 'Idea' link field is added AFTER Content Ideas table is created
const contentCalendarFields = [
  date('Scheduled Date'),
  SINGLE_SELECTS.platform,
  text('Post Time'),
  text('Idea Title'),
  SINGLE_SELECTS.contentType,
  SINGLE_SELECTS.calendarStatus,
  text('Assigned To'),
  long('Brief'),
  text('Hook'),
  long('Key Points'),
  text('CTA'),
  num0('Actual Views'),
  num0('Actual Likes'),
  num4('Actual Eng Score'),
  date('Created At'),
  long('Notes'),
];

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  logger.info(`Base ID: ${AIRTABLE_BASE_ID}`);
  logger.info('');

  // Fetch existing tables
  const { tables: existingTables } = await req('GET', '/tables');
  const existingMap = Object.fromEntries(existingTables.map(t => [t.name, t]));

  logger.info('── YouTube Videos');
  const ytVideosId = await ensureTable(existingMap, 'YouTube Videos',
    'YouTube video metadata and AI analysis — mirrors the Reels table',
    ytVideosFields);

  logger.info('');
  logger.info('── YouTube Creators');
  const ytCreatorsId = await ensureTable(existingMap, 'YouTube Creators',
    'Tracked YouTube channels — parallel to Instagram Creators table',
    ytCreatorsFields);

  logger.info('');
  logger.info('── YouTube Runs');
  await ensureTable(existingMap, 'YouTube Runs',
    'Log of every YouTube pipeline run',
    ytRunsFields);

  logger.info('');
  logger.info('── Content Ideas');
  const ideasTableId = await ensureTable(existingMap, 'Content Ideas',
    'AI-generated content ideas from trend analysis — approve here to add to calendar',
    contentIdeasFields);

  logger.info('');
  logger.info('── Content Calendar');
  const calTableId = await ensureTable(existingMap, 'Content Calendar',
    'Scheduled content linked to approved ideas — fill actuals after posting',
    contentCalendarFields);

  // Add Creator linked record field from YouTube Videos → YouTube Creators
  // (must be done after both tables exist)
  if (ytVideosId && ytCreatorsId) {
    logger.info('  Linking YouTube Videos → YouTube Creators...');
    try {
      await req('POST', `/tables/${ytVideosId}/fields`, {
        name: 'Creator',
        type: 'multipleRecordLinks',
        options: { linkedTableId: ytCreatorsId },
      });
      logger.info('    + Creator (link to YouTube Creators)');
    } catch (e) {
      if (e.message.includes('DUPLICATE_FIELD_NAME') || e.message.includes('already exists')) {
        logger.info('    ~ Creator link already exists');
      } else {
        logger.warn(`    ✗ Creator link: ${e.message}`);
      }
    }
  }

  // Add the linked record field from Content Calendar → Content Ideas
  // (must be done after both tables exist)
  if (ideasTableId && calTableId) {
    logger.info('  Linking Content Calendar → Content Ideas...');
    try {
      await req('POST', `/tables/${calTableId}/fields`, {
        name: 'Idea',
        type: 'multipleRecordLinks',
        options: { linkedTableId: ideasTableId },
      });
      logger.info('    + Idea (link to Content Ideas)');
    } catch (e) {
      if (e.message.includes('DUPLICATE_FIELD_NAME') || e.message.includes('already exists')) {
        logger.info('    ~ Idea link already exists');
      } else {
        logger.warn(`    ✗ Idea link: ${e.message}`);
      }
    }
  }

  logger.info('');
  logger.success('✓ bootstrap-v3 complete — 5 new tables ready');
}

main().catch(e => {
  logger.error(e.message);
  process.exit(1);
});
