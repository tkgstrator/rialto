/**
 * The tier map: one table for the whole profile, grouped by the tier the
 * caller asked for.
 *
 * It replaces a chain per scenario per lane, where every row held a model
 * by name. Two things made that hard to live with: a new model meant
 * replacing its predecessor in every lane that held it, and the tier gates
 * decided which rows a request could use, so a Sonnet-only chain with
 * "down only" answered every Haiku call with a 429 that never went
 * upstream. Here a route names a provider and a tier on it; which model
 * that is, is the provider's alias (shown in Resolves to, edited on the
 * provider's page). A Haiku request reaches Sonnet because a row says so.
 *
 * Priority order within a group is the point, so each row leads with the
 * ordinal and a drag handle. The table reads until the screen's Edit is
 * pressed: the handle, the row menu and each group's Add route go
 * invisible or absent rather than moving anything, and the switch stays
 * as a reading of the state.
 */

import { cn } from 'cn'
import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'
import { Pill } from '@/components/rialto/primitives'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { RoutingSchedulerTargetState } from '@/lib/api'
import { ROUTE_TIER_ORDER } from '@/lib/api-types'
import dayjs from '@/lib/dayjs'
import { AddRouteDialog } from './AddRouteDialog'
import { routeState, substitutes } from './derive'
import type { DraftRoute, ModelTier, RouteResolution, RouteState, RouteTier, TierDraft } from './types'
import type { TierMapActions } from './useTierMapEditing'

export const TIER_LABEL_KEYS: Record<RouteTier, string> = {
  fable: 'routing.tiers.tierFable',
  opus: 'routing.tiers.tierOpus',
  sonnet: 'routing.tiers.tierSonnet',
  haiku: 'routing.tiers.tierHaiku',
  other: 'routing.tiers.tierOther'
}

// What puts a request in each group. The router reads the family out of
// the requested model name as a substring (`tierOf`), so the pattern is
// `*opus*` rather than `claude-opus-*`: a prefix would suggest that
// `anthropic/claude-3-opus` lands in Other, which it does not.
const TIER_MATCH: Record<ModelTier, string> = {
  fable: '*fable*',
  opus: '*opus*',
  sonnet: '*sonnet*',
  haiku: '*haiku*'
}

const providerPath = (provider: string): string => `/providers/${encodeURIComponent(provider)}`

function RowMenu({
  tier,
  index,
  count,
  actions,
  editing
}: {
  tier: RouteTier
  index: number
  count: number
  actions: TierMapActions
  editing: boolean
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const run = (fn: () => void) => () => {
    fn()
    setOpen(false)
  }
  const item = 'w-full rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60 disabled:opacity-40'
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          aria-label={t('routing.chain.rowActions')}
          className={cn('ml-1 text-muted-foreground/60 hover:text-foreground', editing ? '' : 'invisible')}
        >
          <i className='ri-more-2-fill text-sm' />
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-36 p-1'>
        <button
          type='button'
          className={item}
          disabled={index === 0}
          onClick={run(() => actions.onMove(tier, index, index - 1))}
        >
          {t('routing.chain.moveUp')}
        </button>
        <button
          type='button'
          className={item}
          disabled={index === count - 1}
          onClick={run(() => actions.onMove(tier, index, index + 1))}
        >
          {t('routing.chain.moveDown')}
        </button>
        <button
          type='button'
          className={cn(item, 'text-destructive')}
          onClick={run(() => actions.onRemove(tier, index))}
        >
          {t('common.remove')}
        </button>
      </PopoverContent>
    </Popover>
  )
}

/**
 * Provider, then the tier on it. When that tier is not the group's own
 * the pill changes tone and says what it stands in for, so a deliberate
 * substitution cannot be mistaken for a row filed under the wrong group.
 */
