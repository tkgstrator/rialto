/**
 * Data hooks for the Routing screens.
 *
 * Three independent stores back these screens — the surface registry, the
 * preference profile and the scheduler snapshot — and each screen needs a
 * different subset, so they are separate hooks rather than one page-wide
 * fetch. The scheduler is the only polled one: it is the only store that
 * changes without an operator action.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConfig } from '@/components/ConfigProvider'
import {
  api,
  type InboundSurfaceWire,
  type RoutingMode,
  type RoutingSchedulerStateResponse,
  type SurfaceId
} from '@/lib/api'
import { constraintsDiffer, emptyByScenario, enabledTargets } from './derive'
import type { EnabledTarget, PreferenceApplyResponse, PreferenceProfile, ProfileSummary } from './types'

const SCHEDULER_POLL_MS = 30_000

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
  // all — that one is shared by every surface and every chain, and is
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

export interface PreferencesState {
  profile: PreferenceProfile
  setProfile: React.Dispatch<React.SetStateAction<PreferenceProfile>>
  loading: boolean
  error: string | null
  dirty: boolean
  save: () => Promise<PreferenceApplyResponse>
  reset: () => void
}

const emptyProfile = (): PreferenceProfile => ({ entriesByScenario: emptyByScenario(), constraints: null })

/**
 * One preference profile, addressed by key.
 *
 * A surface names the profile its chain comes from, so switching the
 * surface tab can switch which chain is on screen. A null key defers the
 * fetch until the surface registry has landed.
 */
export function usePreferences(profileKey: string | null): PreferencesState {
  const mounted = useMountedRef()
  const [profile, setProfile] = useState<PreferenceProfile>(emptyProfile)
  // Server snapshot, kept so the toolbar can tell an edited chain from a
  // freshly loaded one without diffing against a re-fetch.
  const [baseline, setBaseline] = useState<PreferenceProfile>(emptyProfile)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (profileKey === null) return
    setLoading(true)
    api
      .get<PreferenceProfile>(`/router-preferences?profile=${encodeURIComponent(profileKey)}`)
      .then((res) => {
        if (!mounted.current) return
        setProfile(res)
        setBaseline(res)
      })
      .catch((err: unknown) => {
        if (mounted.current) setError(message(err))
      })
      .finally(() => {
        if (mounted.current) setLoading(false)
      })
  }, [profileKey, mounted])

  // The constraints ride the same PUT as the chain, so an edit to either
  // is an edit to the profile. They compare by reading rather than by
  // bytes — see `constraintsDiffer`.
  const dirty = useMemo(
    () =>
      JSON.stringify(profile.entriesByScenario) !== JSON.stringify(baseline.entriesByScenario) ||
      constraintsDiffer(profile.constraints, baseline.constraints),
    [profile, baseline]
  )

  const save = useCallback(async () => {
    // The route rejects an empty `profile` query, so a chain with no
    // surface behind it never reaches the write.
    if (profileKey === null) return { success: false, warnings: ['No profile selected'] }
    const outcome = await api.put<PreferenceApplyResponse>(
      `/router-preferences?profile=${encodeURIComponent(profileKey)}`,
      profile
    )
    if (outcome.success) setBaseline(profile)
    return outcome
  }, [profile, profileKey])

  const reset = useCallback(() => setProfile(baseline), [baseline])

  return { profile, setProfile, loading, error, dirty, save, reset }
}

/** Every configured preference profile — the Chain view's profile picker. */
export function useProfiles(): ProfileSummary[] {
  const mounted = useMountedRef()
  const [profiles, setProfiles] = useState<ProfileSummary[]>([])

  useEffect(() => {
    api
      .get<{ profiles: ProfileSummary[] }>('/router-preferences/profiles')
      .then((res) => {
        if (mounted.current) setProfiles(res.profiles)
      })
      .catch(() => {
        // The picker degrades to the surface's own key; a failed list is
        // not worth blocking the chain behind an error banner.
      })
  }, [mounted])

  return profiles
}

export interface SchedulerState {
  snapshot: RoutingSchedulerStateResponse | null
  reload: () => void
}

export function useScheduler(): SchedulerState {
  const mounted = useMountedRef()
  const [snapshot, setSnapshot] = useState<RoutingSchedulerStateResponse | null>(null)

  const reload = useCallback(() => {
    api
      .getRoutingSchedulerState()
      .then((res) => {
        if (mounted.current) setSnapshot(res)
      })
      .catch(() => {
        // A missing snapshot renders as "unknown" state on every row;
        // surfacing a fetch error here would bury the chain itself.
      })
  }, [mounted])

  useEffect(() => {
    reload()
    const id = setInterval(reload, SCHEDULER_POLL_MS)
    return () => clearInterval(id)
  }, [reload])

  return { snapshot, reload }
}

/** Every routable target, derived from the config the shell already loaded. */
export function useEnabledTargets(): EnabledTarget[] {
  const { config } = useConfig()
  return useMemo(() => (config === null ? [] : enabledTargets(config.Providers)), [config])
}
