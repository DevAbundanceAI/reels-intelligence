#!/usr/bin/env node
/**
 * bootstrap.js — Creates all Airtable tables and fields via REST API
 * Run once: node agents/bootstrap.js
 */

import '../src/config.js';
import { AIRTABLE_API_KEY, AIRTABLE_BASE_ID } from '../src/config.js';
import { logger } from '../src/utils/logger.js';

const BASE_URL = `https://api.airtable.com/v0/meta/bases/${AIRTABLE_BASE_ID}`;
const headers = {
  Authorization: `Bearer ${AIRTABLE_API_KEY}`,
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

async function createTable(name, description, fields) {
  logger.info(`Creating table: ${name}`);
  try {
    const result = await req('POST', '/tables', { name, description, fields });
    logger.info(`  ✓ ${name} created (id: ${result.id})`);
    return result;
  } catch (e) {
    if (e.message.includes('DUPLICATE_TABLE_NAME') || e.message.includes('already exists')) {
      logger.info(`  ~ ${name} already exists, skipping`);
      return null;
    }
    throw e;
  }
}

async function addField(tableId, field) {
  try {
    await req('POST', `/tables/${tableId}/fields`, field);
    logger.info(`    + ${field.name}`);
  } catch (e) {
    if (e.message.includes('DUPLICATE_FIELD_NAME') || e.message.includes('already exists')) {
      logger.info(`    ~ ${field.name} already exists`);
    } else {
      logger.info(`    ✗ ${field.name}: ${e.message}`);
    }
  }
}

const reelsFields = [
  { name: 'Reel ID', type: 'singleLineText' },
  { name: 'URL', type: 'url' },
  { name: 'Username', type: 'singleLineText' },
  { name: 'Caption', type: 'multilineText' },
  { name: 'Transcript', type: 'multilineText' },
  { name: 'Hashtags', type: 'multilineText' },
  { name: 'Hook', type: 'singleLineText' },
  { name: 'Audio', type: 'singleLineText' },
  { name: 'Views', type: 'number', options: { precision: 0 } },
  { name: 'Likes', type: 'number', options: { precision: 0 } },
  { name: 'Comments', type: 'number', options: { precision: 0 } },
  { name: 'Shares', type: 'number', options: { precision: 0 } },
  { name: 'Duration (s)', type: 'number', options: { precision: 0 } },
  { name: 'Engagement Score', type: 'number', options: { precision: 4 } },
  { name: 'Like Ratio %', type: 'number', options: { precision: 2 } },
  { name: 'Comment Ratio %', type: 'number', options: { precision: 2 } },
  { name: 'Engagement Tier', type: 'singleSelect', options: { choices: [{ name: 'HIGH' }, { name: 'MID' }, { name: 'LOW' }] } },
  { name: 'Main Topic', type: 'singleLineText' },
  { name: 'Topics', type: 'multilineText' },
  { name: 'Content Type', type: 'singleSelect', options: { choices: ['Educational','Story','Motivational','How-to','Rant','Case study','List','Q&A','Other'].map(n => ({ name: n })) } },
  { name: 'Key Points', type: 'multilineText' },
  { name: 'Target Audience', type: 'singleLineText' },
  { name: 'Emotional Tone', type: 'singleSelect', options: { choices: ['Inspiring','Educational','Entertaining','Controversial','Vulnerable','Direct','Humorous'].map(n => ({ name: n })) } },
  { name: 'Hook Type', type: 'singleSelect', options: { choices: ['Contrarian','Question','Curiosity Gap','Pattern Interrupt','Confession','Direct Address','Statistic','Analogy','Other'].map(n => ({ name: n })) } },
  { name: 'Hook Category', type: 'singleSelect', options: { choices: ['Problem-Based','Belief-Shifting','Identity-Shifting','Fear-Based','Desire-Based','Clarity-Based'].map(n => ({ name: n })) } },
  { name: 'CTA Type', type: 'singleSelect', options: { choices: ['Comment','Link','Apply','Join','DM','Subscribe','None','Other'].map(n => ({ name: n })) } },
  { name: 'CTA Placement', type: 'singleSelect', options: { choices: ['Early','Mid','End','Multiple','None'].map(n => ({ name: n })) } },
  { name: 'AI Analyzed', type: 'checkbox', options: { icon: 'check', color: 'greenBright' } },
  { name: 'Analyzed At', type: 'date', options: { dateFormat: { name: 'iso' } } },
  { name: 'Analysis Model', type: 'singleLineText' },
  { name: 'Published At', type: 'date', options: { dateFormat: { name: 'iso' } } },
  { name: 'Scraped At', type: 'date', options: { dateFormat: { name: 'iso' } } },
];

const creatorsFields = [
  { name: 'Username', type: 'singleLineText' },
  { name: 'Display Name', type: 'singleLineText' },
  { name: 'Niche', type: 'singleLineText' },
  { name: 'Active', type: 'checkbox', options: { icon: 'check', color: 'greenBright' } },
  { name: 'Last Scraped', type: 'date', options: { dateFormat: { name: 'iso' } } },
  { name: 'Total Reels', type: 'number', options: { precision: 0 } },
];

const runsFields = [
  { name: 'Run At', type: 'date', options: { dateFormat: { name: 'iso' } } },
  { name: 'Creators Run', type: 'number', options: { precision: 0 } },
  { name: 'Reels Fetched', type: 'number', options: { precision: 0 } },
  { name: 'Reels New', type: 'number', options: { precision: 0 } },
  { name: 'Errors', type: 'multilineText' },
  { name: 'Status', type: 'singleSelect', options: { choices: ['Success','Partial','Failed'].map(n => ({ name: n })) } },
];

const analysesFields = [
  { name: 'Creator Name', type: 'singleLineText' },
  { name: 'Analysis Type', type: 'singleSelect', options: { choices: ['Gap','Hooks','Trending','Compare','Deep','Aggregate'].map(n => ({ name: n })) } },
  { name: 'Run At', type: 'date', options: { dateFormat: { name: 'iso' } } },
  { name: 'Completed', type: 'checkbox', options: { icon: 'check', color: 'greenBright' } },
  { name: 'Reels Analyzed', type: 'number', options: { precision: 0 } },
  { name: 'ICP', type: 'singleLineText' },
  { name: 'Report Content', type: 'multilineText' },
  { name: 'Model Used', type: 'singleLineText' },
  { name: 'Notes', type: 'multilineText' },
];

async function main() {
  logger.info(`Base ID: ${AIRTABLE_BASE_ID}`);
  logger.info('');

  // Each table is created with just its first field (Name), then fields are added
  // because Airtable requires at least one field at creation time
  const tables = [
    { name: 'Reels', description: 'One record per Instagram reel', fields: reelsFields },
    { name: 'Creators', description: 'One record per tracked creator', fields: creatorsFields },
    { name: 'Runs', description: 'Log of every pipeline run', fields: runsFields },
    { name: 'Analyses', description: 'Research analysis runs and reports', fields: analysesFields },
  ];

  // Get existing tables
  const { tables: existingTables } = await req('GET', '/tables');
  const existingMap = Object.fromEntries(existingTables.map(t => [t.name, t]));

  for (const { name, description, fields } of tables) {
    let tableId;

    if (existingMap[name]) {
      logger.info(`~ Table "${name}" already exists`);
      tableId = existingMap[name].id;
      const existingFields = existingMap[name].fields.map(f => f.name);
      const toAdd = fields.filter(f => !existingFields.includes(f.name));
      if (toAdd.length > 0) {
        logger.info(`  Adding ${toAdd.length} missing fields...`);
        for (const field of toAdd) await addField(tableId, field);
      } else {
        logger.info(`  All fields present`);
      }
    } else {
      // Create table with first field
      const [first, ...rest] = fields;
      const result = await req('POST', '/tables', { name, description, fields: [first] });
      tableId = result.id;
      logger.info(`✓ Table "${name}" created`);
      // Add remaining fields
      for (const field of rest) await addField(tableId, field);
    }
  }

  logger.info('');
  logger.info('✓ Schema bootstrap complete');
  logger.info('Run npm run test-airtable to verify');
}

main().catch(e => {
  logger.error(e.message);
  process.exit(1);
});
