/**
 * linkedin-engine/auth.js — the LinkedIn OAuth round trip that mints a
 * 60-day member access token for Ryan's own profile. Non-Marketing-
 * Developer-Platform apps get no programmatic refresh, so this is meant
 * to be re-run roughly every 60 days by hand.
 *
 * Two steps (run --start, send the URL to Ryan, get the redirected URL
 * back, run --callback):
 *
 *   node linkedin-engine/auth.js --start
 *     -> prints an authorization URL. Ryan opens it in HIS OWN browser
 *        (logged in as himself), clicks Allow, and is redirected to
 *        LINKEDIN_REDIRECT_URI (itsryanfrost.com) with ?code=...&state=...
 *        in the address bar. He copies that full URL back.
 *
 *   node linkedin-engine/auth.js --callback "<the full redirected URL>"
 *     -> exchanges the code for an access token, resolves the person URN
 *        via /v2/userinfo, and prints the three lines to paste into .env
 *        (and the Trigger.dev dashboard for prod). Writes nothing to disk.
 *
 * Prerequisite: a LinkedIn developer app ("Ryan Frost Publisher") with
 * the self-serve "Share on LinkedIn" and "Sign In with LinkedIn using
 * OpenID Connect" products added, and LINKEDIN_CLIENT_ID / _SECRET /
 * _REDIRECT_URI set in .env from that app's Auth tab.
 */

import { randomBytes } from 'crypto';
import {
  LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET, LINKEDIN_REDIRECT_URI,
} from '../src/config.js';
import { getUserInfo } from '../src/linkedin/api.js';
import { logger } from './shared.js';

const AUTH_BASE = 'https://www.linkedin.com/oauth/v2/authorization';
const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const SCOPES = 'openid profile w_member_social';

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (flag) => { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : null; };
  return { start: a.includes('--start'), callback: get('--callback') };
}

function requireApp() {
  if (!LINKEDIN_CLIENT_ID || !LINKEDIN_CLIENT_SECRET) {
    throw new Error(
      'LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET are not set.\n' +
      'Create the app at linkedin.com/developers first: name it "Ryan Frost Publisher",\n' +
      'associate it with a LinkedIn company page, verify it, then add the "Share on\n' +
      'LinkedIn" and "Sign In with LinkedIn using OpenID Connect" products. Copy the\n' +
      'Client ID / Client Secret from the app\'s Auth tab into .env.'
    );
  }
}

function start() {
  requireApp();
  const state = randomBytes(12).toString('hex');
  const url = new URL(AUTH_BASE);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', LINKEDIN_CLIENT_ID);
  url.searchParams.set('redirect_uri', LINKEDIN_REDIRECT_URI);
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', state);

  console.log('\nSend this URL to Ryan. He must open it in HIS OWN browser, already logged');
  console.log('into his own LinkedIn account, and click Allow:\n');
  console.log(url.toString());
  console.log(`\nExpected state (for your own reference, not required for --callback): ${state}`);
  console.log('\nAfter he clicks Allow, LinkedIn redirects to:');
  console.log(`  ${LINKEDIN_REDIRECT_URI}?code=...&state=...`);
  console.log('Have him copy that FULL address-bar URL back to you (the code expires in');
  console.log('about 30 minutes, so do this on a call), then run:\n');
  console.log('  node linkedin-engine/auth.js --callback "<the full redirected URL>"\n');
}

async function callback(redirectedUrl) {
  requireApp();
  const url = new URL(redirectedUrl);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (error) throw new Error(`LinkedIn returned an error: ${error} — ${url.searchParams.get('error_description') || ''}`);
  if (!code) throw new Error('No ?code= found in that URL. Paste the exact address bar URL after clicking Allow.');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: LINKEDIN_REDIRECT_URI,
    client_id: LINKEDIN_CLIENT_ID,
    client_secret: LINKEDIN_CLIENT_SECRET,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Token exchange failed ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const token = await res.json(); // { access_token, expires_in, scope, token_type }

  const info = await getUserInfo(token.access_token);
  const personUrn = `urn:li:person:${info.sub}`;
  const expiresAt = new Date(Date.now() + token.expires_in * 1000).toISOString();

  console.log('\nSuccess. Paste these into .env AND into the Trigger.dev dashboard (prod env):\n');
  console.log(`LINKEDIN_ACCESS_TOKEN=${token.access_token}`);
  console.log(`LINKEDIN_PERSON_URN=${personUrn}`);
  console.log(`LINKEDIN_TOKEN_EXPIRES_AT=${expiresAt}`);
  console.log(`\nSigned in as: ${info.name || info.sub}`);
  console.log(`Token expires: ${expiresAt} (~${Math.round(token.expires_in / 86400)} days from now)`);
  console.log('\nSet a calendar reminder a few days before that date to re-run this script.');
}

async function main() {
  const { start: doStart, callback: redirectedUrl } = parseArgs();
  if (doStart) return start();
  if (redirectedUrl) return callback(redirectedUrl);
  throw new Error('Pass --start, or --callback "<full redirected URL>"');
}

main().catch(e => { logger.error(e.message); process.exit(1); });
