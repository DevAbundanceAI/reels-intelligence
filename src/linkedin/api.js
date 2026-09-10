/**
 * src/linkedin/api.js — thin wrapper over LinkedIn's REST API (Posts +
 * Documents), used by both the CLI (linkedin-engine/publish-now.js) and
 * the Trigger.dev worker (trigger/linkedin-publish-post.ts transpiles TS
 * that imports the compiled JS via the shared src/ tree).
 *
 * Auth model: self-serve "Share on LinkedIn" product on a LinkedIn
 * developer app grants scope w_member_social — no Marketing Developer
 * Platform partner approval needed to post to Ryan's OWN profile. The
 * Documents API's permission table lists w_member_social too; for a
 * person-URN-owned document "the caller must match the document owner"
 * (verified against learn.microsoft.com/en-us/linkedin/marketing/
 * community-management/shares/{posts-api,documents-api}, Sep 2026).
 *
 * Token: 60-day access token, no programmatic refresh for a non-MDP app.
 * See linkedin-engine/auth.js for the OAuth round trip that mints one.
 */

import { LINKEDIN_API_VERSION } from '../config.js';

const API = 'https://api.linkedin.com';

export class TokenExpiredError extends Error {
  constructor(detail) {
    super(`LinkedIn token expired or invalid (re-run linkedin-engine/auth.js): ${detail}`);
    this.name = 'TokenExpiredError';
  }
}

export function liHeaders(token, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    'LinkedIn-Version': LINKEDIN_API_VERSION,
    'X-Restli-Protocol-Version': '2.0.0',
    'Content-Type': 'application/json',
    ...extra,
  };
}

/**
 * LinkedIn commentary uses "little text" formatting where a handful of
 * ASCII punctuation characters are structural (mentions, hashtags, bold).
 * Escape them so a caption with a parenthetical or a bracket posts as
 * literal text instead of being eaten or rejected. Hashtags (#) are left
 * alone on purpose — the Hashtags field appends real #tags.
 */
export function escapeCommentary(text) {
  return String(text).replace(/([()[\]{}<>@*_~|\\])/g, '\\$1');
}

async function liFetch(path, token, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: liHeaders(token, options.headers),
  });
  if (res.status === 401) {
    const body = await res.text();
    throw new TokenExpiredError(body.slice(0, 200));
  }
  return res;
}

/** GET /v2/userinfo — the OIDC endpoint that resolves the member's own id. */
export async function getUserInfo(token) {
  const res = await liFetch('/v2/userinfo', token);
  if (!res.ok) throw new Error(`userinfo ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json(); // { sub, name, ... }
}

/** Text-only post (no `content` block). Returns { urn, url }. */
export async function createTextPost({ token, personUrn, commentary }) {
  const res = await liFetch('/rest/posts', token, {
    method: 'POST',
    body: JSON.stringify({
      author: personUrn,
      commentary,
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    }),
  });
  if (!res.ok) throw new Error(`createTextPost ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const urn = decodeURIComponent(res.headers.get('x-restli-id') || '');
  if (!urn) throw new Error('createTextPost: 201 but no x-restli-id header returned');
  return { urn, url: postUrl(urn) };
}

/** Step 1 of a document post: register the upload, get back a PUT url + document URN. */
export async function initializeDocumentUpload({ token, personUrn }) {
  const res = await liFetch('/rest/documents?action=initializeUpload', token, {
    method: 'POST',
    body: JSON.stringify({ initializeUploadRequest: { owner: personUrn } }),
  });
  if (!res.ok) throw new Error(`initializeDocumentUpload ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const body = await res.json();
  const { uploadUrl, document } = body.value || {};
  if (!uploadUrl || !document) throw new Error(`initializeDocumentUpload: unexpected response ${JSON.stringify(body).slice(0, 300)}`);
  return { uploadUrl, documentUrn: document };
}

/** Step 2: PUT the raw PDF bytes to the URL from step 1. No LinkedIn-Version header here — it's a plain upload target, not a versioned API call. */
export async function uploadDocumentBytes({ token, uploadUrl, bytes }) {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/pdf' },
    body: bytes,
  });
  if (res.status === 401) throw new TokenExpiredError(await res.text());
  if (!res.ok && res.status !== 201) {
    throw new Error(`uploadDocumentBytes ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

/** Step 3: poll the document until LinkedIn finishes processing it. */
export async function waitForDocument({ token, documentUrn, timeoutMs = 120000, intervalMs = 3000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await liFetch(`/rest/documents/${encodeURIComponent(documentUrn)}`, token);
    if (!res.ok) throw new Error(`waitForDocument ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = await res.json();
    if (body.status === 'AVAILABLE') return body;
    if (body.status === 'PROCESSING_FAILED') throw new Error(`Document processing failed for ${documentUrn}`);
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`waitForDocument: timed out after ${timeoutMs}ms waiting on ${documentUrn}`);
}

/** Step 4: create the post referencing the finished document. Returns { urn, url }. */
export async function createDocumentPost({ token, personUrn, commentary, documentUrn, title }) {
  const res = await liFetch('/rest/posts', token, {
    method: 'POST',
    body: JSON.stringify({
      author: personUrn,
      commentary,
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      content: { media: { title, id: documentUrn } },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    }),
  });
  if (!res.ok) throw new Error(`createDocumentPost ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const urn = decodeURIComponent(res.headers.get('x-restli-id') || '');
  if (!urn) throw new Error('createDocumentPost: 201 but no x-restli-id header returned');
  return { urn, url: postUrl(urn) };
}

export function postUrl(urn) {
  return `https://www.linkedin.com/feed/update/${urn}/`;
}

/**
 * Compose the full commentary the way every generated post expects it:
 * caption/body, then (if present) two line breaks and the hashtags.
 */
export function composeCommentary(caption, hashtags) {
  const body = escapeCommentary(caption || '');
  const tags = (hashtags || '').trim();
  return tags ? `${body}\n\n${tags}` : body;
}

/**
 * One entry point that publishes a Posts row, text or carousel. Downloads
 * the Carousel PDF attachment in the SAME run (attachment URLs expire in
 * ~2h, so fetch-then-immediately-upload is the only safe pattern) rather
 * than depending on any long-lived public URL.
 */
export async function publishRecord(row, { token, personUrn }) {
  const f = row.fields;
  const commentary = composeCommentary(f.Caption, f.Hashtags);

  if (f.Format === 'Carousel') {
    const pdfAttachment = (f['Carousel PDF'] || [])[0];
    if (!pdfAttachment) throw new Error('Carousel row has no Carousel PDF attachment');
    const pdfRes = await fetch(pdfAttachment.url);
    if (!pdfRes.ok) throw new Error(`Failed to fetch Carousel PDF from Airtable: ${pdfRes.status}`);
    const bytes = Buffer.from(await pdfRes.arrayBuffer());

    const { uploadUrl, documentUrn } = await initializeDocumentUpload({ token, personUrn });
    await uploadDocumentBytes({ token, uploadUrl, bytes });
    await waitForDocument({ token, documentUrn });
    return createDocumentPost({
      token, personUrn, commentary, documentUrn,
      title: f['Document Title'] || 'Document',
    });
  }

  return createTextPost({ token, personUrn, commentary });
}
