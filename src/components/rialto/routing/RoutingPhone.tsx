/**
 * Routing at phone width: which surface, whether the router applies to
 * it, and what it would do — read only.
 *
 * The desktop screen is an editor. Every line carries a drag handle, a
 * switch and a remove, the combination dialog lays providers and tiers
 * out side by side, and the two lanes are columns of a table that needs
 * ~50rem before its first cell stops wrapping. None of that shrinks to a
 * phone, and a route table is not something to rework from one: a wrong
 * tap sends live traffic somewhere else. So the phone keeps the reading
 * half — the surface's mode and profile, each scenario's lines in the
 * order they are tried, and which targets a passthrough caller may name —
 * and every change is made on the same URL at desktop width.
 *
 * The two lanes stack inside each scenario rather than sitting side by
 * side: a provider name beside a tier pill already fills half of 390px.
 */

import { cn } from 'cn'
import { Trans, useTranslation } from 'react-i18next'
import { RoutingModePill } from '@/components/rialto/OverviewSurfaces'
import { Mono, PhoneRow, Pill } from '@/components/rialto/primitives'
import type { InboundSurfaceWire, SurfaceId } from '@/lib/api'
import { ROUTING_LANE_ORDER, ROUTING_SCENARIO_ORDER } from '@/lib/api-types'
import type { ScenarioProfileState } from './data'
import { combinationKey } from './derive'
import { LANE_LABEL_KEYS, SCENARIO_LABEL_KEYS } from './labels'
import { ScenarioWhen } from './ScenarioTable'
import type { Combination, EnabledTarget, RoutingScenario } from './types'

/**
 * The surface tabs as a strip that scrolls sideways. Five paths in mono
 * are ~52rem, so the desktop bar pushed the whole pane sideways instead.
 */
