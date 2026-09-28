/**
 * The inbound-surface registry, loaded once per screen.
 *
 * Both RequestLog and Session now carry an exact `surface` slug, so this
 * is a pure id → descriptor lookup. `inboundType` is deliberately not a
 * fallback: 'openai' covers /v1/chat/completions and /v1/responses, so a
 * null surface is unrecoverable and renders as untracked.
 */
import { useEffect, useMemo, useState } from 'react'
import { api, type InboundSurfaceWire } from '@/lib/api'
import { CODEX_MCP_CLIENT, CODEX_MCP_PATH, CODEX_MCP_SCOPE } from '@/shared/codex-mcp'

/** The two fields a surface id is displayed by. */
interface SurfaceLabel {
  path: string
  client: string
}

const CODEX_MCP_LABEL: SurfaceLabel = { path: CODEX_MCP_PATH, client: CODEX_MCP_CLIENT }

/**
 * How a surface id reads, resolved against a registry list.
 *
 * `codex-mcp` is answered here rather than by the registry. /codex is not
 * an inbound surface, so `/api/inbound-surfaces` never lists it — but its
 * id turns up everywhere a surface id does: on a RequestLog row Codex
 * served over MCP, and in a token's scope. Left to the registry it would
 * read as untracked in the first and silently drop out of the second,
 * where a token scoped only to /codex would then render as "all".
 *
 * Takes any `{ id, path, client }` list so Overview's per-surface traffic
 * rows, which carry the same three fields, resolve the same way.
 */
export const surfaceLabel = (
  surfaces: readonly (SurfaceLabel & { id: string })[],
  id: string | null
): SurfaceLabel | undefined => (id === CODEX_MCP_SCOPE ? CODEX_MCP_LABEL : surfaces.find((s) => s.id === id))

/**
 * A token's scope as display paths, in the order the token lists them.
 *
 * Empty still means "every /v1 surface" — callers render that as "all".
 * An id the registry does not know is dropped rather than printed raw: it
 * is a surface this build has never heard of, and a slug in a column of
 * paths reads as a bug rather than as information.
 */
export const scopePaths = (surfaces: readonly InboundSurfaceWire[], ids: readonly string[]): string[] =>
  ids.flatMap((id) => {
    const found = surfaceLabel(surfaces, id)
    return found === undefined ? [] : [found.path]
  })

export interface SurfaceLookup {
  surfaces: InboundSurfaceWire[]
  /** Display path for a RequestLog.surface slug. */
  pathOf: (surfaceId: string | null) => string | null
  /** The client an operator points at that surface — the nearest thing to a caller identity. */
  clientOf: (surfaceId: string | null) => string | null
}

export function useSurfaces(): SurfaceLookup {
  const [surfaces, setSurfaces] = useState<InboundSurfaceWire[]>([])

  useEffect(() => {
    api
      .getInboundSurfaces()
      .then((res) => setSurfaces(res.surfaces))
      .catch(() => {
        // Labels only. A failed probe leaves every endpoint cell untracked
        // instead of blocking the table from rendering.
      })
  }, [])

  // A linear find rather than a Map: the registry is a handful of entries,
  // and going through `surfaceLabel` keeps /codex resolved in one place.
  return useMemo(
    () => ({
      surfaces,
      pathOf: (id) => {
        const s = surfaceLabel(surfaces, id)
        return s === undefined ? null : s.path
      },
      clientOf: (id) => {
        const s = surfaceLabel(surfaces, id)
        return s === undefined ? null : s.client
      }
    }),
    [surfaces]
  )
}