function RouteCell({ route, group }: { route: DraftRoute; group: RouteTier }) {
  const { t } = useTranslation()
  return (
    <td className='truncate px-2 text-xs'>
      <span className='font-mono'>{route.provider}</span> <span className='text-muted-foreground'>·</span>{' '}
      {substitutes(group, route.targetTier) ? (
        <span className='inline-flex items-center gap-1'>
          <Pill tone='info'>{route.targetTier}</Pill>
          <i aria-hidden className='ri-arrow-left-line text-[11px] text-muted-foreground/60' />
          <span className='text-[12px] text-muted-foreground'>
            {t('routing.tiers.substitutedFor', { tier: group })}
          </span>
        </span>
      ) : (
        <Pill tone='mute'>{route.targetTier}</Pill>
      )}
    </td>
  )
}

/**
 * The model the route reaches today. An unset alias is the operator's to
 * fix on the provider page, so it links there instead of naming nothing —
 * except while editing, where leaving the screen would drop the draft.
 */
function ResolvesCell({
  provider,
  resolution,
  editing
}: {
  provider: string
  resolution: RouteResolution
  editing: boolean
}) {
  const { t } = useTranslation()
  if (resolution.kind === 'unset') {
    const text = t('routing.tiers.setInProviders')
    return (
      <td className='px-2 text-[12px] text-muted-foreground/50'>
        {editing ? (
          <span>{text}</span>
        ) : (
          <Link
            to={providerPath(provider)}
            onClick={(event) => event.stopPropagation()}
            className='underline decoration-dotted underline-offset-2 hover:text-foreground'
          >
            {text}
          </Link>
        )}
      </td>
    )
  }
  if (resolution.kind === 'pending') {
    return (
      <td className='truncate px-2 font-mono text-xs text-muted-foreground' title={t('routing.tiers.pendingHint')}>
        {resolution.model === null ? '–' : resolution.model}
      </td>
    )
  }
  const { model, hostsWebSearch } = resolution.resolution
  return (
    <td className='truncate px-2 font-mono text-xs text-muted-foreground'>
      {model}
      {/* Only the absence is marked. Most targets can run the tool, and a
          pill on every row that can would be noise around the one that
          cannot — the route a web-search request will skip. */}
      {hostsWebSearch ? null : (
        <span className='ml-1.5 align-[1px]'>
          <Pill tone='mute' title={t('routing.tiers.noWebSearchHint')}>
            {t('routing.tiers.noWebSearch')}
          </Pill>
        </span>
      )}
    </td>
  )
}

const usedTone = (pct: number): string => {
  if (pct >= 90) return 'text-destructive'
  if (pct >= 70) return 'text-amber-600 dark:text-amber-400'
  return ''
}

/** A reset time: the clock alone today, the date as well further out (weekly windows). */
function ResetTime({ at }: { at: string }) {
  const when = dayjs(at)
  const sameDay = when.isSame(dayjs(), 'day')
  return <span title={when.format('YYYY-MM-DD HH:mm Z')}>{when.format(sameDay ? 'HH:mm' : 'MM-DD HH:mm')}</span>
}

function StateCell({ state }: { state: RouteState }) {
  const { t } = useTranslation()
  if (state.kind === 'ok') {
    return <span className='text-[12px] text-emerald-600 dark:text-emerald-400'>{t('routing.tiers.stateOk')}</span>
  }
  if (state.kind === 'used') {
    return (
      <span className={cn('font-mono text-[12px] tabular-nums', usedTone(state.pct))}>
        {t('routing.tiers.stateUsed', { pct: state.pct })}
      </span>
    )
  }
  if (state.kind === 'exhausted') {
    return (
      <span className='text-[12px] text-destructive'>
        {state.until === null ? (
          t('routing.tiers.stateExhausted')
        ) : (
          <Trans
            i18nKey='routing.tiers.stateExhaustedUntil'
            components={{ mono: <span className='font-mono tabular-nums' />, time: <ResetTime at={state.until} /> }}
          />
        )}
      </span>
    )
  }
  if (state.kind === 'unset') {
    return <span className='text-[12px] text-amber-600 dark:text-amber-400'>{t('routing.tiers.stateAliasUnset')}</span>
  }
  if (state.kind === 'off') {
    return <span className='text-[12px] text-muted-foreground'>{t('routing.tiers.stateTargetOff')}</span>
  }
  // Added in this edit: the state is the server's to read once it exists.
  return (
    <span className='text-[12px] text-muted-foreground' title={t('routing.tiers.pendingHint')}>
      –
    </span>
  )
}

