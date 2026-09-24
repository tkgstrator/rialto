/**
 * Data hooks for the Routing screen.
 *
 * Three independent stores back it — the surface registry, the profile's
 * scenario routes and the providers' tier aliases — and each half of the
 * screen needs a different subset, so they are separate hooks rather than
 * one page-wide fetch. None is polled: each changes only on an operator
 * action, and this screen makes the ones that change here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConfig } from '@/components/ConfigProvider'
import {
  api,
  type InboundSurfaceWire,
  type ModelTier,
  type RoutingMode,
  type SurfaceId,
  type TierAliasWire,
  type TierProfileSaveOutcome,
  type TierProfileSummaryWire,
  type TierProfileViewWire
} from '@/lib/api'
import { draftDiffers, draftOf, emptyDraft, enabledProviderNames, enabledTargets } from './derive'
import type { EnabledTarget, ScenarioDraft } from './types'

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * True while the component is still mounted.
 *
 * Every fetch here resolves into state, and a screen the operator has
 * already navigated away from must not write into it.
 */
function useMountedRef(): React.RefObject<boolean> {
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  return mounted
}

export interface SurfacesState {
  surfaces: InboundSurfaceWire[]
  loading: boolean
  error: string | null
  reload: () => void
  setMode: (surface: SurfaceId, routingMode: RoutingMode) => Promise<void>
  setProfile: (surface: SurfaceId, routingMode: RoutingMode, profileKey: string) => Promise<void>
  setTargetAllowed: (surface: SurfaceId, routingMode: RoutingMode, denied: readonly string[]) => Promise<void>
}

