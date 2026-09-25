/**
 * Both PWA failures seen behind Cloudflare Access were deploy wiring, not
 * code: nothing at runtime says why an install is broken, the console only
 * says the worker is text/html or the manifest hit CORS. So the wiring is
 * pinned here instead.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const dockerfile = readFileSync('Dockerfile', 'utf8')
const indexHtml = readFileSync('index.html', 'utf8')

describe('PWA deploy wiring', () => {
  test('the image builder copies public/ before `bun run build`', () => {
    // Without it dist/ has no sw.js or manifest.json and the SPA fallback
    // answers them with index.html.
    const builder = dockerfile.slice(0, dockerfile.indexOf('RUN bun run build'))
    expect(builder).toMatch(/^COPY public \.\/public$/m)
  })

  test('the manifest is fetched with credentials', () => {
    // A credential-less manifest fetch has no CF_Authorization cookie, so
    // Access redirects it to its cross-origin login page.
    expect(indexHtml).toMatch(/<link rel="manifest" href="\/manifest\.json" crossorigin="use-credentials" \/>/)
  })
})
