/**
 * One-command content run: mine → generate → render → stage.
 *
 * node content-engine/run.js --angles 5          full run
 * node content-engine/run.js --skip-mine        use newest queue/angles-*.json
 *
 * Everything lands as Content Ideas (Status: Idea) + Content Calendar rows
 * (Status: In Production) for human review. Nothing posts anywhere —
 * posting is manual by design.
 */

import { execFileSync } from 'child_process';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { logger } from '../src/utils/logger.js';
import { ENGINE_DIR, QUEUE_DIR } from './shared.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : dflt; };
  return {
    angles:   parseInt(get('--angles', '5'), 10),
    skipMine: args.includes('--skip-mine'),
  };
}

function node(script, ...extra) {
  logger.step(`node ${script} ${extra.join(' ')}`);
  return execFileSync(process.execPath, [join(ENGINE_DIR, script), ...extra],
                      { stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' });
}

function python(script, ...extra) {
  logger.step(`python ${script} ${extra.join(' ')}`);
  return execFileSync('python3', [join(ENGINE_DIR, script), ...extra],
                      { stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' });
}

function newestAnglesFile() {
  const files = readdirSync(QUEUE_DIR).filter(f => f.startsWith('angles-')).sort();
  if (!files.length) throw new Error('No angles in queue/ — run without --skip-mine');
  return join(QUEUE_DIR, files[files.length - 1]);
}

async function main() {
  const { angles: n, skipMine } = parseArgs();

  if (!skipMine) {
    process.stdout.write(node('mine-angles.js', '--limit', String(n)));
  }

  const anglesFile = newestAnglesFile();
  const { angles } = JSON.parse(readFileSync(anglesFile, 'utf8'));
  logger.info(`Processing ${angles.length} angles from ${anglesFile}`);

  let carousels = 0, scripts = 0, failures = 0;
  for (const [i, angle] of angles.entries()) {
    try {
      if (angle.format === 'reel') {
        if (angle.scriptFile) continue;
        const out = node('generate-script.js', '--angles', anglesFile, '--index', String(i)).trim().split('\n').pop();
        process.stdout.write(node('stage.js', '--script', out,
          ...(angle.ideaRecordId ? ['--idea', angle.ideaRecordId] : [])));
        scripts++;
      } else {
        if (angle.deckFile) continue;
        const deckPath = node('generate-carousel.js', '--angles', anglesFile, '--index', String(i)).trim().split('\n').pop();
        process.stdout.write(python('render_slides.py', '--deck', deckPath));
        process.stdout.write(node('stage.js', '--deck', deckPath));
        carousels++;
      }
    } catch (e) {
      failures++;
      logger.error(`Angle "${angle.title}" failed: ${e.message} — continuing with the rest`);
    }
  }

  logger.success(`Run complete: ${carousels} carousel(s), ${scripts} script(s), ${failures} failure(s).`);
  logger.info('Review in Airtable (Content Calendar, Status: In Production) and post by hand.');
}

main().catch(e => { logger.error(e.message); process.exit(1); });
