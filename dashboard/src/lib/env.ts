// Cross-runtime env reader.
//
// Cloudflare Workers expose env via the Cloudflare runtime when the
// adapter is in use. Node adapter does not auto-load .env into
// process.env — Astro only loads it into import.meta.env. To keep page
// code identical across both runtimes, we read from process.env and
// pre-populate it from .env when running under Node.
//
// In Cloudflare production, this import is a no-op: nodejs_compat shims
// process.env from the Worker's bindings.

// Top-level dynamic import so this runs once at module init in Node.
// Wrapped in try/catch to no-op in environments without fs.
if (typeof process !== 'undefined' && process.versions?.node) {
  try {
    // dotenv/config auto-loads .env from cwd into process.env
    await import('dotenv/config');
  } catch {
    // dotenv missing or not Node — fall through to whatever's already set.
  }
}

const viteEnv = (import.meta as any).env ?? {};

export function env(key: string): string | undefined {
  if (typeof process !== 'undefined' && process.env?.[key]) {
    return process.env[key];
  }
  if (viteEnv[key]) return viteEnv[key];
  return (globalThis as any)?.[key];
}
