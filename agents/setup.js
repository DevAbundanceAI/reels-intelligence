#!/usr/bin/env node
/**
 * setup.js — One-time Airtable schema bootstrap
 *
 * Run this from Claude Code with the Airtable MCP connected.
 * Claude Code will use MCP tools to create all tables and fields.
 *
 * Usage (inside Claude Code session):
 *   "Run agents/setup.js and use the Airtable MCP to create all tables and fields
 *    exactly as defined in src/airtable/schema.js and docs/airtable-schema.md"
 *
 * What Claude Code will do:
 *   1. list_bases — confirm your base ID
 *   2. create_table — create Reels, Creators, Runs tables
 *   3. create_field — every field with correct type and options
 *   4. Confirm each table and field was created
 *
 * This file is a reference prompt — the actual work is done by MCP tools,
 * not by running this script directly.
 */

import '../src/config.js';
import { logger } from '../src/utils/logger.js';
import {
  AIRTABLE_BASE_ID,
  AIRTABLE_REELS_TABLE,
  AIRTABLE_CREATORS_TABLE,
  AIRTABLE_RUNS_TABLE,
  AIRTABLE_ANALYSES_TABLE,
} from '../src/config.js';

logger.info('Airtable Setup — Schema Bootstrap');
logger.info('');
logger.info('This script documents the schema to create via Airtable MCP.');
logger.info('Run it inside a Claude Code session with Airtable MCP connected.');
logger.info('');
logger.info(`Base ID: ${AIRTABLE_BASE_ID}`);
logger.info('');

