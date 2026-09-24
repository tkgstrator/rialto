/**
 * Routing → Tier map.
 *
 * The outermost axis is the inbound surface. Whether the router applies at
 * all is a per-surface fact, so the surface is the first thing you pick and
 * its mode is the second — a map is never shown for traffic that will not
 * read it. The old build had no such axis, which is how a routing screen
 * could quietly be about one endpoint only.
 *
 * Below the surface there is nothing left to pick. The chain this replaced
 * needed a scenario and a lane before any rows showed; the tier map is one
 * table for the profile, grouped by the tier the caller asked for.
 */

import { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { RButton } from '@/components/rialto/primitives'
import { Screen } from '@/components/rialto/Screen'
import type {
  InboundSurfaceWire,
  RoutingMode,
  RoutingSchedulerTargetState,
  SurfaceId,
  TierProfileSummaryWire
} from '@/lib/api'
import {
  type TierProfileState,
  useEnabledProviders,
  useEnabledTargets,
  useProfiles,
  useScheduler,
  useSurfaces,
  useTierAliases,
  useTierProfile
} from './data'
import { aliasIndex, mapCounts, resolutionIndex, resolveRoute, targetIndex } from './derive'
import { PassthroughPanel } from './PassthroughPanel'
import { SurfaceBar } from './RoutingTabs'
import { SurfaceScopeBar } from './SurfaceModeBar'
import { TierConstraints } from './TierConstraints'
import { TierMapTable } from './TierMapTable'
import type { DraftRoute, EnabledTarget, RouteResolution, TierDraft } from './types'
import { useRoutingSelection } from './useRoutingSelection'
import { type TierMapWriteActions, useTierMapActions } from './useTierMapActions'
import { useTierMapEditing } from './useTierMapEditing'

/**
 * Band 3: the map, and what you can do to it.
 *
 * It used to carry five scenario tabs and an Agent / Subagent switch
 * before the actions. With the tier map there is nothing left to pick, so
 * the band names what the table below is and how to read it.
 *
 * The screen reads until Edit is pressed. A map is read far more often
 * than it is changed, and every row carries a handle, a switch and a menu
 * one stray click from changing what routes. One Revert / Save covers the
 * routes and the constraints under them, because both are one profile and
 * one write.
 */
function MapBand({
  actions,
  saveDisabled,
  editDisabled = false
}: {
  actions: TierMapWriteActions
  saveDisabled: boolean
  /** Until the profile has loaded there is nothing to edit. */
  editDisabled?: boolean
}) {
  const { t } = useTranslation()
  return (
    <div className='flex items-center gap-3 border-b border-border px-6 py-2.5'>
      <span className='text-xs font-medium'>{t('routing.tiers.title')}</span>
      <span className='text-[12px] text-muted-foreground'>{t('routing.tiers.hint')}</span>
      <div className='ml-auto flex items-center gap-2'>
        {actions.editing ? (
          <>
            {/* Not while a save is on the wire: the write carries the
                profile as it was at the click, and reverting under it would
                leave the screen reading the old map once it lands. */}
            <RButton
              variant='outline'
              icon='ri-arrow-go-back-line'
              onClick={actions.onRevert}
              disabled={actions.saving}
            >
              {t('common.revert')}
            </RButton>
            <RButton variant='primary' icon='ri-check-line' onClick={actions.onSave} disabled={saveDisabled}>
              {t('common.save')}
            </RButton>
          </>
        ) : (
          <RButton variant='outline' icon='ri-pencil-line' onClick={actions.onEdit} disabled={editDisabled}>
            {t('common.edit')}
          </RButton>
        )}
      </div>
    </div>
  )
}

/**
 * The totals, under the thing they total, and the one sentence a reader
 * needs to read the table: how a request walks its group.
 *
 * Add route is not here. It lives on each group's header, because a route
 * belongs to a group and the header is where a reader looks once they have
 * read that group's last row.
 */
function MapFooter({ draft, resolve }: { draft: TierDraft; resolve: (route: DraftRoute) => RouteResolution }) {
  const { t } = useTranslation()
  const counts = mapCounts(draft, resolve)
  const parts = [
    t('routing.tiers.routeCount', { count: counts.total }),
    ...(counts.off === 0 ? [] : [t('routing.tiers.offCount', { n: counts.off })]),
    ...(counts.unresolved === 0 ? [] : [t('routing.tiers.unresolvedCount', { n: counts.unresolved })]),
    ...(counts.total === 0 ? [] : [t('routing.tiers.walkHint')])
  ]
  return (
    <div className='flex items-center gap-3 border-t border-border/60 px-6 py-2.5'>
      <span className='text-[12px] text-muted-foreground'>{parts.join(' · ')}</span>
    </div>
  )
}

interface RoutedBodyProps {
  profileKey: string
  tierProfile: TierProfileState
  actions: TierMapWriteActions
  targets: ReadonlyMap<string, RoutingSchedulerTargetState>
  providers: readonly string[]
  aliases: ReadonlyMap<string, string | null>
}

function RoutedBody({ profileKey, tierProfile, actions, targets, providers, aliases }: RoutedBodyProps) {
  const { t } = useTranslation()
  const { view, draft, setDraft, loading, error, dirty } = tierProfile
  const mapActions = useTierMapEditing(setDraft)
  // The resolutions the loaded profile carries, and the alias list behind
  // them for a route this edit added: see `resolveRoute`.
  const resolutions = useMemo(() => resolutionIndex(view), [view])
  const resolve = useMemo(
    () =>
      (route: DraftRoute): RouteResolution =>
        resolveRoute(route, resolutions, aliases),
    [resolutions, aliases]
  )
  // Set on the DOM node rather than as a JSX prop: this project's React
  // types do not declare `inert` on elements yet.
  const mapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (mapRef.current !== null) mapRef.current.inert = actions.saving
  }, [actions.saving])

  // The view on screen must be the profile the surface names. While a
  // newly picked profile loads, the previous one's rows would read as
  // this surface's map, so nothing is drawn instead.
  if (view === null || view.key !== profileKey) {
    return (
      <>
        <MapBand actions={actions} saveDisabled editDisabled />
        <div className='px-6 py-6 text-xs text-muted-foreground'>
          {error === null || loading ? t('common.loading') : <span className='text-destructive'>{error}</span>}
        </div>
      </>
    )
  }

  // No grid. The map runs the full width and its constraints follow it as
  // a footer — see TierConstraints for why the rail went.
  return (
    <>
      <MapBand actions={actions} saveDisabled={actions.saving || !dirty || !actions.constraintsValid} />
      {/* Inert while a save is on the wire, for the same reason Revert is
          disabled: an edit made now would not be in the write, and the
          screen would return to reading with it unsaved and no Save left.
          `inert` changes no pixels, so the map stays readable meanwhile. */}
      <div ref={mapRef} aria-busy={actions.saving}>
        <TierMapTable
          draft={draft}
          resolve={resolve}
          targets={targets}
          actions={mapActions}
          editing={actions.editing}
          providers={providers}
          aliases={aliases}
        />
        <MapFooter draft={draft} resolve={resolve} />
        <TierConstraints
          constraints={draft.constraints}
          editing={actions.editing}
          onEdit={actions.onConstraintEdit}
          onValidity={actions.onConstraintValidity}
        />
      </div>
    </>
  )
}

