/**
 * linkedin-engine/run.js — orchestrator: generate -> render (carousels
 * only) -> stage, per plan item. No publish step here by design (see
 * linkedin-engine/CLAUDE.md — this engine generates and stages only).
 *
 * Usage:
 *   node linkedin-engine/run.js --plan seed/plan-2026-09-15.json [--only <slug>]
 */

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { ENGINE_DIR, logger } from './shared.js';

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (flag) => { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : null; };
  return { plan: get('--plan'), only: get('--only') };
}

function run(cmd, args) {
  logger.step(`$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', cwd: ENGINE_DIR });
}

async function main() {
  const { plan, only } = parseArgs();
  if (!plan) throw new Error('Pass --plan seed/plan-<batch>.json');
  // Resolve once against the invoking shell's cwd — children below run
  // with cwd=ENGINE_DIR, so a relative path must be made absolute first
  // or the two reads (this process vs. the spawned children) would
  // resolve it against different base directories.
  const planAbs = resolve(process.cwd(), plan);

  const items = JSON.parse(readFileSync(planAbs, 'utf8'));
  const targets = only ? items.filter(i => i.slug === only) : items;
  if (!targets.length) throw new Error(only ? `No plan item with slug "${only}"` : 'Plan file is empty');

  logger.info(`Running ${targets.length} item(s) from ${planAbs}: generate -> render -> stage`);

  let ok = 0, failed = 0;
  for (const item of targets) {
    logger.info(`\n=== ${item.slug} (${item.format}) ===`);
    try {
      run('node', ['generate-posts.js', '--plan', planAbs, '--only', item.slug]);
      const prefix = item.format === 'carousel' ? 'deck' : 'post';
      const queueFile = join('queue', `${prefix}-${item.slug}.json`);

      if (item.format === 'carousel') {
        run('python3', ['render_deck.py', '--deck', queueFile]);
        run('node', ['stage.js', '--deck', queueFile]);
      } else {
        run('node', ['stage.js', '--post', queueFile]);
      }
      ok++;
    } catch (e) {
      logger.error(`${item.slug} failed: ${e.message}`);
      failed++;
    }
  }

  logger.success(`\nDone — ${ok} staged, ${failed} failed, out of ${targets.length}.`);
  logger.info('Review in Airtable: "Ryan Frost LinkedIn Engine" base, Posts table, Review Queue view.');
}

main().catch(e => { logger.error(e.message); process.exit(1); });
