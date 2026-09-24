/**
 * The scenario table: a scenario per row, a lane per column, and in each
 * cell the provider · tier combinations tried top first.
 *
 * A request is classified into a scenario — long input, thinking on, or
 * neither — and a lane — whether it carries the subagent tag — and walks
 * that cell's list; the second line takes a request only when the first
 * cannot (out of quota, failing, or unable to hold it). That is the whole
 * screen: a provider and a tier, nothing else. The model is neither picked
 * nor shown here — the provider's tier alias, set on its page, says which
 * model "sonnet" is, so a vendor's new model moves one alias instead of
 * this table. Earlier drafts stacked a summary, a quota strip, a status per
 * line, a block of constraints and the resolved model beside every
 * combination; none of it answered the question an operator brings here.
 *
 * Every line is the same grid whether the table reads or edits, so the
 * columns line up down a cell and across the table: handle, order, the
 * combination, its switch, remove. Reading, the handle and remove are
 * invisible rather than absent and the switch is a dimmed reading, so
 * pressing Edit moves nothing. A line switched off keeps its place and is
 * skipped.
 */

import { cn } from 'cn'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pill } from '@/components/rialto/primitives'
import type { TierAliasWire } from '@/lib/api'
import { ROUTING_LANE_ORDER, ROUTING_SCENARIO_ORDER } from '@/lib/api-types'
import { CombinationDialog, type CombinationTarget } from './CombinationDialog'
import { cellOf, combinationKey, formatThreshold } from './derive'
import { LANE_LABEL_KEYS, SCENARIO_LABEL_KEYS } from './labels'
import type { CellAddress, Combination, ModelTier, RoutingScenario, ScenarioDraft } from './types'
import type { ScenarioEditing } from './useScenarioEditing'

const LINE = 'grid grid-cols-[1rem_1rem_minmax(0,22rem)_1.75rem_1.5rem] items-center gap-2'

const sameCell = (a: CellAddress, b: CellAddress): boolean => a.scenario === b.scenario && a.lane === b.lane

/**
 * What puts a request in each row. Long context names its threshold,
 * which is automatic — 70% of the context window of the first Default ·
 * Agent combination, tuned by the scheduler from there — so it moves by
 * itself when the Default model changes.
 */
function ScenarioWhen({ scenario, threshold }: { scenario: RoutingScenario; threshold: number }) {
  const { t } = useTranslation()
  if (scenario === 'default') return t('routing.scenarios.whenDefault')
  if (scenario === 'think') return t('routing.scenarios.whenThink')
  return t('routing.scenarios.whenLongContext', { threshold: formatThreshold(threshold) })
}

function Toggle({
  on,
  editing,
  label,
  onToggle
}: {
  on: boolean
  editing: boolean
  label: string
  onToggle: (next: boolean) => void
}) {
  return (
    <button
      type='button'
      role='switch'
      aria-checked={on}
      aria-label={label}
      disabled={!editing}
      onClick={() => onToggle(!on)}
      className={cn(
        'inline-flex h-4 w-7 items-center rounded-full px-0.5',
        on ? 'bg-foreground' : 'bg-muted-foreground/30',
        editing ? 'cursor-pointer' : 'opacity-50'
      )}
    >
      <span className={cn('size-3 rounded-full bg-background', on ? 'translate-x-3' : '')} />
    </button>
  )
}

interface LineProps {
  route: Combination
  index: number
  editing: boolean
  onOpen: () => void
  onToggle: (enabled: boolean) => void
  onRemove: () => void
  /** Keyboard reorder: -1 up, +1 down. */
  onStep: (delta: number) => void
  onDragStart: () => void
  onDragEnd: () => void
  /** Whether a line being dragged may land here — only one from the same cell. */
  canDrop: boolean
  onDrop: () => void
}

