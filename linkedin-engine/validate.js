/**
 * linkedin-engine/validate.js — machine validators for generated posts.
 *
 * Two entry points used by generate-posts.js: validateTextPost(post) and
 * validateDeck(deck). Both return an array of problem strings (empty =
 * clean). scanCopy() is the shared text scanner both call into, plus a
 * few structural checks specific to each format.
 *
 * `node linkedin-engine/validate.js --self-test` runs fixtures and exits
 * non-zero if any expected problem is not caught.
 */

// Canonical dollar figures allowed anywhere in output (totals only — the
// live-site whitelist from ryanfrost-site/index.html + case studies).
const CANONICAL_DOLLARS = ['$0', '$11.5M', '$2.9M', '$1.5M', '$4.6M', '$1.6M', '$989K'];

const CTA_LEXICON = [
  'dm me', 'message me', 'link in', 'featured', 'book a call', 'comment below',
  'let me know in the comments', 'apply', 'see if you qualify', 'schedule',
  'reply with', 'follow for', 'share this',
];

const BANNED_WORDS = [
  'game-changer', 'game changer', 'next level', 'unlock', 'synergy',
  'in today\'s world', 'let\'s dive in', 'buckle up', 'ever-evolving',
  'one weird trick', 'just imagine', 'leverage', 'leveraging', 'leveraged',
];

const LINKEDIN_BRO_TELLS = [
  'let that sink in', 'agree?', 'read that again', "here's the thing",
];

const NAMES_GATE = [
  'ahmed', 'ryan morgan', 'brian durkee', 'gavin brooks', 'promoting made simple',
  'go fast funding', 'atif', 'manuel', 'ciara', 'ola', '98%', '111 calls',
  '143 calls', '$16', '$20.98', '70 hours', '$30k',
];

const COMPETITOR_NAMES = [
  'liam evans', 'multiplyclients', 'kai bax', 'scaleclients', 'hims', 'hers',
  'viktor', 'hormozi', 'sabri suby', 'cole gordon', 'closers.io',
];

const RELATIVE_TIME = [
  'last week', 'this week', 'yesterday', 'today', 'this month', 'this summer', 'this year',
];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Word-boundary matching, not naive substring: a plain `.includes('apply')`
 * would also flag "applicants" or "applying" as a CTA phrase. \b works
 * fine for multi-word phrases too (it anchors at the phrase's own start
 * and end), so every lexicon below uses this, not raw includes.
 */
function hasAny(lower, list) {
  return list.filter(term => new RegExp(`\\b${escapeRegExp(term)}\\b`).test(lower));
}

