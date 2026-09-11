/**
 * The preference chain for one (surface profile, scenario, lane).
 *
 * Priority order is the entire point of the object, so the row leads with
 * the ordinal and a drag handle. The scheduler's factor is the only live
 * number left, shown as Health because that is what it now measures:
 * since it stopped being a share of the chain it IS the target's spent-ness
 * (budget × error rate × reset penalty), which made the other two columns
 * restatements of it — `healthiness` is the same score before the guards,
 * and quota-used is the largest term inside it. Both are still on the
 * snapshot for anyone debugging the scheduler, and the quota percentage is
 * still a column on the screens where an account, not a chain entry, is
 * the subject: Providers and Overview.
 *
 * The table reads until the screen's Edit is pressed. The handle and the
 * row menu go invisible rather than absent, so the columns do not move
 * when editing starts, and the switch stays as a reading of the state.
 */

import { cn } from 'cn'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pill } from '@/components/rialto/primitives'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { RoutingSchedulerWeightEntry } from '@/lib/api'
import { chainShares, inferTier, splitTarget, targetLabels } from './derive'
import type { PreferenceEntry } from './types'

export interface ChainRowActions {
  onToggle: (index: number, enabled: boolean) => void
  onMove: (from: number, to: number) => void
  onRemove: (index: number) => void
}

function RowMenu({
  index,
  count,
  actions,
  editing
}: {
  index: number
  count: number
  actions: ChainRowActions
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
          onClick={run(() => actions.onMove(index, index - 1))}
        >
          {t('routing.chain.moveUp')}
        </button>
        <button
          type='button'
          className={item}
          disabled={index === count - 1}
          onClick={run(() => actions.onMove(index, index + 1))}
        >
          {t('routing.chain.moveDown')}
        </button>
        <button type='button' className={cn(item, 'text-destructive')} onClick={run(() => actions.onRemove(index))}>
          {t('common.remove')}
        </button>
      </PopoverContent>
    </Popover>
  )
}

/**
 * A row's slice of the lane, or a dash when it has none.
 *
 * No `<1%` case: shares are apportioned to whole percents that must add
 * to 100, so a 0% on an enabled target is honest — it lost the
 * apportionment, or the scheduler scored it out of the running.
 */
function shareLabel(share: number | null): string {
  return share === null ? '–' : `${share}%`
}

/** A target the label map did not name falls back to the raw pair. */
const labelOf = (labels: Map<string, string>, target: string): string => {
  const value = labels.get(target)
  return value === undefined ? target : value
}

/** A target the apportionment did not name has no share, same as null. */
const shareOf = (shares: Map<string, number | null>, target: string): number | null => {
  const value = shares.get(target)
  return value === undefined ? null : value
}

function ChainRow({
  entry,
  index,
  count,
  share,
  label,
  actions,
  editing,
  onDragStart,
  onDragOver,
  onDrop
}: {
  entry: PreferenceEntry
  index: number
  count: number
  share: number | null
  /** Model name, or the full pair when the lane needs it — see targetLabels. */
  label: string
  actions: ChainRowActions
  editing: boolean
  onDragStart: () => void
  onDragOver: (event: React.DragEvent) => void
  onDrop: () => void
}) {
  const { t } = useTranslation()
  const declared = entry.resolvedTier
  const tier = declared === null || declared === undefined ? inferTier(splitTarget(entry.target).model) : declared
  return (
    <tr
      draggable={editing}
      onDragStart={editing ? onDragStart : undefined}
      onDragOver={editing ? onDragOver : undefined}
      onDrop={editing ? onDrop : undefined}
      className={cn('border-t border-border/60 transition-colors hover:bg-muted/50', entry.enabled ? '' : 'opacity-45')}
    >
      <td className='py-2.5 pl-6 pr-2'>
        <div className='flex items-center gap-2'>
          <i
            className={cn('ri-draggable text-base leading-none text-muted-foreground/50', editing ? '' : 'invisible')}
          />
          <span className='font-mono text-xs tabular-nums text-muted-foreground'>{index + 1}</span>
        </div>
      </td>
      <td className='px-2 truncate font-mono text-xs'>{label}</td>
      <td className='px-2'>{tier === null ? null : <Pill tone='mute'>{tier}</Pill>}</td>
      <td
        className={cn('px-2 text-right font-mono text-xs tabular-nums', share === null ? 'text-muted-foreground' : '')}
      >
        {shareLabel(share)}
      </td>
      <td className='py-2.5 pl-2 pr-6'>
        <div className='flex items-center justify-end gap-1'>
          <button
            type='button'
            role='switch'
            aria-checked={entry.enabled}
            aria-label={t('routing.chain.enableTarget', { target: entry.target })}
            disabled={!editing}
            onClick={() => actions.onToggle(index, !entry.enabled)}
            className={cn(
              'inline-flex h-4 w-7 items-center rounded-full px-0.5 disabled:opacity-50',
              entry.enabled ? 'bg-foreground' : 'bg-muted-foreground/30'
            )}
          >
            <span className={cn('size-3 rounded-full bg-background', entry.enabled ? 'translate-x-3' : '')} />
          </button>
          <RowMenu index={index} count={count} actions={actions} editing={editing} />
        </div>
      </td>
    </tr>
  )
}