function Line({
  route,
  index,
  editing,
  onOpen,
  onToggle,
  onRemove,
  onStep,
  onDragStart,
  onDragEnd,
  canDrop,
  onDrop
}: LineProps) {
  const { t } = useTranslation()
  const combination = `${route.provider} · ${route.targetTier}`
  const body = (
    <>
      <span className='font-mono text-xs'>{route.provider}</span>
      <Pill tone='mute'>{route.targetTier}</Pill>
    </>
  )
  const box = cn('flex h-8 items-center gap-2 rounded-md px-2.5', route.enabled ? '' : 'opacity-50')
  return (
    <li
      draggable={editing}
      onDragStart={
        editing
          ? (event) => {
              // Firefox starts no drag without data on the transfer.
              event.dataTransfer.setData('text/plain', combination)
              event.dataTransfer.effectAllowed = 'move'
              onDragStart()
            }
          : undefined
      }
      onDragEnd={editing ? onDragEnd : undefined}
      onDragOver={
        editing
          ? (event) => {
              if (canDrop) event.preventDefault()
            }
          : undefined
      }
      onDrop={editing ? onDrop : undefined}
      className={cn(LINE, 'min-h-8')}
    >
      <i
        aria-hidden
        className={cn(
          'ri-draggable text-base leading-none text-muted-foreground/50',
          editing ? 'cursor-grab' : 'invisible'
        )}
      />
      <span className='font-mono text-[12px] tabular-nums text-muted-foreground'>{index + 1}</span>
      {editing ? (
        // The line itself is the way to change it: which provider and
        // which tier is one decision, made in the dialog. Alt+↑/↓ is the
        // keyboard's way to do what the handle does by drag.
        <button
          type='button'
          aria-label={t('routing.scenarios.change', { combination })}
          aria-keyshortcuts='Alt+ArrowUp Alt+ArrowDown'
          onClick={onOpen}
          onKeyDown={(event) => {
            if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
            event.preventDefault()
            onStep(event.key === 'ArrowUp' ? -1 : 1)
          }}
          className={cn(box, 'w-full min-w-0 cursor-pointer border border-border text-left hover:bg-muted/60')}
        >
          {body}
        </button>
      ) : (
        <div className={box}>{body}</div>
      )}
      <Toggle
        on={route.enabled}
        editing={editing}
        label={t('routing.scenarios.enable', { combination })}
        onToggle={onToggle}
      />
      <button
        type='button'
        disabled={!editing}
        aria-label={t('routing.scenarios.remove', { combination })}
        onClick={onRemove}
        className={cn('text-muted-foreground/60 hover:text-foreground', editing ? '' : 'invisible')}
      >
        <i aria-hidden className='ri-close-line text-sm' />
      </button>
    </li>
  )
}

interface CellProps {
  at: CellAddress
  routes: readonly Combination[]
  editing: boolean
  actions: ScenarioEditing
  onOpen: (index: number | null) => void
  dragging: { at: CellAddress; index: number } | null
  setDragging: (next: { at: CellAddress; index: number } | null) => void
}

function Cell({ at, routes, editing, actions, onOpen, dragging, setDragging }: CellProps) {
  const { t } = useTranslation()
  const canDrop = dragging !== null && sameCell(dragging.at, at)
  return (
    <td className='px-2 py-3'>
      <div className='grid gap-1.5'>
        {routes.length === 0 ? (
          // An empty Think or Long context cell is not "nowhere to go": the
          // request falls back to Default for the same caller, and an empty
          // Default sends the caller's own model upstream.
          <div className={cn(LINE, 'min-h-8')}>
            <span />
            <span />
            <span className='px-2.5 text-[12px] text-muted-foreground'>
              {at.scenario === 'default' ? t('routing.scenarios.emptyDefault') : t('routing.scenarios.emptyFallback')}
            </span>
            <span />
          </div>
        ) : (
          <ol className='grid gap-1.5'>
            {routes.map((route, index) => (
              <Line
                key={combinationKey(route.provider, route.targetTier)}
                route={route}
                index={index}
                editing={editing}
                onOpen={() => onOpen(index)}
                onToggle={(enabled) => actions.onToggle(at, index, enabled)}
                onRemove={() => actions.onRemove(at, index)}
                onStep={(delta) => actions.onMove(at, index, index + delta)}
                onDragStart={() => setDragging({ at, index })}
                onDragEnd={() => setDragging(null)}
                canDrop={canDrop}
                onDrop={() => {
                  if (dragging !== null && canDrop) actions.onMove(at, dragging.index, index)
                  setDragging(null)
                }}
              />
            ))}
          </ol>
        )}
        {editing ? (
          // Add sits on the combination column, dashed, where the next
          // line would go.
          <div className={LINE}>
            <span />
            <span />
            <button
              type='button'
              onClick={() => onOpen(null)}
              className='flex h-8 items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 text-[12px] text-muted-foreground hover:bg-muted/60 hover:text-foreground'
            >
              <i aria-hidden className='ri-add-line text-sm' />
              {t('routing.scenarios.add')}
            </button>
            <span />
          </div>
        ) : null}
      </div>
    </td>
  )
}