interface RowProps {
  route: DraftRoute
  group: RouteTier
  index: number
  count: number
  resolution: RouteResolution
  state: RouteState
  actions: TierMapActions
  editing: boolean
  onDragStart: () => void
  onDrop: () => void
}

function RouteRow({ route, group, index, count, resolution, state, actions, editing, onDragStart, onDrop }: RowProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  // The row opens its provider — where the alias, the accounts and the
  // model list live — but only while reading. Mid-edit a stray click on a
  // row would leave the screen and take the unsaved draft with it, which
  // is also why the surface tabs lock.
  const open = editing ? undefined : () => navigate(providerPath(route.provider))
  const label = `${route.provider} · ${route.targetTier}`
  return (
    // A row rather than a Link: a `<tr>` cannot legally hold one, and the
    // cells have to stay cells for the columns to line up. Enter opens it
    // so the map is walkable without a mouse.
    <tr
      draggable={editing}
      onDragStart={editing ? onDragStart : undefined}
      onDragOver={editing ? (event) => event.preventDefault() : undefined}
      onDrop={editing ? onDrop : undefined}
      onClick={open}
      onKeyDown={
        open === undefined
          ? undefined
          : (event) => {
              if (event.key === 'Enter' && event.target === event.currentTarget) open()
            }
      }
      tabIndex={editing ? undefined : 0}
      className={cn(
        'border-t border-border/60 transition-colors hover:bg-muted/50',
        editing ? '' : 'cursor-pointer',
        route.enabled ? '' : 'opacity-45'
      )}
    >
      <td className='py-2.5 pl-6 pr-2'>
        <div className='flex items-center gap-2'>
          <i
            className={cn('ri-draggable text-base leading-none text-muted-foreground/50', editing ? '' : 'invisible')}
          />
          <span className='font-mono text-xs tabular-nums text-muted-foreground'>{index + 1}</span>
        </div>
      </td>
      <RouteCell route={route} group={group} />
      <ResolvesCell provider={route.provider} resolution={resolution} editing={editing} />
      <td className='px-2 text-right'>
        <StateCell state={state} />
      </td>
      <td className='py-2.5 pl-2 pr-6'>
        <div className='flex items-center justify-end gap-1'>
          <button
            type='button'
            role='switch'
            aria-checked={route.enabled}
            aria-label={t('routing.chain.enableTarget', { target: label })}
            disabled={!editing}
            onClick={() => actions.onToggle(group, index, !route.enabled)}
            className={cn(
              'inline-flex h-4 w-7 items-center rounded-full px-0.5 disabled:opacity-50',
              route.enabled ? 'bg-foreground' : 'bg-muted-foreground/30'
            )}
          >
            <span className={cn('size-3 rounded-full bg-background', route.enabled ? 'translate-x-3' : '')} />
          </button>
          <RowMenu tier={group} index={index} count={count} actions={actions} editing={editing} />
        </div>
      </td>
    </tr>
  )
}

/**
 * A group's header row: the tier, what names it (so "Other" is not a
 * mystery), how many routes it has, and — while editing — the one action
 * that adds to it, where a reader looks for it.
 */
function GroupHeader({
  tier,
  count,
  editing,
  addRoute
}: {
  tier: RouteTier
  count: number
  editing: boolean
  addRoute: React.ReactNode
}) {
  const { t } = useTranslation()
  return (
    <tr className='border-t border-border bg-muted/30'>
      <td colSpan={5} className='px-6 py-2'>
        <div className='flex h-7 items-center gap-2'>
          <span className='text-xs font-semibold'>{t(TIER_LABEL_KEYS[tier])}</span>
          <span className='font-mono text-[12px] text-muted-foreground'>
            {tier === 'other' ? t('routing.tiers.matchOther') : TIER_MATCH[tier]}
          </span>
          <span className='font-mono text-[12px] tabular-nums text-muted-foreground/70'>{count}</span>
          <span className='ml-auto'>{editing ? addRoute : null}</span>
        </div>
      </td>
    </tr>
  )
}

