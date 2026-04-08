#!/usr/bin/env node
/**
 * bootstrap-v2.js — Adds new fields/tables introduced in the v2 feature update.
 * Idempotent: safe to re-run, skips existing tables/fields.
 *
 * New tables: Creator Analysis, Cumulative Analysis
 * New fields: Play Count (Reels), Followers (Creators), Report File (Analyses)
 *
 * Run: node agents/bootstrap-v2.js
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
    const tableId = existingMap[name].id;
    const existingFields = existingMap[name].fields.map(f => f.name);
    const toAdd = fields.filter(f => !existingFields.includes(f.name));
    if (toAdd.length > 0) {
      logger.info(`  Adding ${toAdd.length} missing fields...`);
      for (const field of toAdd) await addField(tableId, field);
    } else {
      logger.info(`  All fields present`);
    }
    return tableId;
  }

  const [first, ...rest] = fields;
  const result = await req('POST', '/tables', { name, description, fields: [first] });
  logger.info(`✓ Table "${name}" created (${result.id})`);
  for (const field of rest) await addField(result.id, field);
  return result.id;
}

const creatorAnalysisFields = [
  { name: 'Username',             type: 'singleLineText' },
  { name: 'Display Name',         type: 'singleLineText' },
  { name: 'Total Reels',          type: 'number',       options: { precision: 0 } },
  { name: 'Avg Engagement Score', type: 'number',       options: { precision: 4 } },
  { name: 'HIGH Count',           type: 'number',       options: { precision: 0 } },
  { name: 'MID Count',            type: 'number',       options: { precision: 0 } },
  { name: 'LOW Count',            type: 'number',       options: { precision: 0 } },
  { name: 'Top Topics',           type: 'multilineText' },
  { name: 'Top Hook Types',       type: 'multilineText' },
  { name: 'Top Content Types',    type: 'multilineText' },
  { name: 'Content Formula',      type: 'multilineText' },
  { name: 'Key Takeaways',        type: 'multilineText' },
  { name: 'Report File',          type: 'singleLineText' },
  { name: 'Last Analyzed',        type: 'date',         options: { dateFormat: { name: 'iso' } } },
];

const cumulativeAnalysisFields = [
  { name: 'Run Date',                    type: 'date',         options: { dateFormat: { name: 'iso' } } },
  { name: 'Creators',                    type: 'multilineText' },
  { name: 'Creator Count',               type: 'number',       options: { precision: 0 } },
  { name: 'Total Reels',                 type: 'number',       options: { precision: 0 } },
  { name: 'Avg Engagement Score',        type: 'number',       options: { precision: 4 } },
  { name: 'Top Performing Creator',      type: 'singleLineText' },
  { name: 'Top Topics',                  type: 'multilineText' },
  { name: 'Cross-Creator Hook Patterns', type: 'multilineText' },
  { name: 'Report Content',              type: 'multilineText' },
  { name: 'Report File',                 type: 'singleLineText' },
];

async function main() {
  logger.info(`Base ID: ${AIRTABLE_BASE_ID}`);
  logger.info('');

  const { tables: existingTables } = await req('GET', '/tables');
  const existingMap = Object.fromEntries(existingTables.map(t => [t.name, t]));

  // --- Add missing fields to existing tables ---

  logger.info('── Reels table: adding Play Count');
  const reelsTable = existingMap['Reels'];
  if (!reelsTable) {
    logger.warn('Reels table not found — run bootstrap.js first');
  } else {
    await addField(reelsTable.id, { name: 'Play Count', type: 'number', options: { precision: 0 } });
  }

  logger.info('── Creators table: adding Followers');
  const creatorsTable = existingMap['Creators'];
  if (!creatorsTable) {
    logger.warn('Creators table not found — run bootstrap.js first');
  } else {
    await addField(creatorsTable.id, { name: 'Followers', type: 'number', options: { precision: 0 } });
  }

  logger.info('── Analyses table: adding Report File');
  const analysesTable = existingMap['Analyses'];
  if (!analysesTable) {
    logger.warn('Analyses table not found — run bootstrap.js first');
  } else {
    await addField(analysesTable.id, { name: 'Report File', type: 'singleLineText' });
  }

  logger.info('');

  // --- Create new tables ---
  logger.info('── Creator Analysis table');
  await ensureTable(existingMap, 'Creator Analysis',
    'Per-creator engagement summary, upserted after each run',
    creatorAnalysisFields);

  logger.info('');
  logger.info('── Cumulative Analysis table');
  await ensureTable(existingMap, 'Cumulative Analysis',
    'Cross-creator summary for runs with 2+ creators',
    cumulativeAnalysisFields);

  logger.info('');
  logger.info('✓ bootstrap-v2 complete');
}

main().catch(e => {
  logger.error(e.message);
  process.exit(1);
});