export function ChainTable({
  entries,
  weights,
  actions,
  editing
}: {
  entries: readonly PreferenceEntry[]
  weights: Map<string, RoutingSchedulerWeightEntry>
  actions: ChainRowActions
  editing: boolean
}) {
  const { t } = useTranslation()
  // Index of the row currently being dragged. Held here rather than in the
  // row so a drop knows both ends of the move without a dataTransfer round
  // trip (which Safari only populates on drop).
  const [dragging, setDragging] = useState<number | null>(null)

  // Apportioned across the whole lane, so it has to be computed for the
  // table rather than per row: a share only means anything relative to
  // the other rows on screen.
  const shares = useMemo(
    () =>
      chainShares(
        entries.map((entry) => ({
          target: entry.target,
          enabled: entry.enabled,
          weight: weights.get(entry.target)?.weight
        }))
      ),
    [entries, weights]
  )

  const labels = useMemo(() => targetLabels(entries.map((entry) => entry.target)), [entries])

  const drop = (to: number) => () => {
    if (dragging !== null && dragging !== to) actions.onMove(dragging, to)
    setDragging(null)
  }

  return (
    <table className='w-full table-fixed'>
      {/* No State column. It reported the scheduler's reading of each
          target, which on most installs is `unknown` for most rows and
          is already implied by Share where it is not: an exhausted target
          shows 0%, a disabled one a dash. Passthrough keeps its State —
          that table has no Share to imply it. */}
      <colgroup>
        <col className='w-16' />
        <col />
        <col className='w-20' />
        <col className='w-24' />
        <col className='w-24' />
      </colgroup>
      <thead>
        <tr className='text-[12px] uppercase tracking-wider text-muted-foreground/70 [&>th]:h-9 [&>th]:whitespace-nowrap [&>th]:align-bottom [&>th]:pb-2'>
          <th className='pl-6 pr-2 text-left font-medium'>#</th>
          <th className='px-2 text-left font-medium'>{t('routing.common.colTarget')}</th>
          <th className='px-2 text-left font-medium'>{t('routing.common.colTier')}</th>
          <th className='px-2 text-right font-medium'>
            {t('routing.chain.colShare')}{' '}
            {/* Share is the one column a reader misreads — it is a slice
                of the lane's scheduler weight, not a traffic forecast.
                The caveat rides the header rather than the four-line
                dashed box that used to close the table. */}
            <i
              // role='img' so the label is valid on an <i>: the glyph is
              // the whole control, and without it a screen reader reads
              // the header as "Share" with no hint that a caveat exists.
              role='img'
              title={t('routing.chain.shareHint')}
              aria-label={t('routing.chain.shareHint')}
              className='ri-question-line align-[-1px] text-[13px] normal-case text-muted-foreground/50'
            />
          </th>
          <th className='pl-2 pr-6 text-right font-medium'>{t('routing.chain.colOn')}</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry, index) => (
          <ChainRow
            key={entry.target}
            entry={entry}
            index={index}
            count={entries.length}
            share={shareOf(shares, entry.target)}
            label={labelOf(labels, entry.target)}
            actions={actions}
            editing={editing}
            onDragStart={() => setDragging(index)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={drop(index)}
          />
        ))}
      </tbody>
    </table>
  )
}
