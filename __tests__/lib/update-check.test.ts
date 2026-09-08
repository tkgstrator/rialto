/**
 * Update check.
 *
 * Two failures this pins down, both of which looked correct on screen:
 *
 * - The old comparison mapped `Number` over the dot-parts, so any tag it
 *   could not read (`v2.77.0-rc.1`) became NaN, every comparison against
 *   NaN is false, and the function returned 0 — "same version".
 * - A failed lookup was reported as `hasUpdate: false`, which the UI drew
 *   as the green "up to date" pill. An install with no egress therefore
 *   claimed to be current without ever having asked.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { checkForUpdates, compareVersions } from '../../src/services/update'

const originalFetch = globalThis.fetch

const release = (tag: string) => ({
  tag_name: tag,
  html_url: `https://github.com/tkgstrator/rialto/releases/tag/${tag}`,
  body: '### Fixes\n- something',
  published_at: '2026-09-04T10:59:38Z'
})

/** URLs the service asked for, so the cache assertions can count them. */
const calls: string[] = []

function respondWith(make: () => Response | Promise<Response>) {
  const stub: typeof globalThis.fetch = async (input) => {
    calls.push(String(input))
    return make()
  }
  globalThis.fetch = stub
}

beforeEach(() => {
  calls.length = 0
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

describe('compareVersions', () => {
  test('orders by numeric part, not lexically', () => {
    expect(compareVersions('2.76.0', '2.9.0')).toBe(1)
    expect(compareVersions('2.9.0', '2.76.0')).toBe(-1)
    expect(compareVersions('2.76.0', '2.76.0')).toBe(0)
  })

  test('accepts the v-prefixed release tag', () => {
    expect(compareVersions('v2.77.0', '2.76.0')).toBe(1)
  })

  test('ranks a release above its own prereleases', () => {
    expect(compareVersions('2.77.0', '2.77.0-rc.1')).toBe(1)
    expect(compareVersions('2.77.0-rc.1', '2.77.0')).toBe(-1)
    expect(compareVersions('2.77.0-rc.2', '2.77.0-rc.1')).toBe(1)
  })

  test('reports "cannot tell" rather than "equal" for an unreadable version', () => {
    expect(compareVersions('nightly', '2.76.0')).toBeNull()
    expect(compareVersions('2.76', '2.76.0')).toBeNull()
  })
})

describe('checkForUpdates', () => {
  test('reports a newer release, with its notes and permalink', async () => {
    respondWith(() => Response.json(release('v2.80.0')))
    const result = await checkForUpdates('2.76.0', true)
    expect(result.status).toBe('ok')
    expect(result.hasUpdate).toBe(true)
    expect(result.currentVersion).toBe('2.76.0')
    expect(result.latestVersion).toBe('2.80.0')
    expect(result.releaseUrl).toBe('https://github.com/tkgstrator/rialto/releases/tag/v2.80.0')
    expect(result.changelog).toContain('Fixes')
    expect(result.message).toBeNull()
    // The npm registry is not this project's release channel; asking it
    // reported the upstream fork's version as an available update.
    expect(calls[0]).toBe('https://api.github.com/repos/tkgstrator/rialto/releases/latest')
  })

  test('reports no update when the running version is the release', async () => {
    respondWith(() => Response.json(release('v2.76.0')))
    const result = await checkForUpdates('2.76.0', true)
    expect(result.status).toBe('ok')
    expect(result.hasUpdate).toBe(false)
    expect(result.latestVersion).toBe('2.76.0')
  })

  test('a rate-limited feed is an error, not "up to date"', async () => {
    respondWith(() => new Response('rate limited', { status: 403 }))
    const result = await checkForUpdates('2.76.0', true)
    expect(result.status).toBe('error')
    expect(result.hasUpdate).toBe(false)
    expect(result.latestVersion).toBeNull()
    expect(result.message).toContain('rate-limited')
    expect(result.currentVersion).toBe('2.76.0')
  })

  test('an unreachable feed is an error, not "up to date"', async () => {
    respondWith(() => Promise.reject(new Error('getaddrinfo ENOTFOUND')))
    const result = await checkForUpdates('2.76.0', true)
    expect(result.status).toBe('error')
    expect(result.message).toContain('Could not reach')
  })

  test('a body that is not a release is an error, not a version', async () => {
    respondWith(() => Response.json({ message: 'Not Found' }))
    const result = await checkForUpdates('2.76.0', true)
    expect(result.status).toBe('error')
    expect(result.latestVersion).toBeNull()
  })

  test('a tag it cannot read is an error rather than a silent match', async () => {
    respondWith(() => Response.json(release('nightly')))
    const result = await checkForUpdates('2.76.0', true)
    expect(result.status).toBe('error')
    expect(result.message).toContain('nightly')
  })

  // One test rather than several: the cache is module state, so the
  // sequence is the assertion.
  test('caches a success, refetches on force, and never caches a failure', async () => {
    respondWith(() => Response.json(release('v2.80.0')))
    await checkForUpdates('2.76.0', true)
    expect(calls.length).toBe(1)

    // A screen re-mounting must not spend the anonymous GitHub limit.
    const cached = await checkForUpdates('2.76.0')
    expect(calls.length).toBe(1)
    expect(cached.latestVersion).toBe('2.80.0')

    // "Check now" is the one path that always goes out.
    await checkForUpdates('2.76.0', true)
    expect(calls.length).toBe(2)

    // A transient failure answers honestly but must not become the
    // remembered state — the next unforced read still has the last good
    // answer to show.
    respondWith(() => new Response('down', { status: 500 }))
    const failed = await checkForUpdates('2.76.0', true)
    expect(failed.status).toBe('error')
    expect(calls.length).toBe(3)
    const afterFailure = await checkForUpdates('2.76.0')
    expect(afterFailure.status).toBe('ok')
    expect(afterFailure.latestVersion).toBe('2.80.0')
    expect(calls.length).toBe(3)
  })
})