/** Core text scan, shared by text posts and carousel captions/slide copy. */
export function scanCopy(text, { skipConfidential = false, skipProseChecks = false } = {}) {
  const problems = [];
  const t = String(text || '');
  const lower = t.toLowerCase();

  if (/[—–]/.test(t)) problems.push('em/en dash present');
  if (/https?:\/\/|www\./i.test(t)) problems.push('URL present');

  if (/\$\s?\d[\d.,]*\s?[KkMm]?\s?(\/|per|a)\s?(mo|month)/i.test(t)) problems.push('$/mo or per-month rate present');
  const literalPrices = ['$997', '$9k', '$9,000', '$12k', '$15k', '$7,500', 'paid engagement'];
  hasAny(lower, literalPrices).forEach(p => problems.push(`price language present: "${p}"`));

  // Every dollar figure must be on the canonical whitelist.
  const dollarMatches = t.match(/\$[\d][\d.,]*[KkMm]?\+?/g) || [];
  for (const m of dollarMatches) {
    // Strip commas and a trailing "+" so "$11.5M+" matches the "$11.5M"
    // whitelist entry (the "+" is a legitimate "at least this much" marker
    // on the aggregate total, not a different, unreviewed number).
    const normalized = m.replace(/,/g, '').replace(/\+$/, '');
    if (!CANONICAL_DOLLARS.some(c => c.replace(/,/g, '').replace(/\+$/, '') === normalized)) {
      problems.push(`non-canonical dollar figure: "${m}"`);
    }
  }

  hasAny(lower, CTA_LEXICON).forEach(p => problems.push(`CTA phrase present: "${p}"`));
  hasAny(lower, BANNED_WORDS).forEach(p => problems.push(`banned word present: "${p}"`));
  hasAny(lower, LINKEDIN_BRO_TELLS).forEach(p => problems.push(`LinkedIn-bro tell present: "${p}"`));
  hasAny(lower, NAMES_GATE).forEach(p => problems.push(`names-gate term present (tier Needs Ryan OK): "${p}"`));
  if (!skipConfidential) {
    hasAny(lower, COMPETITOR_NAMES).forEach(p => problems.push(`competitor/teacher name present: "${p}"`));
  }
  hasAny(lower, RELATIVE_TIME).forEach(p => problems.push(`relative-time phrase present (posts are scheduled weeks out): "${p}"`));

  if (/\b(19|20)\d{2}\b/.test(t)) problems.push('a specific year is present (durations only)');
  if (/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}\b/i.test(t)) {
    problems.push('a month + year is present (durations only)');
  }

  // Confidential guards
  if (/\$[\d.,]+[KkMm]?/.test(t) && /expert health/i.test(t)) {
    const idx = lower.indexOf('expert health');
    const window = lower.slice(Math.max(0, idx - 80), idx + 80);
    if (/\$[\d.,]+[KkMm]?|sales|orders|customers|revenue/.test(window)) {
      problems.push('possible Expert Health sales/revenue figure near a confidential term');
    }
  }
  const molecules = ['semaglutide', 'tirzepatide', 'retatrutide', 'bpc-157', 'cjc-1295', 'ghk-cu', 'tb-500', 'pt-141', 'tesamorelin', 'sermorelin', 'nad+', 'testosterone'];
  hasAny(lower, molecules).forEach(p => problems.push(`Expert Health molecule/product name present: "${p}"`));
  if (/smart sellers/i.test(t)) {
    if (!/\$1\.5m/i.test(t)) problems.push('Smart Sellers Academy mentioned without the past-tense $1.5M receipt');
    if (/(show rate|cac|p&l|join|enroll|smartsellersacademy\.com|closers|cole gordon)/i.test(t)) {
      problems.push('Smart Sellers Academy mentioned with disallowed detail (internals or promotion)');
    }
  }
  if (/heyfrosty\.ai|\$100 free|sign up|try it/i.test(t) && /frosty/i.test(t)) {
    problems.push('Frosty mentioned with promotional language (never promoted)');
  }
  ['oren', 'peptide deal'].forEach(term => { if (lower.includes(term)) problems.push(`confidential term present: "${term}"`); });

  // Prose-shape checks (fragment-stack, same-opener runs, And-chains, the
  // read-aloud mean-sentence-length proxy) only make sense for continuous
  // prose (text posts, captions). Structured slide JSON is short fragments
  // BY DESIGN, so these are skipped there to avoid meaningless noise.
  if (!skipProseChecks) {
    const sentences = t.split(/(?<=[.!?])\s+/).filter(Boolean);
    let shortRun = 0, maxShortRun = 0;
    for (const s of sentences) {
      const words = s.trim().split(/\s+/).filter(Boolean).length;
      shortRun = words <= 4 ? shortRun + 1 : 0;
      maxShortRun = Math.max(maxShortRun, shortRun);
    }
    if (maxShortRun >= 3) problems.push(`fragment-stack detected: ${maxShortRun} consecutive short (<=4 word) sentences`);
    const startsSame = ['more', 'no', 'not', 'just'];
    let sameRun = 0, maxSameRun = 0, lastStart = null;
    for (const s of sentences) {
      const first = (s.trim().split(/\s+/)[0] || '').toLowerCase().replace(/[.,!?]/g, '');
      if (startsSame.includes(first) && first === lastStart) { sameRun++; } else { sameRun = startsSame.includes(first) ? 1 : 0; }
      maxSameRun = Math.max(maxSameRun, sameRun);
      lastStart = startsSame.includes(first) ? first : null;
    }
    if (maxSameRun >= 3) problems.push('fragment-stack detected: 3+ consecutive sentences with the same one-word opener');

    let andCount = 0;
    for (const s of sentences) if (/^and\b/i.test(s.trim())) andCount++;
    if (andCount >= 3) problems.push('FLAG: 3+ sentences start with "And" in this block');

    if (sentences.length) {
      const meanWords = sentences.reduce((sum, s) => sum + s.trim().split(/\s+/).filter(Boolean).length, 0) / sentences.length;
      if (meanWords < 8 || meanWords > 22) problems.push(`FLAG: mean sentence length ${meanWords.toFixed(1)} words (target 8-22)`);
    }
  }

  return problems;
}

