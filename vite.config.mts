import { resolve } from 'node:path'
import devServer from '@hono/vite-dev-server'
import mockDiff from '@qtmleap/vite-plugin-mock-diff'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

export default defineConfig({
  base: './',
  server: {
    port: 3457,
    host: true,
    allowedHosts: true
  },
  resolve: {
    alias: [{ find: '@', replacement: resolve(import.meta.dirname, './src') }],
    // Force a single physical copy of React into the bundle. node_modules
    // can end up with duplicate react/react-dom (e.g. a stale .pnpm store
    // beside .bun, or a dep pinning its own react), and two copies mean two
    // hook dispatchers → "Invalid hook call" at runtime (next-themes vs the
    // app loading different Reacts). dedupe collapses them to the hoisted one.
    dedupe: ['react', 'react-dom']
  },
  plugins: [
    // The Mock Diff Viewer (the `mock-diff` sidecar in
    // .devcontainer/compose.yaml) at /mock-diff/ on this dev server, so the
    // mocks and their implementations are compared on the port already
    // forwarded. Serve-only; a build never sees it. First, before the Hono
    // dev server, as the plugin asks: a plugin that answers every request
    // itself would otherwise shadow the relay. The sidecar shares the app
    // container's network, so the plugin's default target, localhost:12355,
    // is the sidecar.
    mockDiff(),
    react(),
    tailwindcss(),
    viteSingleFile(),
    devServer({
      entry: './src/index.ts',
      // Hono owns /api/*, /v1/*, /health, and the claude OAuth loopback
      // callback /callback. Every other path (the SPA at /, Vite's /@...
      // module shims, /src/..., favicons, static assets) goes through
      // Vite. The callback must be served by the backend so the
      // auto-exchange + sync runs server-side instead of bouncing
      // through the SPA. Codex's callback hits a separate standalone
      // listener on localhost:1455 (see
      // services/codex-callback-listener.ts), so it doesn't go through
      // Vite at all.
      //
      // /health is mounted at the root rather than under /api because it
      // is a probe endpoint outside the APIKEY gate. Without it listed
      // here, dev served the SPA's HTML for it and every health read
      // failed to parse — so the shell reported the server unreachable
      // while talking to it perfectly well.
      exclude: [/^(?!\/api\/|\/v1\/|\/health(?:\?|$)|\/callback(?:\?|$)).*$/]
    })
  ]
})
