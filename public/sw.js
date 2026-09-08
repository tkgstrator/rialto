/**
 * Rialto's service worker.
 *
 * Hand-written rather than generated: the caching rules are four lines of
 * policy, and a generated worker would be harder to reason about than the
 * thing it replaces. Its only job is to make the installed app open
 * instantly and survive a dropped connection — it is deliberately NOT a
 * data cache.
 *
 * Rules:
 *   - /api, /v1, /health, /callback   never touched (stale routing state
 *                                     or a replayed proxy call would be
 *                                     worse than an error)
 *   - navigations                     network-first, falling back to the
 *                                     cached shell when offline
 *   - static assets                   cache-first (the build is a single
 *                                     hashed HTML file plus icons)
 *   - everything else                 pass through untouched
 *
 * Bump CACHE_NAME only to force-evict every client; ordinary deploys do
 * not need it, because the shell is revalidated on every navigation.
 */

const CACHE_NAME = 'rialto-v1'
const SHELL_URL = '/'
const STATIC_EXTENSIONS = /\.(js|css|png|jpg|jpeg|svg|ico|webp|woff2?)$/
// Paths the server owns. `/callback` completes an OAuth exchange and
// `/api/request-logs/sse` is an open event stream — a worker sitting in
// front of either can only do harm.
const SERVER_PATHS = /^\/(api|v1|health|callback)(\/|$|\?)/

self.addEventListener('install', (event) => {
  // Warm the shell so the very first offline navigation has something to
  // fall back to; without this the fallback only works after a visit
  // that happened to be cached by something else.
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.add(SHELL_URL))
      .catch(() => undefined)
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (SERVER_PATHS.test(url.pathname)) return

  // Navigations: always try the network so a redeployed shell lands on
  // the next load, and fall back to the cached copy only when the
  // network is genuinely unavailable.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(SHELL_URL, copy))
          }
          return response
        })
        .catch(() => caches.match(SHELL_URL).then((cached) => cached || Response.error()))
    )
    return
  }

  // A query string means a versioned or one-off asset (Vite's dev deps
  // are the common case). Caching those by URL grows the cache without
  // ever serving a hit.
  if (!STATIC_EXTENSIONS.test(url.pathname) || url.search !== '') return

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
        }
        return response
      })
    })
  )
})
