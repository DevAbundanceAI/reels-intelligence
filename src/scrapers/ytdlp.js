/**
 * ytdlp.js — Low-level yt-dlp CLI wrapper
 *
 * Two public operations:
 *   scrapeChannelVideos(channelUsername, limit)  → array of raw yt-dlp JSON objects
 *   fetchVideoTranscript(videoId)                → plain-text string | null
 *
 * IMPORTANT — Authentication:
 *   YouTube requires sign-in for full per-video metadata (likes, comments, duration).
 *   By default, this scraper uses --flat-playlist mode which works without auth and
 *   returns: id, title, view_count, url, channel info.
 *   For full metadata, set YOUTUBE_COOKIES_FILE=/path/to/cookies.txt in .env
 *   (export from your browser using yt-dlp's cookie instructions).
 *
 * Test: node src/scrapers/ytdlp.js --test <channelUsername> [limit]
 */

import { spawn }    from 'child_process';
import { readFile, unlink } from 'fs/promises';
import { existsSync }       from 'fs';
import { tmpdir }           from 'os';
import { join }             from 'path';
import { YTDLP_TIMEOUT, YOUTUBE_COOKIES_FILE } from '../config.js';
import { logger }           from '../utils/logger.js';

// Optional: path to a Netscape-format cookies file for authenticated requests
// Set YOUTUBE_COOKIES_FILE in .env — see .env.example for instructions
const COOKIES_FILE = YOUTUBE_COOKIES_FILE;

// ─── Internal: spawn yt-dlp ─────────────────────────────────────────────────

/**
 * Spawns yt-dlp with the given args, collects stdout, rejects on non-zero exit.
 * Prepends --cookies arg automatically if YOUTUBE_COOKIES_FILE is set.
 * Kills child process if timeout fires.
 * @returns {Promise<string>} raw stdout
 */
function spawnYtDlp(args, timeoutMs = YTDLP_TIMEOUT) {
  // Rate-limit when using cookies to avoid burning the session on cloud IPs
  const rateArgs = COOKIES_FILE ? ['--sleep-requests', '1', '--min-sleep-interval', '1'] : [];
  const finalArgs = COOKIES_FILE
    ? ['--cookies', COOKIES_FILE, ...rateArgs, ...args]
    : args;
  return new Promise((resolve, reject) => {
    const chunks = [];
    const errChunks = [];
    let botDetected = false;

    const child = spawn('yt-dlp', finalArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`yt-dlp timed out after ${timeoutMs}ms: yt-dlp ${finalArgs.slice(0, 3).join(' ')} ...`));
    }, timeoutMs);

    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => {
      errChunks.push(chunk);
      // Fast-fail: detect YouTube bot-check error immediately instead of waiting for timeout
      const text = chunk.toString();
      if (!botDetected && text.includes('Sign in to confirm')) {
        botDetected = true;
        clearTimeout(timer);
        child.kill('SIGKILL');
        const err = new Error('YouTube bot-detection: cookies required or expired');
        err.code = 'BOT_DETECTED';
        reject(err);
      }
    });

    child.on('error', err => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(new Error('yt-dlp not found — install it: pip install yt-dlp  OR  brew install yt-dlp'));
      } else {
        reject(err);
      }
    });

    child.on('close', code => {
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks).toString('utf8');
      if (code === 0 || code === null) {
        resolve(stdout);
      } else {
        const stderr = Buffer.concat(errChunks).toString('utf8').slice(0, 500);
        // Exit code 1 with stdout = partial success (some videos failed format check)
        // Return what we got rather than discarding everything
        if (code === 1 && stdout.trim()) {
          resolve(stdout);
          return;
        }
        const err = new Error(`yt-dlp exited ${code}: ${stderr}`);
        err.exitCode = code;
        reject(err);
      }
    });
  });
}

// ─── Internal: VTT → plain text ─────────────────────────────────────────────

/**
 * Strip VTT markup and deduplicate adjacent identical lines.
 * yt-dlp auto-subs repeat each phrase across multiple cue blocks for karaoke display.
 */
export function vttToPlainText(vttContent) {
  const lines = vttContent.split('\n');
  const out   = [];
  let prev    = '';

  for (const raw of lines) {
    const line = raw.trim();

    // Skip header, timestamp lines, empty lines
    if (!line)                                        continue;
    if (line.startsWith('WEBVTT'))                   continue;
    if (line.startsWith('Kind:'))                    continue;
    if (line.startsWith('Language:'))               continue;
    if (/^\d{2}:\d{2}/.test(line))                  continue; // timestamp
    if (/^NOTE\b/.test(line))                        continue;
    if (/^\d+$/.test(line))                          continue; // cue index numbers

    // Strip inline VTT tags like <00:00:01.000>, <c>, </c>
    const clean = line.replace(/<[^>]+>/g, '').trim();
    if (!clean) continue;

    // Deduplicate adjacent identical lines
    if (clean !== prev) {
      out.push(clean);
      prev = clean;
    }
  }

  return out.join(' ').replace(/\s{2,}/g, ' ').trim();
}

// ─── Public: scrape channel videos ──────────────────────────────────────────

/**
 * Fetches up to `limit` videos (including Shorts) from a YouTube channel.
 * Returns an array of raw yt-dlp JSON objects (one per video).
 *
 * Uses --dump-json --no-download so yt-dlp writes one JSON object per line (NDJSON).
 * We try the /shorts URL first; if it yields nothing, fall back to the main channel.
 */
