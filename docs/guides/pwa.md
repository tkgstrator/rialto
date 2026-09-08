# PWA / installed app

Rialto installs as a standalone app so it opens without browser chrome —
which is the whole point on a tablet or a phone, where the address bar and
tab strip eat a third of a screen that is already narrow.

The implementation is deliberately small: a manifest, an icon set, a
service worker of about sixty lines, and the safe-area handling the
installed window needs. There is no PWA build plugin.

## What is in it

| File | Role |
|---|---|
| `public/manifest.json` | Name, display mode, theme colours, icon set |
| `public/sw.js` | Service worker: offline shell, static-asset cache |
| `public/icon-*.png`, `public/apple-touch-icon.png`, `public/favicon.svg` | The icon set |
| `scripts/build-pwa-icons.ts` | Draws the PNGs (`bun run pwa:icons`) |
| `src/app/pwa.ts` | Registration, production only |
| `index.html` | Manifest link, iOS meta tags, `viewport-fit=cover`, `<base href="/">` |
| `src/index.css` | `.safe-area-inset` |

## Display mode

```json
"display": "standalone",
"display_override": ["fullscreen", "standalone", "minimal-ui"]
```

`display_override` is tried first, so a browser that supports `fullscreen`
gives a window with no status bar at all; everything else — iOS included,
which reads `apple-mobile-web-app-capable` rather than the manifest —
falls back to `standalone`. Drop `"fullscreen"` from the override list to
keep the system status bar.

The iOS status bar style is `default` rather than `black-translucent` on
purpose: translucent draws white status-bar text over the app's own
header, which vanishes against the light theme.

## Caching

The worker is an offline shell, not a data cache.

| Request | Strategy |
|---|---|
| `/api`, `/v1`, `/health`, `/callback` | Never touched |
| Navigations | Network-first, cached shell as the offline fallback |
| `.js` `.css` `.png` `.svg` `.woff2` … without a query string | Cache-first |
| Everything else | Passed through |

API responses are never cached. Routing state, quota and activity are
exactly the things that must not be stale, and an offline copy of them
would be a bug report waiting to happen. Opened offline, the app renders
its shell and its data fetches fail — which is the honest outcome.

Bump `CACHE_NAME` in `public/sw.js` only to force every client to drop its
cache; ordinary deploys do not need it, because the shell is revalidated
on every navigation.

## Development

`registerServiceWorker()` returns early unless `import.meta.env.PROD`.
Vite serves the module graph as individual files in dev, and a cache-first
worker in front of that turns into "my edit did nothing". To exercise the
worker, build and run the server:

```bash
bun run build && bun run src/index.ts     # then open the server's port
```

If a worker ever does get registered against the dev server, unregister it
in DevTools → Application → Service Workers; a stale one survives a plain
reload.

## Icons

```bash
bun run pwa:icons
```

The mark — a bridge: deck, arch, ground — is drawn from primitives in
`scripts/build-pwa-icons.ts` and rasterised with a small PNG encoder over
`node:zlib`, so there is no image toolchain in the repo and the design is
a code edit rather than a binary swap. Output is deterministic: an
unchanged design regenerates byte-identical files.

Replacing the mark means editing `GLYPH` (or dropping in your own PNGs at
the same four paths). The maskable icon is full-bleed with the glyph at
46% so it survives any platform crop; `apple-touch-icon.png` is also
full-bleed, because iOS applies its own corner mask and composites over
black.

## Why `<base href="/">`

The server answers every unmatched path with the SPA, and
`vite-plugin-singlefile` emits the remaining asset references as relative
URLs. Without a base, reloading `/activity/sessions` requests
`/activity/manifest.json` — which returns `index.html` with a 200, so the
manifest silently fails to parse and the app is not installable from any
deep link. The same applied to the remixicon sprite, whose icons were
already broken on a deep-link reload.

## Not included

- **Update notifications.** Version detection and the update banner belong
  to the update-check feature (`/api/update/check`), not to the worker.
- **Offline data.** See Caching above.
- **Push notifications.** No subscription flow, and nothing to push.
