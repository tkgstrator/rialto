/**
 * Update check.
 *
 * Rialto ships as a Docker image built from a GitHub release
 * (`.github/workflows/docker-publish.yml` fires on a `v*.*.*` tag), so
 * that repository's releases feed is the only thing that knows what
 * "latest" means for this deployment.
 *
 * It used to ask the npm registry for `@musistudio/claude-code-router`,
 * the upstream project this was forked from. Nothing here is published to
 * npm, so that answer was never about this install: it reported the
 * fork's 3.x as an available update for a 2.x Rialto, on every load of
 * the Server settings screen.
 */

import { z } from '@hono/zod-openapi'
import dayjs from '../lib/dayjs'
import { logger } from '../logger'
import type { UpdateCheckResponse } from '../schemas/api/update'

const GITHUB_REPO = 'tkgstrator/rialto'
const LATEST_RELEASE_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`

// Anonymous GitHub API calls are limited to 60/hour per IP, and the
// Server screen checks on every mount. Only successful answers are
// cached — a transient failure must not stick around pretending to be
// the current state — and the explicit "Check now" button passes
// `force` to bypass it.
const CACHE_TTL_MS = 10 * 60 * 1000
const REQUEST_TIMEOUT_MS = 8_000

const cache: { result: UpdateCheckResponse | null; storedAt: number } = { result: null, storedAt: 0 }

// The four fields of the release payload this reads. Parsed rather than
// trusted: a proxy or a captive portal answers 200 with a body of its
// own, and a missing tag must read as "could not check" rather than as a
// version. No draft/prerelease filter is needed — `/releases/latest`
// already excludes both.
const GithubReleaseSchema = z.object({
  tag_name: z.string().nonempty(),
  html_url: z.url(),
  body: z.string().nullish(),
  published_at: z.string().nullish()
})

interface SemVer {
  readonly core: readonly number[]
  readonly prerelease: string | null
}

/** `v2.76.0` / `2.76.0-rc.1` → parts. Null when it is not a version. */
function parseVersion(raw: string): SemVer | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(raw.trim())
  if (match === null) return null
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? null : match[4]
  }
}

/**
 * -1 / 0 / 1, or null when either side is not a version.
 *
 * The null matters: the previous implementation mapped `Number` over the
 * dot-parts, so `2.76.0-rc.1` produced NaN, every comparison against NaN
 * is false, and the function returned 0 — "identical versions" — for two
 * versions it had failed to read.
 */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) return null

  const differing = left.core.findIndex((part, i) => part !== right.core[i])
  if (differing !== -1) return left.core[differing] > right.core[differing] ? 1 : -1

  // Semver's own rule: a release outranks any prerelease of the same
  // core version, so 2.77.0 > 2.77.0-rc.1 rather than the string order.
  if (left.prerelease === right.prerelease) return 0
  if (left.prerelease === null) return 1
  if (right.prerelease === null) return -1
  return left.prerelease > right.prerelease ? 1 : -1
}

function failure(currentVersion: string, message: string): UpdateCheckResponse {
  return {
    status: 'error',
    currentVersion,
    latestVersion: null,
    hasUpdate: false,
    changelog: null,
    releaseUrl: null,
    publishedAt: null,
    checkedAt: dayjs().toISOString(),
    message
  }
}

/** Absent, null or empty all mean "the release did not carry this". */
function blankToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === '') return null
  return value
}

/** Why the feed said no, in words an operator can act on. */
function httpFailureMessage(status: number): string {
  if (status === 404) return `${GITHUB_REPO} has no published release to compare against.`
  if (status === 403 || status === 429) return 'GitHub rate-limited the update check. Try again in a few minutes.'
  return `GitHub returned HTTP ${status}.`
}

export async function checkForUpdates(currentVersion: string, force = false): Promise<UpdateCheckResponse> {
  const cached = cache.result
  if (!force && cached !== null && dayjs().valueOf() - cache.storedAt < CACHE_TTL_MS) {
    // The running version cannot change under a cached answer, but
    // re-stamping it keeps the response describing this process rather
    // than whatever was current when the entry was stored.
    return { ...cached, currentVersion }
  }

  const response = await fetch(LATEST_RELEASE_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      // GitHub rejects API calls with no User-Agent outright.
      'User-Agent': `rialto/${currentVersion}`
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  }).catch((error: unknown) => {
    logger.error({ err: error }, 'Update check could not reach the GitHub releases feed')
    return null
  })

  if (response === null) return failure(currentVersion, 'Could not reach the GitHub releases feed.')
  if (!response.ok) {
    logger.error({ status: response.status }, 'Update check rejected by the GitHub releases feed')
    return failure(currentVersion, httpFailureMessage(response.status))
  }

  const body = await response.json().catch(() => null)
  const parsed = GithubReleaseSchema.safeParse(body)
  if (!parsed.success) {
    logger.error({ err: parsed.error }, 'Update check got an unexpected release payload')
    return failure(currentVersion, 'The GitHub releases feed answered with an unexpected shape.')
  }

  const release = parsed.data
  const latestVersion = release.tag_name.replace(/^v/, '')
  const comparison = compareVersions(latestVersion, currentVersion)
  if (comparison === null) {
    logger.error({ latestVersion, currentVersion }, 'Update check could not compare the two versions')
    return failure(currentVersion, `Could not compare the running version with the release tag ${release.tag_name}.`)
  }

  const result: UpdateCheckResponse = {
    status: 'ok',
    currentVersion,
    latestVersion,
    hasUpdate: comparison > 0,
    changelog: blankToNull(release.body),
    releaseUrl: release.html_url,
    publishedAt: blankToNull(release.published_at),
    checkedAt: dayjs().toISOString(),
    message: null
  }
  cache.result = result
  cache.storedAt = dayjs().valueOf()
  return result
}

export async function performUpdate() {
  // The production deployment runs as an immutable container image
  // (oven/bun, no npm). An in-place `npm update -g` cannot work and
  // would only corrupt the running install, so this is intentionally
  // a no-op that tells the operator how to actually upgrade.
  return {
    success: false,
    message:
      'Self-update is not available in this deployment. Pull the latest image and redeploy (e.g. `docker compose pull && docker compose up -d`).'
  }
}