const schema = {
  [AIRTABLE_REELS_TABLE]: {
    description: 'One record per Instagram reel — primary table',
    fields: [
      // Identity
      { name: 'Reel ID',         type: 'singleLineText',  note: 'Unique — used for dedup' },
      { name: 'URL',             type: 'url' },
      { name: 'Username',        type: 'singleLineText' },

      // Content
      { name: 'Caption',         type: 'multilineText' },
      { name: 'Transcript',      type: 'multilineText' },
      { name: 'Hashtags',        type: 'multilineText',   note: 'Comma-separated' },
      { name: 'Hook',            type: 'singleLineText',  note: 'Exact opening words' },
      { name: 'Audio',           type: 'singleLineText' },

      // Metrics
      { name: 'Views',           type: 'number' },
      { name: 'Likes',           type: 'number' },
      { name: 'Comments',        type: 'number' },
      { name: 'Shares',          type: 'number' },
      { name: 'Duration (s)',    type: 'number' },

      // Engagement scoring
      { name: 'Engagement Score',  type: 'number',  note: '4 decimal places' },
      { name: 'Like Ratio %',      type: 'number' },
      { name: 'Comment Ratio %',   type: 'number' },
      { name: 'Engagement Tier',   type: 'singleSelect', options: ['HIGH', 'MID', 'LOW'] },

      // AI Analysis
      { name: 'Main Topic',      type: 'singleLineText' },
      { name: 'Topics',          type: 'multilineText',  note: 'Comma-separated tags' },
      { name: 'Content Type',    type: 'singleSelect',   options: ['Educational', 'Story', 'Motivational', 'How-to', 'Rant', 'Case study', 'List', 'Q&A', 'Other'] },
      { name: 'Key Points',      type: 'multilineText' },
      { name: 'Target Audience', type: 'singleLineText' },
      { name: 'Emotional Tone',  type: 'singleSelect',   options: ['Inspiring', 'Educational', 'Entertaining', 'Controversial', 'Vulnerable', 'Direct', 'Humorous'] },

      // Hook classification
      { name: 'Hook Type',       type: 'singleSelect',   options: ['Contrarian', 'Question', 'Curiosity Gap', 'Pattern Interrupt', 'Confession', 'Direct Address', 'Statistic', 'Analogy', 'Other'] },
      { name: 'Hook Category',   type: 'singleSelect',   options: ['Problem-Based', 'Belief-Shifting', 'Identity-Shifting', 'Fear-Based', 'Desire-Based', 'Clarity-Based'] },

      // CTA
      { name: 'CTA Type',        type: 'singleSelect',   options: ['Comment', 'Link', 'Apply', 'Join', 'DM', 'Subscribe', 'None', 'Other'] },
      { name: 'CTA Placement',   type: 'singleSelect',   options: ['Early', 'Mid', 'End', 'Multiple', 'None'] },

      // Analysis status — token guard
      { name: 'AI Analyzed',     type: 'checkbox',        note: 'TRUE only after Claude completes — prevents re-analysis' },
      { name: 'Analyzed At',     type: 'date' },
      { name: 'Analysis Model',  type: 'singleLineText',  note: 'e.g. claude-opus-4-5' },

      // Timestamps
      { name: 'Published At',    type: 'date' },
      { name: 'Scraped At',      type: 'date' },
    ]
  },

  [AIRTABLE_CREATORS_TABLE]: {
    description: 'One record per tracked creator',
    fields: [
      { name: 'Username',      type: 'singleLineText',  note: 'Unique Instagram handle' },
      { name: 'Display Name',  type: 'singleLineText' },
      { name: 'Niche',         type: 'singleLineText',  note: 'e.g. Business / Sales' },
      { name: 'Active',        type: 'checkbox',         note: 'Uncheck to pause scraping' },
      { name: 'Last Scraped',  type: 'date' },
      { name: 'Total Reels',   type: 'number' },
    ]
  },

  [AIRTABLE_RUNS_TABLE]: {
    description: 'Log of every Trigger.dev task run',
    fields: [
      { name: 'Run At',         type: 'date' },
      { name: 'Creators Run',   type: 'number' },
      { name: 'Reels Fetched',  type: 'number' },
      { name: 'Reels New',      type: 'number' },
      { name: 'Errors',         type: 'multilineText' },
      { name: 'Status',         type: 'singleSelect', options: ['Success', 'Partial', 'Failed'] },
    ]
  },

  [AIRTABLE_ANALYSES_TABLE]: {
    description: 'One record per research analysis run — stores the full report',
    fields: [
      { name: 'Creator Name',    type: 'singleLineText',  note: 'Instagram username or "All Creators" for aggregate' },
      { name: 'Analysis Type',   type: 'singleSelect',    options: ['Gap', 'Hooks', 'Trending', 'Compare', 'Deep', 'Aggregate'] },
      { name: 'Run At',          type: 'dateTime',         note: 'ISO datetime when analysis completed' },
      { name: 'Completed',       type: 'checkbox',         note: 'TRUE once report is fully written' },
      { name: 'Reels Analyzed',  type: 'number',           note: 'Count of reels included in this analysis' },
      { name: 'ICP',             type: 'singleLineText',  note: 'Ideal customer profile (deep analysis only)' },
      { name: 'Report Content',  type: 'multilineText',   note: 'Full markdown report stored here' },
      { name: 'Model Used',      type: 'singleLineText',  note: 'e.g. claude-opus-4-5' },
      { name: 'Notes',           type: 'multilineText' },
    ]
  }
};

// Print schema for Claude Code to use as reference
logger.info('=== SCHEMA TO CREATE VIA AIRTABLE MCP ===');
logger.info('');
for (const [table, config] of Object.entries(schema)) {
  logger.info(`TABLE: ${table} — ${config.description}`);
  for (const field of config.fields) {
    const opts = field.options ? ` [${field.options.join(', ')}]` : '';
    const note = field.note ? ` // ${field.note}` : '';
    logger.info(`  ${field.name.padEnd(20)} ${field.type}${opts}${note}`);
  }
  logger.info('');
}

logger.info('=== AIRTABLE VIEWS TO CREATE MANUALLY ===');
logger.info('');
logger.info('In the Reels table, create these views:');
logger.info('  Top Performers    filter: Engagement Tier = HIGH, sort: Engagement Score DESC');
logger.info('  By Creator        group by: Username, sort: Published At DESC');
logger.info('  By Topic          group by: Main Topic');
logger.info('  This Week         filter: Published At >= 7 days ago');
logger.info('  Unanalyzed Queue  filter: AI Analyzed = false  — monitor failed analyses');
logger.info('');
logger.info('Paste this output to Claude Code and say:');
logger.info('"Use the Airtable MCP to create all tables and fields exactly as shown above.');
logger.info('This includes the new Analyses table for tracking research runs and storing reports."');
