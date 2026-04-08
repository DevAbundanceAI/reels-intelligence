/**
 * helpers.js — Shared pure utility functions.
 * Zero project dependencies — safe to import from anywhere.
 */

/**
 * Return an ISO date string (YYYY-MM-DD).
 * @param {Date|string|number} [date] — defaults to now
 */
export const toISODate = (date) =>
  new Date(date ?? Date.now()).toISOString().slice(0, 10);

/**
 * Strip markdown code fences and parse JSON from a Claude response.
 * Claude occasionally wraps JSON in ```json ... ``` fences.
 * @param {string} text — raw text from Claude message content
 * @returns {*} parsed JSON value
 * @throws {SyntaxError} if parsing fails after stripping
 */
export const parseClaudeJSON = (text) =>
  JSON.parse(text.replace(/```json|```/g, '').trim());

/**
 * Build an Airtable filterByFormula equality check.
 * @param {string} field — Airtable field name (wrapped in {})
 * @param {string} value — value to match (wrapped in "")
 */
export const airtableFormula = (field, value) => `{${field}} = "${value}"`;