export function useSurfaces(): SurfacesState {
  const mounted = useMountedRef()
  const [surfaces, setSurfaces] = useState<InboundSurfaceWire[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(() => {
    setLoading(true)
    api
      .getInboundSurfaces()
      .then((res) => {
        if (mounted.current) setSurfaces(res.surfaces)
      })
      .catch((err: unknown) => {
        if (mounted.current) setError(message(err))
      })
      .finally(() => {
        if (mounted.current) setLoading(false)
      })
  }, [mounted])

  useEffect(reload, [reload])

  // The POST returns the whole refreshed registry, so the write is also
  // the read — no optimistic patch to reconcile.
  const setMode = useCallback(async (surface: SurfaceId, routingMode: RoutingMode) => {
    const res = await api.updateInboundSurface({ surface, routingMode })
    setSurfaces(res.surfaces)
  }, [])

  // The upsert writes both columns, so re-pointing the profile has to
  // carry the current mode along or it would reset to the default.
  const setProfile = useCallback(async (surface: SurfaceId, routingMode: RoutingMode, profileKey: string) => {
    const res = await api.updateInboundSurface({ surface, routingMode, profileKey })
    setSurfaces(res.surfaces)
  }, [])

  // Whether a caller may name this target on this surface. Distinct from
  // `Model.enabled`, which is whether the provider serves the model at
  // all — that one is shared by every surface and every route, and is
  // edited in Providers.
  const setTargetAllowed = useCallback(
    async (surface: SurfaceId, routingMode: RoutingMode, denied: readonly string[]) => {
      const res = await api.updateInboundSurface({ surface, routingMode, deniedTargets: [...denied] })
      setSurfaces(res.surfaces)
    },
    []
  )

  return { surfaces, loading, error, reload, setMode, setProfile, setTargetAllowed }
}

export interface ScenarioProfileState {
  /** The profile as last read, resolutions included. Null until the first read lands. */
  view: TierProfileViewWire | null
  blockedEscalationTiers: ModelTier[]
  setBlockedEscalationTiers: React.Dispatch<React.SetStateAction<ModelTier[]>>
  draft: ScenarioDraft
  setDraft: React.Dispatch<React.SetStateAction<ScenarioDraft>>
  loading: boolean
  error: string | null
  dirty: boolean
  save: () => Promise<TierProfileSaveOutcome>
  reset: () => void
}

/**
 * One profile's scenario routes, addressed by key, and the draft edited
 * over them.
 *
 * A surface names the profile its routes come from, so switching the
 * surface tab can switch which profile is on screen. A null key defers the
 * fetch until the surface registry has landed.
 */
export function useScenarioProfile(profileKey: string | null): ScenarioProfileState {
  const mounted = useMountedRef()
  const [view, setView] = useState<TierProfileViewWire | null>(null)
  const [blockedEscalationTiers, setBlockedEscalationTiers] = useState<ModelTier[]>([])
  const [draft, setDraft] = useState<ScenarioDraft>(emptyDraft)
  // Server snapshot in write shape, kept so the toolbar can tell an
  // edited profile from a freshly loaded one without diffing against a
  // re-fetch.
  const [baseline, setBaseline] = useState<ScenarioDraft>(emptyDraft)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // The key the screen currently shows. A read for a key the operator has
  // since tabbed away from must not land on top of the one they tabbed to.
  const currentKey = useRef(profileKey)

  const load = useCallback(
    async (key: string) => {
      setLoading(true)
      try {
        const res = await api.getTierProfile(key)
        if (!mounted.current || currentKey.current !== key) return
        const loaded = draftOf(res)
        setView(res)
        setBlockedEscalationTiers(res.constraints.blockedEscalationTiers)
        setDraft(loaded)
        setBaseline(loaded)
        setError(null)
      } catch (err: unknown) {
        if (mounted.current && currentKey.current === key) setError(message(err))
      } finally {
        if (mounted.current && currentKey.current === key) setLoading(false)
      }
    },
    [mounted]
  )

  useEffect(() => {
    currentKey.current = profileKey
    if (profileKey !== null) load(profileKey)
  }, [profileKey, load])

  const dirty = useMemo(
    () =>
      draftDiffers(draft, baseline) ||
      (view !== null &&
        JSON.stringify([...blockedEscalationTiers].sort()) !==
          JSON.stringify([...view.constraints.blockedEscalationTiers].sort())),
    [draft, baseline, blockedEscalationTiers, view]
  )

  // Save is the PUT and then a fresh read: the write answers only with
  // warnings, and the Long context threshold that follows from the new
  // Default routes is the server's to say.
  //
  // Only the escalation restriction is edited here; keep the other
  // constraints from the read, with tuner-owned state protected server-side.
  const save = useCallback(async (): Promise<TierProfileSaveOutcome> => {
    if (profileKey === null || view === null || view.key !== profileKey) return { success: false, warnings: [] }
    const outcome = await api.putTierProfile(profileKey, {
      routes: draft,
      constraints: { ...view.constraints, blockedEscalationTiers }
    })
    if (outcome.success) await load(profileKey)
    return outcome
  }, [draft, view, profileKey, load, blockedEscalationTiers])

  const reset = useCallback(() => {
    setDraft(baseline)
    setBlockedEscalationTiers(view === null ? [] : view.constraints.blockedEscalationTiers)
  }, [baseline, view])

  return {
    view,
    draft,
    setDraft,
    blockedEscalationTiers,
    setBlockedEscalationTiers,
    loading,
    error,
    dirty,
    save,
    reset
  }
}

export interface ProfilesState {
  profiles: TierProfileSummaryWire[]
  reload: () => void
}

/** Every stored profile — the profile picker's list. */
export function useProfiles(): ProfilesState {
  const mounted = useMountedRef()
  const [profiles, setProfiles] = useState<TierProfileSummaryWire[]>([])

  const reload = useCallback(() => {
    api
      .getTierProfiles()
      .then((res) => {
        if (mounted.current) setProfiles(res)
      })
      .catch(() => {
        // The picker degrades to the surface's own key; a failed list is
        // not worth blocking the routes behind an error banner.
      })
  }, [mounted])

  useEffect(reload, [reload])

  return { profiles, reload }
}

/**
 * Every provider's four tier aliases.
 *
 * Read once per visit. The aliases are edited on the provider pages, not
 * here; this screen only needs them to say which tiers the add dialog can
 * offer for a provider — a tier with no model behind it reaches nothing.
 */
export function useTierAliases(): TierAliasWire[] | null {
  const mounted = useMountedRef()
  const [aliases, setAliases] = useState<TierAliasWire[] | null>(null)

  useEffect(() => {
    api
      .getTierAliases()
      .then((res) => {
        if (mounted.current) setAliases(res)
      })
      .catch(() => {
        // Without the list the dialog offers every tier (see
        // `tierOptions`); the server's save warnings name an unset one.
      })
  }, [mounted])

  return aliases
}

/** Every routable target, derived from the config the shell already loaded. */
export function useEnabledTargets(): EnabledTarget[] {
  const { config } = useConfig()
  return useMemo(() => (config === null ? [] : enabledTargets(config.Providers)), [config])
}

/** The providers a new combination may name, from the same config. */
export function useEnabledProviders(): string[] {
  const { config } = useConfig()
  return useMemo(() => (config === null ? [] : enabledProviderNames(config.Providers)), [config])
}
