/**
 * linkedin-engine/seed-sources.js — upsert seed/sources.json and
 * seed/rules.json into the LinkedIn Engine base (Source Library, Voice &
 * Rules). Idempotent: matches on Title / Rule (the primary field) and
 * updates in place rather than duplicating.
 *
 * Usage:
 *   node linkedin-engine/seed-sources.js [--sources-only|--rules-only] [--dry-run]
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { LINKEDIN_BASE_ID, LINKEDIN_SOURCES_TABLE, LINKEDIN_RULES_TABLE } from '../src/config.js';
import { listRecords, createRecords, updateRecords } from '../src/airtable/xbase.js';
import { SEED_DIR, logger } from './shared.js';

function parseArgs() {
  const a = process.argv.slice(2);
  return {
    sourcesOnly: a.includes('--sources-only'),
    rulesOnly: a.includes('--rules-only'),
    dryRun: a.includes('--dry-run'),
  };
}

function readExcerpt(path, cap = 15000) {
  try {
    let text = readFileSync(path, 'utf8');
    if (path.endsWith('.html')) {
      text = text
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
    }
    return text.slice(0, cap);
  } catch (e) {
    logger.warn(`Could not read ${path}: ${e.message}`);
    return '';
  }
}

async function upsertByField(table, keyField, items, toFields, { dryRun }) {
  const existing = await listRecords(LINKEDIN_BASE_ID, table);
  const byKey = new Map(existing.map(r => [r.fields[keyField], r]));

  const toCreate = [], toUpdate = [];
  for (const item of items) {
    const fields = toFields(item);
    const match = byKey.get(fields[keyField]);
    if (match) toUpdate.push({ id: match.id, fields });
    else toCreate.push(fields);
  }

  logger.info(`${table}: ${toCreate.length} to create, ${toUpdate.length} to update`);
  if (dryRun) {
    toCreate.forEach(f => logger.step(`  + CREATE ${f[keyField]}`));
    toUpdate.forEach(u => logger.step(`  ~ UPDATE ${u.fields[keyField]}`));
    return { created: 0, updated: 0 };
  }

  if (toCreate.length) await createRecords(LINKEDIN_BASE_ID, table, toCreate);
  if (toUpdate.length) await updateRecords(LINKEDIN_BASE_ID, table, toUpdate);
  return { created: toCreate.length, updated: toUpdate.length };
}

async function seedSources({ dryRun }) {
  const path = join(SEED_DIR, 'sources.json');
  if (!existsSync(path)) throw new Error(`Missing ${path}`);
  const sources = JSON.parse(readFileSync(path, 'utf8'));
  const nowIso = new Date().toISOString();

  const result = await upsertByField(LINKEDIN_SOURCES_TABLE, 'Title', sources, (s) => {
    const isConfidential = s.claimSafety === 'Confidential never';
    const raw = (!isConfidential && s.extractRaw && s.path) ? readExcerpt(s.path) : '';
    return {
      Title: s.title,
      'Source Path': s.path || '',
      Repo: s.repo || 'other',
      Kind: s.kind || 'Lesson',
      'Claim Safety': s.claimSafety || 'Needs Ryan OK',
      Substance: isConfidential ? '' : (s.substance || ''),
      'Canonical Numbers': isConfidential ? '' : (s.canonicalNumbers || ''),
      'Angle Ideas': isConfidential ? '' : (s.angleIdeas || []).join('\n'),
      'Raw Excerpt': raw,
      Active: s.active !== false,
      Notes: s.notes || '',
      'Last Seeded At': nowIso,
    };
  }, { dryRun });

  logger.success(`Source Library: ${result.created} created, ${result.updated} updated`);
}

async function seedRules({ dryRun }) {
  const path = join(SEED_DIR, 'rules.json');
  if (!existsSync(path)) throw new Error(`Missing ${path}`);
  const rules = JSON.parse(readFileSync(path, 'utf8'));

  const result = await upsertByField(LINKEDIN_RULES_TABLE, 'Rule', rules, (r) => ({
    Rule: r.rule,
    Type: r.type,
    Detail: r.detail || '',
    'Applies To': r.appliesTo || 'Both',
    'Enforced By': r.enforcedBy || 'Prompt',
    Active: r.active !== false,
    Example: r.example || '',
    Sort: r.sort ?? 0,
  }), { dryRun });

  logger.success(`Voice & Rules: ${result.created} created, ${result.updated} updated`);
}

async function main() {
  const { sourcesOnly, rulesOnly, dryRun } = parseArgs();
  if (dryRun) logger.info('DRY RUN — no writes will be made');
  if (!rulesOnly) await seedSources({ dryRun });
  if (!sourcesOnly) await seedRules({ dryRun });
}

main().catch(e => { logger.error(e.message); console.error(e.stack); process.exit(1); });
