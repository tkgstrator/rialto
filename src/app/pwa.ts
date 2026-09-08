/**
 * Service-worker registration.
 *
 * Called from `main.tsx` before the first render rather than from a
 * component effect, so registration is not one hydration cycle behind the
 * first navigation. There is no import waterfall to avoid here — the
 * production build is a single inlined HTML file, so the worker is
 * requested as soon as the bundle evaluates either way.
 *
 * Development is deliberately excluded. Vite serves module graph entries
 * that a cache-first worker would happily pin, and the resulting "my edit
 * did nothing" is a bad trade for a feature that only matters once the
 * app is installed.
 */

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return
  if (!('serviceWorker' in navigator)) return
  navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
    // A failed registration costs the offline shell and nothing else, so
    // it is reported rather than surfaced: the app itself still works.
    console.warn('[pwa] service worker registration failed', error)
  })
}
