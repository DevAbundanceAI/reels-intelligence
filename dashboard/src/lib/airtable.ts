// Read-only Airtable REST client. Server-only.
//
// We only need a count-of-records-matching-formula query for the
// "today's output" panel on the task drill-down. No writes.

const API = 'https://api.airtable.com/v0';

export class AirtableClient {
  constructor(
    private apiKey: string,
    private baseId: string,
  ) {}

  /**
   * Count records in a table matching an optional filter formula.
   * Pages through the results until exhausted or cap is hit. Returns
   * the count up to cap. Capped at 2000 by default so a single page
   * load can never exhaust the Cloudflare Workers 50-subrequest budget
   * (max ~20 paged calls per drill-down).
   */
  async countRecords(table: string, opts: { filterByFormula?: string; cap?: number } = {}): Promise<number> {
    const baseParams = new URLSearchParams();
    if (opts.filterByFormula) baseParams.set('filterByFormula', opts.filterByFormula);
    baseParams.set('pageSize', '100');

    let count = 0;
    let offset: string | undefined;
    const cap = opts.cap ?? 2000;

    while (true) {
      const params = new URLSearchParams(baseParams);
      if (offset) params.set('offset', offset);
      const url = `${API}/${this.baseId}/${encodeURIComponent(table)}?${params}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!res.ok) {
        // Bad filter (invalid formula on this table) or missing perms — return 0.
        // We don't want a single misconfigured table to break the whole page.
        return count;
      }
      const data = await res.json();
      count += (data.records ?? []).length;
      if (count >= cap) return cap;
      offset = data.offset;
      if (!offset) return count;
    }
  }

  /** Return an Airtable URL pointing at a table view. Useful for "open in Airtable" links. */
  tableUrl(tableId: string): string {
    return `https://airtable.com/${this.baseId}/${tableId}`;
  }
}

/**
 * Common filter formulas.
 */
export const filters = {
  /** Today, UTC. */
  todayUTC(field: string): string {
    return `IS_SAME({${field}}, TODAY(), 'day')`;
  },
  /** Last N days, UTC. */
  lastNDaysUTC(field: string, days: number): string {
    return `IS_AFTER({${field}}, DATEADD(NOW(), -${days}, 'days'))`;
  },
  /** All-time = empty filter (no formula). */
  allTime(): string {
    return '';
  },
};

/**
 * Best-effort date field detection. The trending tables all use "Scraped At";
 * Content Ideas uses "Generated At". Returns the first matching field name.
 */
export function dateFieldFor(tableName: string): string {
  if (tableName === 'Content Ideas') return 'Generated At';
  if (tableName === 'Content Calendar') return 'Scheduled Date';
  return 'Scraped At';
}
