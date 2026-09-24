/**
 * Routing → Scenarios.
 *
 * The outermost axis is the inbound surface. Whether the router applies at
 * all is a per-surface fact, so the surface is the first thing you pick and
 * its mode is the second — routes are never shown for traffic that will
 * not read them. The old build had no such axis, which is how a routing
 * screen could quietly be about one endpoint only.
 *
 * Below the surface there is nothing left to pick: the profile's routes
 * are one table, a scenario per row and a lane per column.
 */

import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { RButton } from '@/components/rialto/primitives'
import { Screen } from '@/components/rialto/Screen'
import type { InboundSurfaceWire, RoutingMode, SurfaceId, TierAliasWire, TierProfileSummaryWire } from '@/lib/api'
import {
  type ScenarioProfileState,
  useEnabledProviders,
  useEnabledTargets,
  useProfiles,
  useScenarioProfile,
  useSurfaces,
  useTierAliases
} from './data'
import { EscalationRestrictions } from './EscalationRestrictions'
import { PassthroughPanel } from './PassthroughPanel'
import { SurfaceBar } from './RoutingTabs'
import { ScenarioTable } from './ScenarioTable'
import { SurfaceScopeBar } from './SurfaceModeBar'
import type { EnabledTarget } from './types'
import { type RoutingWriteActions, useRoutingActions } from './useRoutingActions'
import { useRoutingSelection } from './useRoutingSelection'
import { useScenarioEditing } from './useScenarioEditing'

/**
 * Band 3: what the table below is, and what you can do to it.
 *
 * The screen reads until Edit is pressed. Routes are read far more often
 * than they are changed, and every line carries a handle, a switch and a
 * remove one stray click from changing what routes. One Revert / Save
 * covers every cell, both lanes, because the profile is one write.
 */
function ScenarioBand({
  actions,
  saveDisabled,
  editDisabled = false
}: {
  actions: RoutingWriteActions
  saveDisabled: boolean
  /** Until the profile has loaded there is nothing to edit. */
  editDisabled?: boolean
}) {
  const { t } = useTranslation()
  return (
    <div className='flex items-center gap-3 border-b border-border px-6 py-2.5'>
      <span className='text-xs font-medium'>{t('routing.scenarios.title')}</span>
      <span className='text-[12px] text-muted-foreground'>{t('routing.scenarios.hint')}</span>
      <div className='ml-auto flex items-center gap-2'>
        {actions.editing ? (
          <>
            {/* Not while a save is on the wire: the write carries the
                routes as they were at the click, and reverting under it
                would leave the screen reading the old ones once it lands. */}
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

interface RoutedBodyProps {
  profileKey: string
  profile: ScenarioProfileState
  actions: RoutingWriteActions
  providers: readonly string[]
  aliases: readonly TierAliasWire[] | null
}

function RoutedBody({ profileKey, profile, actions, providers, aliases }: RoutedBodyProps) {
  const { t } = useTranslation()
  const { view, draft, setDraft, loading, error, dirty } = profile
  const editing = useScenarioEditing(setDraft)
  // Set on the DOM node rather than as a JSX prop: this project's React
  // types do not declare `inert` on elements yet.
  const tableRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (tableRef.current !== null) tableRef.current.inert = actions.saving
  }, [actions.saving])

  // The view on screen must be the profile the surface names. While a
  // newly picked profile loads, the previous one's routes would read as
  // this surface's, so nothing is drawn instead.
  if (view === null || view.key !== profileKey) {
    return (
      <>
        <ScenarioBand actions={actions} saveDisabled editDisabled />
        <div className='px-6 py-6 text-xs text-muted-foreground'>
          {error === null || loading ? t('common.loading') : <span className='text-destructive'>{error}</span>}
        </div>
      </>
    )
  }

  return (
    <>
      <ScenarioBand actions={actions} saveDisabled={actions.saving || !dirty} />
      {/* Inert while a save is on the wire, for the same reason Revert is
          disabled: an edit made now would not be in the write, and the
          screen would return to reading with it unsaved and no Save left.
          `inert` changes no pixels, so the table stays readable meanwhile. */}
      <div ref={tableRef} aria-busy={actions.saving}>
        <ScenarioTable
          draft={draft}
          editing={actions.editing}
          longContextThreshold={view.longContextThreshold}
          actions={editing}
          providers={providers}
          aliases={aliases}
        />
        <EscalationRestrictions
          selected={profile.blockedEscalationTiers}
          onChange={profile.setBlockedEscalationTiers}
          editing={actions.editing}
        />
      </div>
    </>
  )
}

interface LoadedProps {
  surfaces: readonly InboundSurfaceWire[]
  surface: InboundSurfaceWire
  profiles: readonly TierProfileSummaryWire[]
  profile: ScenarioProfileState
  actions: RoutingWriteActions
  providers: readonly string[]
  aliases: readonly TierAliasWire[] | null
  reachable: readonly EnabledTarget[]
  onSelectSurface: (id: SurfaceId) => void
  onSetDenied: (surface: SurfaceId, routingMode: RoutingMode, denied: readonly string[]) => Promise<void>
}

/**
 * Everything below band 1 once a surface is known.
 *
 * Split out of `RoutingScenarios` itself so the "surface loaded" and
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
          profile={props.profile}
          actions={actions}
          providers={props.providers}
          aliases={props.aliases}
        />
      ) : (
        <PassthroughPanel surface={surface} targets={props.reachable} onSetDenied={props.onSetDenied} />
      )}
    </>
  )
}

export function RoutingScenarios() {
  const { t } = useTranslation()
  const { surfaces, loading, error, setMode, setProfile: setSurfaceProfile, setTargetAllowed } = useSurfaces()
  const { profiles, reload: reloadProfiles } = useProfiles()
  const reachable = useEnabledTargets()
  const providers = useEnabledProviders()
  const aliases = useTierAliases()

  // The surface lives in the query string, not in state: the passthrough
  // half of this screen is only reachable as a URL, and an operator mid-way
  // through an edit should survive a reload.
  const { surface, selectSurface } = useRoutingSelection(surfaces)

  const profileKey = surface === undefined ? null : surface.profileKey
  const profile = useScenarioProfile(profileKey)

  // Edit / revert / save, the mode switch and the profile picker: one
  // hook for the whole write side, so this component stays about layout.
  // A save re-reads the profile list too, so the picker's route count
  // follows the write.
  const actions = useRoutingActions(
    surface,
    profileKey,
    profile.save,
    profile.reset,
    reloadProfiles,
    setMode,
    setSurfaceProfile
  )

  // No subtitle on the Screen: the surface tab, the mode switch and the
  // profile picker already say which surface, which mode and which
  // profile. One explicit crumb, "Scenarios": the Routing section has no
  // children for Screen to derive a second trail level from.
  return (
    <Screen crumbs={[{ label: t('routing.scenarios.crumb') }]}>
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
          profile={profile}
          actions={actions}
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
