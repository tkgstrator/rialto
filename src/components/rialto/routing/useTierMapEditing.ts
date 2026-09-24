/**
 * Editing operations on the tier map's draft.
 *
 * Kept out of the table: every mutation is the same "replace one group
 * inside the per-tier record" shape, and inlining each of them next to
 * the markup is what turned the old preference editor into an 800-line
 * file.
 */
import { useMemo } from 'react'
import { hasRoute, moveRoute } from './derive'
import type { DraftRoute, RouteTier, TierDraft } from './types'

export interface TierMapActions {
  onToggle: (tier: RouteTier, index: number, enabled: boolean) => void
  onMove: (tier: RouteTier, from: number, to: number) => void
  onRemove: (tier: RouteTier, index: number) => void
  onAdd: (tier: RouteTier, route: DraftRoute) => void
}

export function useTierMapEditing(setDraft: React.Dispatch<React.SetStateAction<TierDraft>>): TierMapActions {
  return useMemo<TierMapActions>(() => {
    const mutate = (tier: RouteTier, fn: (prev: DraftRoute[]) => DraftRoute[]) =>
      setDraft((prev) => ({ ...prev, routes: { ...prev.routes, [tier]: fn(prev.routes[tier]) } }))
    return {
      onToggle: (tier, index, enabled) =>
        mutate(tier, (prev) => prev.map((route, i) => (i === index ? { ...route, enabled } : route))),
      onMove: (tier, from, to) => mutate(tier, (prev) => moveRoute(prev, from, to)),
      onRemove: (tier, index) => mutate(tier, (prev) => prev.filter((_, i) => i !== index)),
      // The dialog already refuses a duplicate; checked again here because
      // the draft is what gets written, and the server would drop the
      // second copy with a warning the operator never asked for.
      onAdd: (tier, route) =>
        mutate(tier, (prev) => (hasRoute(prev, route.provider, route.targetTier) ? prev : [...prev, route]))
    }
  }, [setDraft])
}
