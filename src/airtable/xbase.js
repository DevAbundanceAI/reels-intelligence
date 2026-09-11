/**
 * xbase.js — cross-base Airtable REST client (any baseId, not just
 * AIRTABLE_BASE_ID). `src/airtable/client.js` stays scoped to the reels
 * base so its usage by the deployed Trigger.dev tasks stays untouched;
 * cross-base reads/writes (LinkedIn engine, and anything else that needs
 * a different base) live here. Same idiom as src/brand/dna.js's xbFetch,
 * extended with create/update/delete + the attachment-upload endpoint.
 */

import { readFileSync } from 'fs';
import { basename } from 'path';
import { AIRTABLE_API_KEY } from '../config.js';

const BASE_URL = 'https://api.airtable.com/v0';
const CONTENT_URL = 'https://content.airtable.com/v0';

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function xFetch(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await res.json();
  if (!res.ok) {
    const msg = body?.error?.message || JSON.stringify(body);
    throw new Error(`Airtable ${res.status} on ${path}: ${msg}`);
  }
  return body;
}

/**
 * List all records from a table in an arbitrary base. Handles pagination.
 * `table` may be a table id (tbl...) or an exact table name.
 */
export async function listRecords(baseId, table, { filterFormula, fields, maxRecords, sort } = {}) {
  const records = [];
  let offset = null;
  const encodedTable = encodeURIComponent(table);

  do {
    const params = new URLSearchParams();
    if (filterFormula) params.set('filterByFormula', filterFormula);
    if (fields) fields.forEach(f => params.append('fields[]', f));
    if (maxRecords) params.set('maxRecords', maxRecords);
    if (sort) sort.forEach((s, i) => {
      params.set(`sort[${i}][field]`, s.field);
      params.set(`sort[${i}][direction]`, s.direction || 'asc');
    });
    if (offset) params.set('offset', offset);

    const data = await xFetch(`/${baseId}/${encodedTable}?${params}`);
    records.push(...data.records);
    offset = data.offset;
  } while (offset);

  return records;
}

export async function getRecord(baseId, table, recordId) {
  const encodedTable = encodeURIComponent(table);
  return xFetch(`/${baseId}/${encodedTable}/${recordId}`);
}

/** Create up to 10 records at a time (Airtable's hard per-request limit). */
export async function createRecords(baseId, table, recordsFields, { typecast = true } = {}) {
  const encodedTable = encodeURIComponent(table);
  const created = [];
  for (const chunk of chunkArray(recordsFields, 10)) {
    const data = await xFetch(`/${baseId}/${encodedTable}`, {
      method: 'POST',
      body: JSON.stringify({ records: chunk.map(fields => ({ fields })), typecast }),
    });
    created.push(...data.records);
  }
  return created;
}

/** Update up to 10 records at a time. `updates` = [{ id, fields }]. */
export async function updateRecords(baseId, table, updates, { typecast = true } = {}) {
  const encodedTable = encodeURIComponent(table);
  const updated = [];
  for (const chunk of chunkArray(updates, 10)) {
    const data = await xFetch(`/${baseId}/${encodedTable}`, {
      method: 'PATCH',
      body: JSON.stringify({ records: chunk, typecast }),
    });
    updated.push(...data.records);
  }
  return updated;
}

export async function deleteRecords(baseId, table, recordIds) {
  const encodedTable = encodeURIComponent(table);
  let deleted = 0;
  for (const chunk of chunkArray(recordIds, 10)) {
    const params = new URLSearchParams();
    chunk.forEach(id => params.append('records[]', id));
    await xFetch(`/${baseId}/${encodedTable}?${params}`, { method: 'DELETE' });
    deleted += chunk.length;
  }
  return deleted;
}

/**
 * Upload one local file into an attachment field via the Airtable content
 * API. Cap is at least a few MB (confirmed a 5.9MB video upload succeeds, Sep 2026); no confirmed hard limit found, keep files reasonably small anyway. Generalized from content-engine/stage.js's
 * uploadAttachment: takes an explicit contentType (that version only
 * handled png/jpg) and an explicit baseId (that version was pinned to
 * AIRTABLE_BASE_ID).
 */
export async function uploadAttachment(baseId, recordId, fieldName, filePath, contentType) {
  const res = await fetch(
    `${CONTENT_URL}/${baseId}/${recordId}/${encodeURIComponent(fieldName)}/uploadAttachment`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${AIRTABLE_API_KEY}`,
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
    throw new Error(`uploadAttachment ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

/** Clear an attachment field before re-uploading (used by --rerender). */
export async function clearAttachmentField(baseId, table, recordId, fieldName) {
  return updateRecords(baseId, table, [{ id: recordId, fields: { [fieldName]: [] } }]);
}