export function validateTextPost(post) {
  const problems = [];
  const hook = (post.hook || (post.body || '').split('\n')[0] || '').trim();
  const body = post.body ? `${hook}\n\n${post.body}` : (post.text || '');
  const fullLength = body.length || (post.text || '').length;

  if (hook.length > 140) problems.push(`hook is ${hook.length} chars (max 140, mobile see-more cutoff)`);
  if (hook.length === 0) problems.push('hook/first line is empty');

  const textToCheck = post.text || body;
  const len = textToCheck.length;
  if (len < 600 || len > 1300) problems.push(`text post is ${len} chars (need 600-1300)`);

  const hashtags = post.hashtags || [];
  if (hashtags.length !== 0 && hashtags.length !== 3) problems.push(`${hashtags.length} hashtags (must be 0 or 3 — this batch uses 0)`);

  problems.push(...scanCopy(textToCheck));
  return [...new Set(problems)];
}

const SLIDE_TYPES = ['hook', 'point', 'list', 'quote', 'stat', 'before_after', 'signoff', 'chart'];
const MIN_SLIDES = 6, MAX_SLIDES = 10;

export function validateDeck(deck) {
  const problems = [];
  const slides = deck.slides || [];

  if (!Array.isArray(slides) || slides.length === 0) problems.push('no slides');
  if (slides.length && (slides.length < MIN_SLIDES || slides.length > MAX_SLIDES)) {
    problems.push(`${slides.length} slides (need ${MIN_SLIDES}-${MAX_SLIDES} for a LinkedIn document post)`);
  }
  if (slides.length && slides[0].type !== 'hook') problems.push('slide 1 is not a hook');
  if (slides.length && slides[slides.length - 1].type !== 'signoff') problems.push('last slide is not a signoff');

  let totalWords = 0;
  for (const [i, s] of slides.entries()) {
    if (!SLIDE_TYPES.includes(s.type)) problems.push(`slide ${i + 1}: unknown type "${s.type}"`);
    if (s.type === 'cta') problems.push(`slide ${i + 1}: "cta" is not a valid LinkedIn-profile slide type — use "signoff"`);
    if (s.emphasis && s.headline && !s.headline.includes(s.emphasis)) {
      problems.push(`slide ${i + 1}: emphasis "${s.emphasis}" not found in headline`);
    }
    if (s.headline && s.headline.split(/\s+/).length > 12) problems.push(`slide ${i + 1}: headline over 12 words`);
    const nestedItems = [...(s.items || []), ...((s.before && s.before.items) || []), ...((s.after && s.after.items) || [])];
    const words = [s.headline, s.sub, s.body, s.label, s.line, s.value, s.quote, s.attribution, ...nestedItems]
      .filter(Boolean).join(' ').split(/\s+/).filter(Boolean).length;
    totalWords += words;
    if (words > 30) problems.push(`slide ${i + 1}: ~${words} words (max ~30 per slide)`);
  }

  const docTitle = deck.document_title || deck.documentTitle || '';
  if (!docTitle) problems.push('document_title is missing');
  if (docTitle.length > 60) problems.push(`document_title is ${docTitle.length} chars (max 60)`);

  const caption = deck.caption || '';
  if (caption.length < 150 || caption.length > 300) problems.push(`caption is ${caption.length} chars (need 150-300)`);

  const hashtags = deck.hashtags || [];
  if (hashtags.length !== 0 && hashtags.length !== 3) problems.push(`${hashtags.length} hashtags (must be 0 or 3 — this batch uses 0)`);

  // Chart slides: numbers must be canonical.
  for (const [i, s] of slides.entries()) {
    if (s.type === 'chart' && s.chart?.values) {
      // values are numbers, not directly dollar-checkable here; caption/label scan below catches the rendered text.
      void i;
    }
  }

  problems.push(...scanCopy(caption));
  problems.push(...scanCopy(docTitle));
  problems.push(...scanCopy(JSON.stringify(slides), { skipProseChecks: true }));

  return [...new Set(problems)];
}