export function TierMapTable({
  draft,
  resolve,
  targets,
  actions,
  editing,
  providers,
  aliases
}: {
  draft: TierDraft
  resolve: (route: DraftRoute) => RouteResolution
  /** The scheduler's readings keyed by "provider,model". */
  targets: ReadonlyMap<string, RoutingSchedulerTargetState>
  actions: TierMapActions
  editing: boolean
  providers: readonly string[]
  aliases: ReadonlyMap<string, string | null>
}) {
  const { t } = useTranslation()
  // The row being dragged. Held here rather than in the row so a drop
  // knows both ends of the move without a dataTransfer round trip (which
  // Safari only populates on drop). A drop on another group is ignored:
  // moving a route between groups changes what it means, not its order.
  const [dragging, setDragging] = useState<{ tier: RouteTier; index: number } | null>(null)

  const drop = (tier: RouteTier, to: number) => () => {
    if (dragging !== null && dragging.tier === tier && dragging.index !== to) actions.onMove(tier, dragging.index, to)
    setDragging(null)
  }

  return (
    <table className='w-full table-fixed'>
      <colgroup>
        <col className='w-16' />
        <col className='w-[22rem]' />
        <col />
        <col className='w-44' />
        <col className='w-24' />
      </colgroup>
      <thead>
        <tr className='text-[12px] uppercase tracking-wider text-muted-foreground/70 [&>th]:h-9 [&>th]:whitespace-nowrap [&>th]:align-bottom [&>th]:pb-2'>
          <th className='pl-6 pr-2 text-left font-medium'>#</th>
          <th className='px-2 text-left font-medium'>{t('routing.tiers.colRoute')}</th>
          <th className='px-2 text-left font-medium'>{t('routing.tiers.colResolvesTo')}</th>
          <th className='px-2 text-right font-medium'>{t('routing.tiers.colState')}</th>
          <th className='pl-2 pr-6 text-right font-medium'>{t('routing.chain.colOn')}</th>
        </tr>
      </thead>
      {/* One tbody per group, so each group's rows and its header stay one
          unit for assistive tech and for the drag, which never leaves it. */}
      {ROUTE_TIER_ORDER.map((tier) => {
        const routes = draft.routes[tier]
        return (
          <tbody key={tier}>
            <GroupHeader
              tier={tier}
              count={routes.length}
              editing={editing}
              addRoute={
                <AddRouteDialog
                  tierLabel={t(TIER_LABEL_KEYS[tier])}
                  routes={routes}
                  providers={providers}
                  aliases={aliases}
                  onAdd={(route) => actions.onAdd(tier, route)}
                />
              }
            />
            {routes.length === 0 ? (
              // An empty group is "no opinion", not "nowhere to go": the
              // caller's own model goes upstream, as an empty lane always
              // meant. Saying "no routes" alone would read as the opposite.
              <tr className='border-t border-border/60'>
                <td colSpan={5} className='px-6 py-3 text-[12px] text-muted-foreground'>
                  {t('routing.tiers.emptyTier')}
                </td>
              </tr>
            ) : (
              routes.map((route, index) => {
                const resolution = resolve(route)
                return (
                  <RouteRow
                    key={`${route.targetTier}:${route.provider}`}
                    route={route}
                    group={tier}
                    index={index}
                    count={routes.length}
                    resolution={resolution}
                    state={routeState(resolution, route.provider, targets)}
                    actions={actions}
                    editing={editing}
                    onDragStart={() => setDragging({ tier, index })}
                    onDrop={drop(tier, index)}
                  />
                )
              })
            )}
          </tbody>
        )
      })}
    </table>
  )
}
