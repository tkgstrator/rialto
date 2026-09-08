import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { APP_VERSION } from '@/version'

/**
 * The version the *server* is running.
 *
 * `APP_VERSION` is compiled into the bundle, so it names the build the
 * browser downloaded — which after an image upgrade is whatever is still
 * in the cache, not the process answering the requests. `/health` is
 * public, unauthenticated and cheap, so ask it once per page load and
 * fall back to the build constant until it answers (or if it never does).
 *
 * Memoised at module scope: three call sites mount at different times and
 * none of them needs its own probe.
 */
const cache: { version: string | null; pending: Promise<string> | null } = { version: null, pending: null }

function fetchServerVersion(): Promise<string> {
  if (cache.pending === null) {
    cache.pending = api
      .getHealth()
      .then((health) => (health.version === undefined ? APP_VERSION : health.version))
      .catch(() => APP_VERSION)
      .then((version) => {
        cache.version = version
        return version
      })
  }
  return cache.pending
}

export function useAppVersion(): string {
  const [version, setVersion] = useState(cache.version === null ? APP_VERSION : cache.version)

  useEffect(() => {
    const live = { current: true }
    fetchServerVersion().then((v) => {
      if (live.current) setVersion(v)
    })
    return () => {
      live.current = false
    }
  }, [])

  return version
}