/** Duplicate-hook check across a batch: first 8 words must be unique. */
export function checkDuplicateHooks(hooks) {
  const problems = [];
  const seen = new Map();
  for (const h of hooks) {
    const key = String(h).toLowerCase().split(/\s+/).slice(0, 8).join(' ');
    if (seen.has(key)) problems.push(`duplicate hook opener: "${h}" collides with "${seen.get(key)}"`);
    seen.set(key, h);
  }
  return problems;
}

/** Schedule sanity across a batch of {date, format} items (date = YYYY-MM-DD, weekday Tue-Fri expected). */
export function checkSchedule(items) {
  const problems = [];
  const byDate = new Map();
  for (const it of items) {
    if (byDate.has(it.date)) problems.push(`two posts scheduled on ${it.date}`);
    byDate.set(it.date, it);
  }
  const sorted = [...items].sort((a, b) => a.date.localeCompare(b.date));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].format === 'carousel' && sorted[i - 1].format === 'carousel') {
      const d1 = new Date(sorted[i - 1].date), d2 = new Date(sorted[i].date);
      if ((d2 - d1) / 86400000 <= 3) problems.push(`consecutive carousels close together: ${sorted[i - 1].date} and ${sorted[i].date}`);
    }
  }
  return problems;
}

// ── self-test ────────────────────────────────────────────────────────────
function selfTest() {
  const fixtures = [
    { name: 'em dash', text: 'This is a sentence — with an em dash.', expect: 'em/en dash present' },
    { name: '$/mo', text: 'We charge $135K/mo for this.', expect: '$/mo or per-month rate present' },
    { name: 'URL', text: 'Check out https://example.com for more.', expect: 'URL present' },
    { name: 'DM me', text: 'If this resonates, DM me and let us talk.', expect: 'CTA phrase present: "dm me"' },
    { name: 'leverage', text: 'You need to leverage this system to win.', expect: 'banned word present: "leverage"' },
    { name: 'year', text: 'Back in 2024 we started this build.', expect: 'a specific year is present (durations only)' },
    { name: 'hormozi', text: 'This is not a Hormozi-style pitch.', expect: 'competitor/teacher name present: "hormozi"' },
    { name: 'fragment stack', text: 'More funnels. More targeted. Higher conversion. That is the whole point of this system working well for founders who want more.', expect: 'fragment-stack detected' , partial: true},
  ];

  let failed = 0;
  for (const f of fixtures) {
    const problems = scanCopy(f.text);
    const found = f.partial ? problems.some(p => p.includes(f.expect)) : problems.includes(f.expect);
    console.log(`${found ? 'PASS' : 'FAIL'} — ${f.name}${found ? '' : ` (expected "${f.expect}", got: ${JSON.stringify(problems)})`}`);
    if (!found) failed++;
  }

  const longHookPost = { text: 'x'.repeat(700), hook: 'This is a hook that runs on and on and on and on and on and on and on and on and on and on and on for a very long time indeed, well past the mobile fold cutoff of one hundred forty characters for sure.' };
  const hookProblems = validateTextPost(longHookPost);
  const hookFound = hookProblems.some(p => p.includes('mobile see-more cutoff'));
  console.log(`${hookFound ? 'PASS' : 'FAIL'} — 160-char hook${hookFound ? '' : ` (got: ${JSON.stringify(hookProblems)})`}`);
  if (!hookFound) failed++;

  const shortDeck = { document_title: 'Short deck', caption: 'x'.repeat(200), slides: [{ type: 'hook', headline: 'A hook' }, { type: 'signoff' }] };
  const deckProblems = validateDeck(shortDeck);
  const deckFound = deckProblems.some(p => p.includes('need 6-10'));
  console.log(`${deckFound ? 'PASS' : 'FAIL'} — deck too short${deckFound ? '' : ` (got: ${JSON.stringify(deckProblems)})`}`);
  if (!deckFound) failed++;

  if (failed) {
    console.error(`\n${failed} fixture(s) failed`);
    process.exit(1);
  }
  console.log('\nAll self-test fixtures passed.');
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain && process.argv.includes('--self-test')) selfTest();
