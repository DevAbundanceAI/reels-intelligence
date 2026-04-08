import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const FRAMEWORKS_PATH = resolve(__dir, '../../config/frameworks.md');

// Headings and comment lines — stripped when checking if file has real content
const EMPTY_LINE = /^\s*$|^#|^<!--|^-->/;

/**
 * Load user-defined frameworks from config/frameworks.md.
 * Returns the trimmed markdown content, or an empty string if the file
 * doesn't exist or contains only template comments/headings.
 *
 * The returned string is appended to Claude system prompts when non-empty.
 */
export function loadFrameworks() {
  if (!existsSync(FRAMEWORKS_PATH)) return '';

  const raw = readFileSync(FRAMEWORKS_PATH, 'utf-8');

  // Check if the file has any real content (non-comment, non-heading lines)
  const hasContent = raw.split('\n').some(line => !EMPTY_LINE.test(line));
  if (!hasContent) return '';

  return raw.trim();
}

/**
 * Build the framework injection string for system prompts.
 * Returns empty string when no frameworks are defined (no-op injection).
 */
export function frameworkSystemSuffix() {
  const frameworks = loadFrameworks();
  if (!frameworks) return '';
  return `\n\n---\n## User-Defined Analysis Frameworks\nApply the following frameworks and criteria where relevant:\n\n${frameworks}`;
}