function SurfaceStrip({
  surfaces,
  active,
  onSelect
}: {
  surfaces: readonly InboundSurfaceWire[]
  active: SurfaceId
  onSelect: (id: SurfaceId) => void
}) {
  return (
    <div className='overflow-x-auto border-b border-border [scrollbar-width:none]'>
      <div className='flex w-max px-1'>
        {surfaces.map((surface) => {
          const on = surface.id === active
          return (
            <button
              key={surface.id}
              type='button'
              onClick={() => onSelect(surface.id)}
              className={cn(
                'flex items-center gap-2 border-b-2 px-3 py-2.5',
                on ? 'border-b-foreground' : 'border-b-transparent'
              )}
            >
              {/* The same filled / hollow dot as the desktop tab: the mode
                  of every surface at a glance, not only the selected one. */}
              <span
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  surface.routingMode === 'routed' ? 'bg-emerald-500' : 'border border-muted-foreground/50'
                )}
              />
              <span
                className={cn('whitespace-nowrap font-mono text-xs', on ? 'text-foreground' : 'text-muted-foreground')}
              >
                {surface.path}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** One lane's lines, numbered in the order a request tries them. */
function LaneLines({ scenario, routes }: { scenario: RoutingScenario; routes: readonly Combination[] }) {
  const { t } = useTranslation()
  if (routes.length === 0) {
    return (
      <span className='text-[12px] text-muted-foreground'>
        {scenario === 'default' ? t('routing.scenarios.emptyDefault') : t('routing.scenarios.emptyFallback')}
      </span>
    )
  }
  return (
    <ol className='space-y-1'>
      {routes.map((route, index) => (
        // Dimmed when switched off, as on the desktop table: the line
        // keeps its place in the order and is skipped.
        <li
          key={combinationKey(route.provider, route.targetTier)}
          className={cn('flex min-w-0 items-center gap-2', route.enabled ? '' : 'opacity-50')}
        >
          <span className='w-3 shrink-0 font-mono text-[12px] tabular-nums text-muted-foreground'>{index + 1}</span>
          <span className='min-w-0 truncate font-mono text-xs'>{route.provider}</span>
          <Pill tone='mute' className='shrink-0'>
            {route.targetTier}
          </Pill>
        </li>
      ))}
    </ol>
  )
}

function PhoneRoutes({ profileKey, profile }: { profileKey: string; profile: ScenarioProfileState }) {
  const { t } = useTranslation()
  const { view, draft, loading, error, blockedEscalationTiers } = profile
  // As on desktop: a profile still loading must not show the previous
  // surface's routes as this one's.
  if (view === null || view.key !== profileKey) {
    return (
      <div className='px-4 py-6 text-xs text-muted-foreground'>
        {error === null || loading ? t('common.loading') : <span className='text-destructive'>{error}</span>}
      </div>
    )
  }
  return (
    <>
      {ROUTING_SCENARIO_ORDER.map((scenario) => (
        <div key={scenario} className='border-b border-border/60 px-4 py-3'>
          <div className='flex min-w-0 items-baseline gap-2'>
            <span className='shrink-0 text-xs font-medium'>{t(SCENARIO_LABEL_KEYS[scenario])}</span>
            <span className='min-w-0 truncate text-[12px] text-muted-foreground'>
              <ScenarioWhen scenario={scenario} threshold={view.longContextThreshold} />
            </span>
          </div>
          <div className='mt-2 space-y-2'>
            {ROUTING_LANE_ORDER.map((lane) => (
              <div key={lane} className='grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2'>
                <span className='pt-0.5 text-[11px] uppercase tracking-wider text-muted-foreground/70'>
                  {t(LANE_LABEL_KEYS[lane])}
                </span>
                <LaneLines scenario={scenario} routes={draft[scenario][lane]} />
              </div>
            ))}
          </div>
        </div>
      ))}
      {/* One line rather than the desktop's checkbox row: which tiers are
          blocked is worth knowing, the unticked ones are not. */}
      {blockedEscalationTiers.length === 0 ? null : (
        <div className='px-4 py-3 text-[12px]'>
          <div className='text-muted-foreground'>{t('routing.scenarios.blockedEscalationTiers')}</div>
          <div className='mt-0.5 capitalize'>{blockedEscalationTiers.join(' · ')}</div>
        </div>
      )}
    </>
  )
}

/**
 * The passthrough half: what a caller may name. A target switched off
 * for this surface stays listed, dimmed and marked, so the list still
 * answers "why was my model refused".
 */
function PhoneReachable({ surface, targets }: { surface: InboundSurfaceWire; targets: readonly EnabledTarget[] }) {
  const { t } = useTranslation()
  const denied = new Set(surface.deniedTargets)
  return (
    <>
      <div className='px-4 pt-4 pb-3'>
        <h2 className='text-sm font-semibold'>{t('routing.chain.reachableTargets')}</h2>
        <p className='mt-0.5 text-[12px] text-muted-foreground'>
          <Trans i18nKey='routing.chain.reachableHint' components={{ mono: <span className='font-mono' /> }} />
        </p>
      </div>
      {targets.map((entry) => {
        const off = denied.has(entry.target)
        return (
          // Model first: the target string is "provider,model", and on a
          // phone the model is the half a truncated line would cut off.
          <div key={entry.target} className={off ? 'opacity-45' : ''}>
            <PhoneRow
              primary={<span className='font-mono'>{entry.model}</span>}
              trailing={off ? <Pill tone='mute'>{t('providers.rail.stateOff')}</Pill> : undefined}
              secondary={<Mono className='truncate'>{entry.provider}</Mono>}
            />
          </div>
        )
      })}
    </>
  )
}

export function RoutingPhone({
  surfaces,
  surface,
  onSelectSurface,
  profile,
  reachable
}: {
  surfaces: readonly InboundSurfaceWire[]
  surface: InboundSurfaceWire
  onSelectSurface: (id: SurfaceId) => void
  profile: ScenarioProfileState
  reachable: readonly EnabledTarget[]
}) {
  const { t } = useTranslation()
  const routed = surface.routingMode === 'routed'
  return (
    <>
      <SurfaceStrip surfaces={surfaces} active={surface.id} onSelect={onSelectSurface} />
      {/* The desktop scope strip's facts without its controls: the mode
          as the same pill Overview uses, and the profile a routed surface
          draws from. */}
      <div className='flex min-w-0 items-center gap-2 border-b border-border bg-muted/30 px-4 py-2.5'>
        <RoutingModePill mode={surface.routingMode} />
        <span className='min-w-0 truncate text-[12px] text-muted-foreground'>{surface.client}</span>
        {routed ? (
          <span className='ml-auto flex shrink-0 items-baseline gap-1.5 text-[12px]'>
            <span className='text-muted-foreground'>{t('routing.chain.profile')}</span>
            <span className='font-mono'>{surface.profileKey}</span>
          </span>
        ) : null}
      </div>
      {routed ? (
        <PhoneRoutes profileKey={surface.profileKey} profile={profile} />
      ) : (
        <PhoneReachable surface={surface} targets={reachable} />
      )}
      <div className='h-6' />
    </>
  )
}
