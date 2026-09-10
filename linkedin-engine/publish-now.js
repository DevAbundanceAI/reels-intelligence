/**
 * linkedin-engine/publish-now.js — publish one Posts row (or every Due
 * row) right now, via the same claim -> publish -> write-back sequence
 * the Trigger.dev worker uses (both call publishOne() below and
 * src/linkedin/api.js's publishRecord). Used for the first live tests
 * and as the GitHub Actions fallback entry point if Trigger.dev is
 * inconvenient (`--due`, run on a 15-minute cron).
 *
 * Refuses to touch any row whose Status is not Approved — this is a
 * publisher, not a review tool.
 *
 * Usage:
 *   node linkedin-engine/publish-now.js --record recXXXXXXXXXXXXXX
 *   node linkedin-engine/publish-now.js --due
 */

import {
  LINKEDIN_BASE_ID, LINKEDIN_POSTS_TABLE, LINKEDIN_ACCESS_TOKEN, LINKEDIN_PERSON_URN,
  LINKEDIN_TOKEN_EXPIRES_AT,
} from '../src/config.js';
import { getRecord, listRecords, updateRecords } from '../src/airtable/xbase.js';
import { publishRecord, TokenExpiredError } from '../src/linkedin/api.js';
import { logger } from './shared.js';

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (flag) => { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : null; };
  return { record: get('--record'), due: a.includes('--due') };
}

function requireToken() {
  if (!LINKEDIN_ACCESS_TOKEN || !LINKEDIN_PERSON_URN) {
    throw new Error('LINKEDIN_ACCESS_TOKEN / LINKEDIN_PERSON_URN not set. Run linkedin-engine/auth.js first.');
  }
  if (LINKEDIN_TOKEN_EXPIRES_AT) {
    const daysLeft = (new Date(LINKEDIN_TOKEN_EXPIRES_AT) - Date.now()) / 86400000;
    if (daysLeft < 0) throw new Error(`LINKEDIN_ACCESS_TOKEN expired ${Math.abs(daysLeft).toFixed(1)} days ago. Re-run linkedin-engine/auth.js.`);
    if (daysLeft < 7) logger.warn(`LinkedIn token expires in ${daysLeft.toFixed(1)} days — re-run auth.js soon.`);
  }
}

async function publishOne(row) {
  if (row.fields.Status !== 'Approved') {
    logger.warn(`${row.id} — Status is "${row.fields.Status}", not Approved. Skipping (this tool never publishes an unapproved row).`);
    return { skipped: true };
  }

  await updateRecords(LINKEDIN_BASE_ID, LINKEDIN_POSTS_TABLE, [{
    id: row.id,
    fields: { Status: 'Publishing', 'Publish Attempted At': new Date().toISOString() },
  }]);

  try {
    const { urn, url } = await publishRecord(row, { token: LINKEDIN_ACCESS_TOKEN, personUrn: LINKEDIN_PERSON_URN });
    await updateRecords(LINKEDIN_BASE_ID, LINKEDIN_POSTS_TABLE, [{
      id: row.id,
      fields: { Status: 'Posted', 'Post URN': urn, 'Posted URL': url, 'Posted At': new Date().toISOString() },
    }]);
    logger.success(`${row.id} — Posted: ${url}`);
    return { posted: true, url };
  } catch (e) {
    const detail = e instanceof TokenExpiredError ? e.message : e.message;
    const existingNotes = row.fields['Review Notes'] || '';
    await updateRecords(LINKEDIN_BASE_ID, LINKEDIN_POSTS_TABLE, [{
      id: row.id,
      fields: {
        Status: 'Needs Fix',
        'Review Notes': `${existingNotes}${existingNotes ? '\n' : ''}[publish error ${new Date().toISOString()}] ${detail}`,
      },
    }]);
    logger.error(`${row.id} — publish failed: ${detail}`);
    throw e;
  }
}

async function main() {
  const { record, due } = parseArgs();
  requireToken();

  if (record) {
    const row = await getRecord(LINKEDIN_BASE_ID, LINKEDIN_POSTS_TABLE, record);
    await publishOne(row);
    return;
  }

  if (due) {
    const nowIso = new Date().toISOString();
    const rows = await listRecords(LINKEDIN_BASE_ID, LINKEDIN_POSTS_TABLE, {
      filterFormula: `AND({Status} = "Approved", {Posting Method} = "Auto", IS_BEFORE({Scheduled Time}, "${nowIso}"))`,
    });
    if (!rows.length) { logger.info('publish-now --due: nothing pending'); return; }
    logger.info(`publish-now --due: ${rows.length} row(s) due`);
    for (const row of rows) {
      try { await publishOne(row); } catch { /* already logged + written back inside publishOne */ }
    }
    return;
  }

  throw new Error('Pass --record recXXXXXXXXXXXXXX or --due');
}

main().catch(e => { logger.error(e.message); process.exit(1); });
