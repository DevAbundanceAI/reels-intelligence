/**
 * Stage 3 — staging for manual posting.
 *
 * Takes a rendered deck (or a generated script) and stages it for review:
 *   - fills the source Content Ideas row (Hook / Key Points / CTA)
 *   - creates a linked Content Calendar row (Status: In Production) whose
 *     Brief carries everything needed to post by hand: caption, hashtags,
 *     first-comment link, file paths
 *   - uploads slide JPEGs to the Calendar row's "Preview" attachment field
 *     (best-effort — warns if the field does not exist yet)
 *
 * Nothing here posts anywhere. Posting is manual by design.
 *
 * Usage:
 *   node content-engine/stage.js --deck queue/deck-<slug>.json
 *   node content-engine/stage.js --script scripts/<date>-<slug>.md --idea recXXX
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { AIRTABLE_API_KEY, AIRTABLE_BASE_ID } from '../src/config.js';
import { createRecords, updateRecords, getRecord } from '../src/airtable/client.js';
import {
  CONTENT_IDEAS_TABLE, CONTENT_CALENDAR_TABLE,
} from '../src/airtable/schema.js';
import { toISODate } from '../src/utils/helpers.js';
import { logger } from '../src/utils/logger.js';
import { ENGINE_DIR, OUTPUT_DIR } from './shared.js';

const PREVIEW_FIELD = 'Preview'; // multipleAttachments — add in Airtable if missing

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  return { deck: get('--deck'), script: get('--script'), idea: get('--idea') };
}

/**
 * Upload one local file into an attachment field via the Airtable content API.
 * Actual cap appears to be well above 5MB (a 5.9MB MP4 uploaded fine, Sep 2026); no confirmed hard limit found, keep files reasonably small anyway.
 */
async function uploadAttachment(recordId, fieldName, filePath) {
  const contentType = filePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const res = await fetch(
    `https://content.airtable.com/v0/${AIRTABLE_BASE_ID}/${recordId}/${encodeURIComponent(fieldName)}/uploadAttachment`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contentType,
        filename: basename(filePath),
        file: readFileSync(filePath).toString('base64'),
      }),
    }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`uploadAttachment ${res.status}: ${body.slice(0, 200)}`);
  }
}

async function stageDeck(deckPath) {
  const deck = JSON.parse(readFileSync(deckPath, 'utf8'));
  const slug = deck.slug;
  const slidesDir = join(OUTPUT_DIR, slug);
  if (!existsSync(slidesDir)) {
    throw new Error(`No rendered slides at ${slidesDir} — run render_slides.py first`);
  }
  const slideFiles = readdirSync(slidesDir).filter(f => f.endsWith('.jpg')).sort()
    .map(f => join(slidesDir, f));
  if (!slideFiles.length) throw new Error(`No .jpg slides in ${slidesDir}`);

  const brief = [
    `CAROUSEL — post by hand (native posting, best reach)`,
    ``,
    `CAPTION:`,
    deck.caption,
    ``,
    `HASHTAGS:`,
    deck.hashtags,
    ``,
    `FIRST COMMENT: ${deck.first_comment_link || '(none)'}`,
    ``,
    `SLIDES (${slideFiles.length}):`,
    ...slideFiles.map(f => `  ${f}`),
    ``,
    `Deck JSON: ${deckPath}`,
    deck.constraintProblems?.length ? `\nCONSTRAINT PROBLEMS (fix before posting):\n- ${deck.constraintProblems.join('\n- ')}` : '',
  ].join('\n');

  const hook = deck.slides?.[0]?.headline || '';
  const cta = deck.slides?.[deck.slides.length - 1]?.body || '';

  // Fill the source idea row so review happens in one place.
  if (deck.ideaRecordId) {
    await updateRecords(CONTENT_IDEAS_TABLE, [{
      id: deck.ideaRecordId,
      fields: { 'Hook': hook, 'CTA': cta },
    }]);
  }

  const [calRow] = await createRecords(CONTENT_CALENDAR_TABLE, [{
    'Idea Title':   deck.title || slug,
    ...(deck.ideaRecordId ? { 'Idea': [deck.ideaRecordId] } : {}),
    'Platform':     'Instagram',
    'Content Type': 'Educational',
    'Status':       'In Production',
    'Brief':        brief,
    'Hook':         hook,
    'Key Points':   (deck.slides || []).map(s => s.headline).filter(Boolean).join('\n• '),
    'CTA':          cta,
    'Created At':   toISODate(),
    'Notes':        `content-engine carousel — ${slug}`,
  }]);
  logger.success(`Content Calendar row ${calRow.id} (In Production)`);

  // Best-effort slide previews.
  try {
    for (const f of slideFiles) {
      await uploadAttachment(calRow.id, PREVIEW_FIELD, f);
    }
    logger.success(`${slideFiles.length} slide previews attached`);
  } catch (e) {
    logger.warn(`Preview upload skipped: ${e.message}`);
    logger.warn(`If the "${PREVIEW_FIELD}" attachment field doesn't exist on ${CONTENT_CALENDAR_TABLE}, add it in Airtable and rerun.`);
  }
  return calRow.id;
}

async function stageScript(scriptPath, ideaRecordId) {
  const script = readFileSync(scriptPath, 'utf8');
  const titleLine = script.split('\n').find(l => l.startsWith('# ')) || '# Untitled';
  const title = titleLine.replace(/^# /, '').trim();
  const hook = (script.match(/### Hook[^\n]*\n+([^\n]+)/) || [])[1] || '';

  if (ideaRecordId) {
    await updateRecords(CONTENT_IDEAS_TABLE, [{
      id: ideaRecordId,
      fields: { 'Hook': hook.replace(/^[">*\s]+/, '').slice(0, 250) },
    }]);
  }

  const [calRow] = await createRecords(CONTENT_CALENDAR_TABLE, [{
    'Idea Title':   title,
    ...(ideaRecordId ? { 'Idea': [ideaRecordId] } : {}),
    'Platform':     'Instagram',
    'Content Type': 'Story',
    'Status':       'In Production',
    'Brief':        `REEL — film from teleprompter script, post natively.\n\nScript file: ${scriptPath}\n\n${script}`,
    'Hook':         hook.slice(0, 250),
    'CTA':          'See CTA tails in script (film both)',
    'Created At':   toISODate(),
    'Notes':        `content-engine video script — ${basename(scriptPath)}`,
  }]);
  logger.success(`Content Calendar row ${calRow.id} (In Production) for script`);
  return calRow.id;
}

async function main() {
  const { deck, script, idea } = parseArgs();
  if (deck) {
    await stageDeck(deck);
  } else if (script) {
    await stageScript(script, idea);
  } else {
    throw new Error('Pass --deck <deck.json> or --script <script.md> [--idea recXXX]');
  }
}

main().catch(e => { logger.error(e.message); process.exit(1); });