interface LoadedProps {
  surfaces: readonly InboundSurfaceWire[]
  surface: InboundSurfaceWire
  profiles: readonly TierProfileSummaryWire[]
  tierProfile: TierProfileState
  actions: TierMapWriteActions
  targets: ReadonlyMap<string, RoutingSchedulerTargetState>
  providers: readonly string[]
  aliases: ReadonlyMap<string, string | null>
  reachable: readonly EnabledTarget[]
  onSelectSurface: (id: SurfaceId) => void
  onSetDenied: (surface: SurfaceId, routingMode: RoutingMode, denied: readonly string[]) => Promise<void>
}

/**
 * Everything below band 1 once a surface is known.
 *
 * Split out of `RoutingTierMap` itself so the "surface loaded" and
 * "routed or passthrough" branches do not nest inside one component's
 * complexity budget.
 */
function LoadedSurface(props: LoadedProps) {
  const { surface, actions } = props
  return (
    <>
      <SurfaceBar
        surfaces={props.surfaces}
        active={surface.id}
        onSelect={props.onSelectSurface}
        disabled={actions.editing}
      />
      <SurfaceScopeBar
        surface={surface}
        profiles={props.profiles}
        onMode={actions.onMode}
        onProfile={actions.onProfile}
        locked={actions.editing}
      />
      {surface.routingMode === 'routed' ? (
        <RoutedBody
          profileKey={surface.profileKey}
          tierProfile={props.tierProfile}
          actions={actions}
          targets={props.targets}
          providers={props.providers}
          aliases={props.aliases}
        />
      ) : (
        <PassthroughPanel surface={surface} targets={props.reachable} onSetDenied={props.onSetDenied} />
      )}
    </>
  )
}

export function RoutingTierMap() {
  const { t } = useTranslation()
  const { surfaces, loading, error, setMode, setProfile: setSurfaceProfile, setTargetAllowed } = useSurfaces()
  const { profiles, reload: reloadProfiles } = useProfiles()
  const { snapshot: scheduler } = useScheduler()
  const reachable = useEnabledTargets()
  const providers = useEnabledProviders()
  const aliasList = useTierAliases()

  // The surface lives in the query string, not in state: the passthrough
  // half of this screen is only reachable as a URL, and an operator mid-way
  // through a map should survive a reload.
  const { surface, selectSurface } = useRoutingSelection(surfaces)

  const profileKey = surface === undefined ? null : surface.profileKey
  const tierProfile = useTierProfile(profileKey)
  const targets = useMemo(() => targetIndex(scheduler), [scheduler])
  const aliases = useMemo(() => aliasIndex(aliasList), [aliasList])

  // Edit / revert / save, the mode switch and the profile picker: one
  // hook for the whole write side, so this component stays about layout.
  // A save re-reads the profile list too, so the picker's route count
  // follows the write.
  const actions = useTierMapActions(
    surface,
    profileKey,
    tierProfile.setDraft,
    tierProfile.save,
    tierProfile.reset,
    reloadProfiles,
    setMode,
    setSurfaceProfile
  )

  // No subtitle on the Screen: the surface tab, the mode switch and the
  // profile picker already say which surface, which mode and which
  // profile. One explicit crumb, "Tier map": the Routing section has no
  // children for Screen to derive a second trail level from.
  return (
    <Screen crumbs={[{ label: t('routing.tiers.crumb') }]}>
      {error === null ? null : <div className='px-6 py-6 text-xs text-destructive'>{error}</div>}
      {surface === undefined ? (
        <div className='px-6 py-6 text-xs text-muted-foreground'>
          {loading ? t('common.loading') : t('routing.chain.noSurfaces')}
        </div>
      ) : (
        <LoadedSurface
          surfaces={surfaces}
          surface={surface}
          profiles={profiles}
          tierProfile={tierProfile}
          actions={actions}
          targets={targets}
          providers={providers}
          aliases={aliases}
          reachable={reachable}
          onSelectSurface={selectSurface}
          onSetDenied={setTargetAllowed}
        />
      )}
    </Screen>
  )
}
