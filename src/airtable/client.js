import { logger } from '../utils/logger.js';
import { AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_REELS_TABLE } from '../config.js';

const BASE_URL = 'https://api.airtable.com/v0';
const API_KEY  = AIRTABLE_API_KEY;
const BASE_ID  = AIRTABLE_BASE_ID;

if (!API_KEY || !BASE_ID) {
  throw new Error('Missing AIRTABLE_API_KEY or AIRTABLE_BASE_ID in .env');
}

async function airtableFetch(path, options = {}) {
  const url = `${BASE_URL}/${BASE_ID}${path}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type':  'application/json',
    },
    ...options,
  });

  const body = await res.json();

  if (!res.ok) {
    const msg = body?.error?.message || JSON.stringify(body);
    throw new Error(`Airtable ${res.status} on ${path}: ${msg}`);
  }

  return body;
}

/**
 * List records from a table with optional filter formula.
 * Handles pagination automatically.
 */
export async function listRecords(table, { filterFormula, fields, maxRecords } = {}) {
  const records = [];
  let offset = null;

  do {
    const params = new URLSearchParams();
    if (filterFormula) params.set('filterByFormula', filterFormula);
    if (fields)        fields.forEach(f => params.append('fields[]', f));
    if (maxRecords)    params.set('maxRecords', maxRecords);
    if (offset)        params.set('offset', offset);

    const encodedTable = encodeURIComponent(table);
    const data = await airtableFetch(`/${encodedTable}?${params}`);
    records.push(...data.records);
    offset = data.offset;
  } while (offset);

  return records;
}

/**
 * Create up to 10 records at once (Airtable hard limit per request).
 * Returns created record objects.
 */
export async function createRecords(table, recordsFields) {
  const encodedTable = encodeURIComponent(table);
  // Airtable max 10 per request
  const chunks = chunkArray(recordsFields, 10);
  const created = [];

  for (const chunk of chunks) {
    const data = await airtableFetch(`/${encodedTable}`, {
      method: 'POST',
      body: JSON.stringify({
        records: chunk.map(fields => ({ fields })),
        typecast: true, // auto-convert types (e.g. string → select option)
      }),
    });
    created.push(...data.records);
  }

  return created;
}

/**
 * Update up to 10 records at once.
 */
export async function updateRecords(table, updates) {
  const encodedTable = encodeURIComponent(table);
  const chunks = chunkArray(updates, 10);
  const updated = [];

  for (const chunk of chunks) {
    const data = await airtableFetch(`/${encodedTable}`, {
      method: 'PATCH',
      body: JSON.stringify({
        records: chunk,  // [{ id, fields }]
        typecast: true,
      }),
    });
    updated.push(...data.records);
  }

  return updated;
}

/**
 * Get a single record by ID.
 */
export async function getRecord(table, recordId) {
  const encodedTable = encodeURIComponent(table);
  return airtableFetch(`/${encodedTable}/${recordId}`);
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// --- CLI test ---
if (process.argv.includes('--test')) {
  logger.info('Testing Airtable connection...');
  try {
    const data = await airtableFetch(`/${encodeURIComponent(AIRTABLE_REELS_TABLE)}?maxRecords=1`);
    logger.success(`Connection OK — table exists with ${data.records.length} test record(s)`);
  } catch (e) {
    logger.error('Airtable test failed', e.message);
    process.exit(1);
  }
}
