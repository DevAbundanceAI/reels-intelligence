import { defineMiddleware } from 'astro:middleware';
import { env } from './lib/env';

// Optional basic auth. Enforced only when BOTH credentials are set so
// local dev without them stays open. In Cloudflare Pages, set both as
// secrets and the dashboard is gated.
export const onRequest = defineMiddleware(async (context, next) => {
  const user = env('OPS_BASIC_AUTH_USER');
  const pass = env('OPS_BASIC_AUTH_PASS');

  if (!user || !pass) return next();

  const header = context.request.headers.get('authorization') ?? '';
  if (!header.startsWith('Basic ')) return unauthorized();

  let decoded: string;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return unauthorized();
  }
  const idx = decoded.indexOf(':');
  const providedUser = idx === -1 ? decoded : decoded.slice(0, idx);
  const providedPass = idx === -1 ? '' : decoded.slice(idx + 1);

  if (providedUser !== user || providedPass !== pass) return unauthorized();
  return next();
});

function unauthorized() {
  return new Response('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Reels Intelligence Ops", charset="UTF-8"',
    },
  });
}