interface DialogState {
  target: CombinationTarget
  /** The cell as it was when the dialog opened, so the fade-out after a
   *  confirm does not redraw the new line as "already added". */
  routes: readonly Combination[]
  open: boolean
}

export function ScenarioTable({
  draft,
  editing,
  longContextThreshold,
  actions,
  providers,
  aliases
}: {
  draft: ScenarioDraft
  editing: boolean
  longContextThreshold: number
  actions: ScenarioEditing
  providers: readonly string[]
  aliases: readonly TierAliasWire[] | null
}) {
  const { t } = useTranslation()
  // The line being dragged. Held here rather than in the line so a drop
  // knows both ends of the move without a dataTransfer round trip (which
  // Safari only populates on drop).
  const [dragging, setDragging] = useState<{ at: CellAddress; index: number } | null>(null)
  const [dialog, setDialog] = useState<DialogState | null>(null)

  const open = (at: CellAddress) => (index: number | null) =>
    setDialog({ target: { at, index }, routes: cellOf(draft, at), open: true })

  const confirm = (provider: string, tier: ModelTier) => {
    if (dialog !== null) {
      const { at, index } = dialog.target
      if (index === null) actions.onAdd(at, provider, tier)
      else actions.onChange(at, index, provider, tier)
    }
    setDialog((prev) => (prev === null ? null : { ...prev, open: false }))
  }

  return (
    <>
      <table className='w-full table-fixed'>
        <colgroup>
          <col className='w-72' />
          <col />
          <col />
        </colgroup>
        <thead>
          <tr className='text-[12px] uppercase tracking-wider text-muted-foreground/70 [&>th]:h-9 [&>th]:align-bottom [&>th]:pb-2'>
            <th className='pl-6 pr-2 text-left font-medium'>{t('routing.scenarios.colScenario')}</th>
            {ROUTING_LANE_ORDER.map((lane) => (
              <th key={lane} className='px-2 text-left font-medium'>
                {t(LANE_LABEL_KEYS[lane])}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROUTING_SCENARIO_ORDER.map((scenario) => (
            <tr key={scenario} className='border-t border-border/60 align-top'>
              <td className='py-3 pl-6 pr-2'>
                <div className='text-xs font-medium'>{t(SCENARIO_LABEL_KEYS[scenario])}</div>
                <div className='text-[12px] text-muted-foreground'>
                  <ScenarioWhen scenario={scenario} threshold={longContextThreshold} />
                </div>
              </td>
              {ROUTING_LANE_ORDER.map((lane) => (
                <Cell
                  key={lane}
                  at={{ scenario, lane }}
                  routes={draft[scenario][lane]}
                  editing={editing}
                  actions={actions}
                  onOpen={open({ scenario, lane })}
                  dragging={dragging}
                  setDragging={setDragging}
                />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <CombinationDialog
        target={dialog === null ? null : dialog.target}
        open={dialog?.open === true}
        routes={dialog === null ? [] : dialog.routes}
        providers={providers}
        aliases={aliases}
        onConfirm={confirm}
        onClose={() => setDialog((prev) => (prev === null ? null : { ...prev, open: false }))}
      />
    </>
  )
}