export async function scrapeChannelVideos(channelUsername, limit = 20) {
  // Try /videos first (long-form = has transcripts), then /shorts, then base URL
  const urls = [
    `https://www.youtube.com/@${channelUsername}/videos`,
    `https://www.youtube.com/@${channelUsername}/shorts`,
    `https://www.youtube.com/@${channelUsername}`,          // fallback: channels with no standard tabs
  ];

  // When cookies are available we can fetch full per-video metadata (likes, comments).
  // Without cookies (or if cookies are expired), fall back to --flat-playlist which
  // works without auth and returns: id, title, description, view_count, duration.
  let useFlatPlaylist = !COOKIES_FILE;

  if (useFlatPlaylist) {
    logger.info('  No YOUTUBE_COOKIES_FILE set — using flat-playlist mode (no likes/comments)');
  }

  const buildArgs = (url, flat) => flat
    ? [
        '--flat-playlist',
        '--dump-json',
        '--no-warnings',
        '--quiet',
        '--playlist-items', `1-${limit}`,
        url,
      ]
    : [
        '--dump-json',
        '--no-download',
        '--format', 'sb0/sb1/mhtml/best',  // storyboard format always available on cloud IPs
        '-i',
        '--no-warnings',
        '--quiet',
        '--playlist-items', `1-${limit}`,
        url,
      ];

  for (const url of urls) {
    logger.info(`  Fetching ${limit} videos from ${url}`);

    try {
      const stdout = await spawnYtDlp(buildArgs(url, useFlatPlaylist));
      const lines  = stdout.split('\n').filter(l => l.trim());

      if (lines.length === 0) {
        logger.info(`  No videos at ${url}, trying next URL...`);
        continue;
      }

      const videos = lines.map(line => {
        try   { return JSON.parse(line); }
        catch { return null; }
      }).filter(Boolean);

      logger.info(`  Got ${videos.length} video(s) from ${url}`);
      return videos;

    } catch (err) {
      if (err.code === 'BOT_DETECTED' && !useFlatPlaylist) {
        // Cookies are expired — fall back to flat-playlist for remaining URLs
        logger.warn('  Cookies expired — switching to flat-playlist mode (no likes/comments)');
        useFlatPlaylist = true;
        // Retry the same URL in flat-playlist mode
        try {
          const stdout = await spawnYtDlp(buildArgs(url, true));
          const lines  = stdout.split('\n').filter(l => l.trim());
          if (lines.length > 0) {
            const videos = lines.map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
            logger.info(`  Got ${videos.length} video(s) from ${url} (flat-playlist fallback)`);
            return videos;
          }
        } catch (retryErr) {
          logger.warn(`  Flat-playlist retry also failed ${url}: ${retryErr.message}`);
        }
      } else {
        logger.warn(`  Failed ${url}: ${err.message}`);
      }
      // Try next URL
    }
  }

  logger.warn(`  No videos found for @${channelUsername}`);
  return [];
}

// ─── Public: fetch transcript ────────────────────────────────────────────────

/**
 * Downloads auto-generated English captions for a videoId.
 * Returns plain-text transcript string, or null if no captions available.
 * Never throws — missing captions are expected and handled gracefully.
 */
export async function fetchVideoTranscript(videoId) {
  const outputTemplate = join(tmpdir(), `ytdlp_${videoId}.%(ext)s`);
  const args = [
    '--write-auto-subs',
    '--sub-lang',     'en',
    '--sub-format',   'vtt',
    '--skip-download',
    '--format',       'sb0/mhtml/best',  // bypass cloud-IP format restriction
    '--no-warnings',
    '--quiet',
    '--output',       outputTemplate,
    '--',             videoId,
  ];

  try {
    await spawnYtDlp(args);
  } catch (err) {
    // Exit code 1 = no captions (very common) — not an error worth logging loudly
    if (err.exitCode === 1 || err.message.includes('no subtitles')) {
      return null;
    }
    logger.warn(`  Transcript fetch failed for ${videoId}: ${err.message}`);
    return null;
  }

  // yt-dlp names the file with the actual language code, e.g. ytdlp_{id}.en.vtt
  // Try both naming patterns
  const candidates = [
    join(tmpdir(), `ytdlp_${videoId}.en.vtt`),
    join(tmpdir(), `ytdlp_${videoId}.en-orig.vtt`),
    join(tmpdir(), `ytdlp_${videoId}.vtt`),
  ];

  for (const filePath of candidates) {
    if (existsSync(filePath)) {
      try {
        const content = await readFile(filePath, 'utf8');
        const text    = vttToPlainText(content);
        // Clean up temp file
        unlink(filePath).catch(() => {});
        return text || null;
      } catch {
        return null;
      }
    }
  }

  return null;
}

// ─── CLI test ────────────────────────────────────────────────────────────────

if (process.argv[1].endsWith('ytdlp.js') && process.argv[2] === '--test') {
  const handle = process.argv[3] || 'alexhormozi';
  const limit  = parseInt(process.argv[4] || '2');

  import('../config.js').then(async () => {
    logger.info(`Testing yt-dlp scraper for @${handle} (limit: ${limit})`);

    const videos = await scrapeChannelVideos(handle, limit);
    if (videos.length === 0) {
      logger.warn('No videos returned. Is yt-dlp installed? Run: pip install yt-dlp');
      process.exit(1);
    }

    for (const v of videos) {
      logger.info(`  [${v.id}] ${v.title?.slice(0, 60)} | views: ${v.view_count} | duration: ${v.duration}s`);
    }

    logger.info('');
    logger.info(`Fetching transcript for first video: ${videos[0].id}`);
    const transcript = await fetchVideoTranscript(videos[0].id);
    if (transcript) {
      logger.success(`  Transcript (${transcript.length} chars): ${transcript.slice(0, 150)}...`);
    } else {
      logger.info('  No transcript available (normal for many videos)');
    }

    logger.success('yt-dlp test complete');
  });
}
