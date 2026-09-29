import { useSyncExternalStore } from 'react'

/**
 * Below this width the app draws its phone layout: a bottom tab bar in
 * place of the sidebar, and a short list per screen in place of its
 * tables.
 *
 * The same pixel as Tailwind's `md`, so a component that branches on
 * `usePhone()` and a class written `md:` / `max-md:` always agree about
 * which layout they are in. It sits well under the shell's own 1024px
 * rail breakpoint: a tablet keeps the folded sidebar and the full
 * screens, and only a width that cannot hold a table at all loses them.
 */
const PHONE_QUERY = '(max-width: 767px)'

function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(PHONE_QUERY)
  mql.addEventListener('change', onChange)
  return () => mql.removeEventListener('change', onChange)
}

const snapshot = (): boolean => window.matchMedia(PHONE_QUERY).matches

/**
 * Whether the phone layout applies.
 *
 * Read synchronously rather than set from an effect, the way shadcn's
 * `useIsMobile` does: that one answers `false` on the first render, so a
 * phone painted the desktop tables for a frame and then swapped them out
 * — a visible jump on every navigation.
 */
export function usePhone(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false)
}
