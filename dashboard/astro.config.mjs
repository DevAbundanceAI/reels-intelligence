// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import cloudflare from '@astrojs/cloudflare';
import node from '@astrojs/node';

// Adapter swap: ADAPTER=node for local preview (Cloudflare's miniflare runner
// hits "require_dist is not a function" in this Codespace). Anything else
// (or unset) uses the Cloudflare adapter — what production deploys with.
const useNode = process.env.ADAPTER === 'node';

export default defineConfig({
  output: 'server',
  adapter: useNode
    ? node({ mode: 'standalone' })
    : cloudflare(),
  vite: {
    plugins: [tailwindcss()],
  },
});
