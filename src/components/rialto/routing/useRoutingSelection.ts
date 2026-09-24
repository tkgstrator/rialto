/**
 * The Routing screen's one selector, held in the URL.
 *
 * The surface is the screen's outermost axis, so it has to be addressable:
 * "the routing for /v1/responses" is the thing this screen exists to make
 * discussable, and in local state it survives neither a reload nor a link.
 *
 * It used to carry a scenario and a lane beside it. The tier map is one
 * table per profile, so there is nothing left to pick below the surface;
 * a stale `?scenario=` or `?lane=` in an old link is simply ignored.
 */
import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { InboundSurfaceWire, SurfaceId } from '@/lib/api'

export interface RoutingSelection {
  /** Undefined only while the surface registry is still loading. */
  surface: InboundSurfaceWire | undefined
  selectSurface: (id: SurfaceId) => void
}

export function useRoutingSelection(surfaces: readonly InboundSurfaceWire[]): RoutingSelection {
  const [params, setParams] = useSearchParams()

  const selectSurface = useCallback(
    (id: SurfaceId) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.set('surface', id)
          return next
        },
        // Clicking through the surface list is browsing, not navigation:
        // Back should leave the screen, not replay every tab that was tried.
        { replace: true }
      )
    },
    [setParams]
  )

  // An absent or unrecognised param resolves to the first surface, which is
  // what a bare /routing has always shown.
  const requested = params.get('surface')
  const matched = surfaces.find((s) => s.id === requested)

  return { surface: matched === undefined ? surfaces.at(0) : matched, selectSurface }
}
