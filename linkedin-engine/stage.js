/**
 * linkedin-engine/stage.js — take generated queue/ files (and, for
 * carousels, their rendered output/) and create/update Posts rows in the
 * LinkedIn Engine base, with Preview + Carousel PDF attachments and
 * Sources links. Writes recordId back into the queue file so a re-run is
 * idempotent (updates instead of duplicating).
 *
 * Usage:
 *   node linkedin-engine/stage.js --all
 *   node linkedin-engine/stage.js --post queue/post-<slug>.json
 *   node linkedin-engine/stage.js --deck queue/deck-<slug>.json
 *   node linkedin-engine/stage.js --rerender recXXXXXXXXXXXXXX --deck queue/deck-<slug>.json
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import {
  LINKEDIN_BASE_ID, LINKEDIN_POSTS_TABLE, LINKEDIN_SOURCES_TABLE, CAROUSEL_POSTING_METHOD,
} from '../src/config.js';
import { createRecords, updateRecords, listRecords, uploadAttachment, clearAttachmentField } from '../src/airtable/xbase.js';
import { QUEUE_DIR, OUTPUT_DIR, logger, nyIsoString } from './shared.js';

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (flag) => { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : null; };
  return {
    all: a.includes('--all'),
    post: get('--post'),
    deck: get('--deck'),
    rerender: get('--rerender'),
  };
}

let sourceTitleToId = null;
async function resolveSourceIds(titles) {
  if (!titles?.length) return [];
  if (!sourceTitleToId) {
    const records = await listRecords(LINKEDIN_BASE_ID, LINKEDIN_SOURCES_TABLE);
    sourceTitleToId = new Map(records.map(r => [r.fields['Title'], r.id]));
  }
  return titles.map(t => sourceTitleToId.get(t)).filter(Boolean);
}

function highestTier(claims) {
  const tiers = (claims || []).map(c => c.tier);
  if (tiers.includes('Confidential')) return 'Confidential';
  if (tiers.includes('Needs Ryan OK')) return 'Needs Ryan OK';
  return 'Safe';
}

async function stagePost(postPath) {
  const post = JSON.parse(readFileSync(postPath, 'utf8'));
  const hardProblems = (post.constraintProblems || []).filter(p => !p.startsWith('FLAG:'));
  const status = hardProblems.length ? 'Needs Fix' : 'In Review';
  const caption = `${post.hook}\n\n${post.body}`;

  const fields = {
    Post: `${post.schedule?.date || 'unscheduled'}-${post.slug}`,
    Status: status,
    'Posting Method': 'Auto',
    Platform: 'LinkedIn',
    Format: 'Text',
    Pillar: post.pillar,
    'Story Type': post.story_type,
    Caption: caption,
    Hashtags: (post.hashtags || []).join(' '),
    'Claim Tier': highestTier(post.claims),
    'Claim Check': 'Pending',
    'Claim Notes': post.claimNotes || '',
    'Review Notes': hardProblems.length ? `Generator flagged:\n${hardProblems.join('\n')}` : '',
    'Generated At': post.generatedAt,
    Model: 'linkedin-engine',
    'Engine Paths': postPath,
    Sources: await resolveSourceIds(post.sources),
  };
  if (post.schedule?.date && post.schedule?.time) {
    fields['Scheduled Time'] = nyIsoString(post.schedule.date, post.schedule.time);
  }

  const [row] = post.recordId
    ? await updateRecords(LINKEDIN_BASE_ID, LINKEDIN_POSTS_TABLE, [{ id: post.recordId, fields }])
    : await createRecords(LINKEDIN_BASE_ID, LINKEDIN_POSTS_TABLE, [fields]);

  post.recordId = row.id;
  writeFileSync(postPath, JSON.stringify(post, null, 2));
  logger.success(`${post.recordId} — ${fields.Post} (${status})`);
  return row.id;
}

async function stageDeck(deckPath, { rerenderId } = {}) {
  const deck = JSON.parse(readFileSync(deckPath, 'utf8'));
  const slug = deck.slug;
  const slidesDir = join(OUTPUT_DIR, slug);
  if (!existsSync(slidesDir)) throw new Error(`No rendered slides at ${slidesDir} — run render_deck.py first`);

  const manifestPath = join(slidesDir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`No manifest.json at ${slidesDir} — render_deck.py did not finish`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  const slideFiles = readdirSync(slidesDir).filter(f => f.endsWith('.jpg')).sort().map(f => join(slidesDir, f));
  const pdfPath = manifest.pdf;
  if (!existsSync(pdfPath)) throw new Error(`No PDF at ${pdfPath}`);

  const hardProblems = (deck.constraintProblems || []).filter(p => !p.startsWith('FLAG:'));
  const status = hardProblems.length ? 'Needs Fix' : 'In Review';

  const fields = {
    Post: `${deck.schedule?.date || 'unscheduled'}-${slug}`,
    Status: status,
    'Posting Method': carouselPostingMethod(),
    Platform: 'LinkedIn',
    Format: 'Carousel',
    Pillar: deck.pillar,
    'Story Type': deck.story_type,
    Caption: deck.caption,
    Hashtags: (deck.hashtags || []).join(' '),
    'Document Title': deck.document_title || deck.documentTitle || '',
    'Slide Count': manifest.pages,
    'Claim Tier': highestTier(deck.claims),
    'Claim Check': 'Pending',
    'Claim Notes': deck.claimNotes || '',
    'Review Notes': hardProblems.length ? `Generator flagged:\n${hardProblems.join('\n')}` : '',
    'Generated At': deck.generatedAt,
    Model: 'linkedin-engine',
    'Engine Paths': `${deckPath}\n${slidesDir}`,
    Sources: await resolveSourceIds(deck.sources),
  };
  if (deck.schedule?.date && deck.schedule?.time) {
    fields['Scheduled Time'] = nyIsoString(deck.schedule.date, deck.schedule.time);
  }

  const recordId = rerenderId || deck.recordId;
  const [row] = recordId
    ? await updateRecords(LINKEDIN_BASE_ID, LINKEDIN_POSTS_TABLE, [{ id: recordId, fields }])
    : await createRecords(LINKEDIN_BASE_ID, LINKEDIN_POSTS_TABLE, [fields]);

  deck.recordId = row.id;
  writeFileSync(deckPath, JSON.stringify(deck, null, 2));

  if (recordId) {
    await clearAttachmentField(LINKEDIN_BASE_ID, LINKEDIN_POSTS_TABLE, row.id, 'Preview');
    await clearAttachmentField(LINKEDIN_BASE_ID, LINKEDIN_POSTS_TABLE, row.id, 'Carousel PDF');
  }
  for (const f of slideFiles) await uploadAttachment(LINKEDIN_BASE_ID, row.id, 'Preview', f, 'image/jpeg');
  await uploadAttachment(LINKEDIN_BASE_ID, row.id, 'Carousel PDF', pdfPath, 'application/pdf');

  logger.success(`${row.id} — ${fields.Post} (${status}), ${slideFiles.length} preview slides + PDF attached`);
  return row.id;
}

// Guard against a bad env value silently becoming an invalid select option.
function carouselPostingMethod() {
  return CAROUSEL_POSTING_METHOD === 'Manual' ? 'Manual' : 'Auto';
}

async function main() {
  const { all, post, deck, rerender } = parseArgs();

  if (all) {
    const files = readdirSync(QUEUE_DIR).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const full = join(QUEUE_DIR, f);
      if (f.startsWith('post-')) await stagePost(full);
      else if (f.startsWith('deck-')) await stageDeck(full);
    }
    return;
  }
  if (post) return void await stagePost(post);
  if (deck) return void await stageDeck(deck, { rerenderId: rerender });
  throw new Error('Pass --all, --post <file>, or --deck <file> [--rerender recXXX]');
}

main().catch(e => { logger.error(e.message); console.error(e.stack); process.exit(1); });
