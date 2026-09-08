/**
 * The model table on a provider detail.
 *
 * Prices stay in three separate right-aligned columns (in / cached / out).
 * One packed "$3/$0.30/$15" cell is unreadable and unsortable, and the
 * three legs are independently null — a vendor that publishes no cached
 * price still publishes the other two.
 */
import { useTranslation } from 'react-i18next'
import { Pill, Toggle } from '@/components/rialto/primitives'
import { SortTh, type SortValue, useTableSort } from '@/components/rialto/table-sort'
import { fmtCost } from '@/lib/sessions/format'
import { cn } from '@/lib/utils'
import { fmtContext, type ModelRow, type TierSource } from './derive'
import type { ReasoningEffort, TestStatus, Tier } from './types'

const TEST_ICON: Record<TestStatus, string> = {
  ok: 'ri-check-line text-emerald-600 dark:text-emerald-400',
  fail: 'ri-close-line text-destructive',
  unknown: 'ri-subtract-line text-muted-foreground/50'
}

function TestIcon({ status }: { status: TestStatus }) {
  return <i className={TEST_ICON[status]} />
}

/** The three states an override cell can be in, and what each says. */
const CELL_TONE: Record<TierSource, string> = {
  // Someone chose this.
  manual: 'bg-muted text-foreground',
  // Inferred from the name; true until the name changes.
  auto: 'text-muted-foreground',
  // Neither — the router cannot classify this model at all.
  unset: 'text-muted-foreground/50'
}

/**
 * An inline override picker: the value, a chevron, and a native select
 * over the top.
 *
 * Native rather than a popover because the list is four to eight fixed
 * options in a dense table row — a keyboard user should get the platform
 * control, and a row that opens a floating panel per cell is a table that
 * cannot be scanned. The select is transparent and absolutely positioned
 * so the cell keeps the mock's compact treatment.
 */
function OverrideCell({
  value,
  tone,
  label,
  options,
  onChange
}: {
  value: string
  tone: TierSource
  label: string
  options: readonly { value: string; label: string }[]
  onChange: (next: string) => void
}) {
  return (
    <span
      className={cn(
        'relative inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] transition-colors hover:bg-muted/60',
        CELL_TONE[tone]
      )}
    >
      {value}
      <i className='ri-arrow-down-s-line text-xs opacity-60' />
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className='absolute inset-0 cursor-pointer opacity-0'
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </span>
  )
}

type ModelSortKey =
  | 'name'
  | 'tier'
  | 'contextWindow'
  | 'inputPer1M'
  | 'cachedInputPer1M'
  | 'outputPer1M'
  | 'test'
  | 'enabled'

// Sorting reads the row's own field for every column, so what the header
// orders by is what the cell shows. `tier` and `test` are short enums
// rendered as a pill / glyph; sorting them alphabetically groups like
// with like, which is the whole point of clicking those two.
const modelSortValue = (row: ModelRow, key: ModelSortKey): SortValue => row[key]

const NUM_CELL = 'px-2 text-right font-mono text-xs tabular-nums'
const HEAD_CELL = 'px-2 text-right font-medium'

function Head({
  withOverride,
  sort
}: {
  withOverride: boolean
  sort: ReturnType<typeof useTableSort<ModelRow, ModelSortKey>>
}) {
  const { t } = useTranslation()
  return (
    <thead>
      <tr className='text-[12px] uppercase tracking-wider text-muted-foreground/70 [&>th]:pb-2'>
        <SortTh sortKey='name' sort={sort} className='pl-6 pr-2 text-left'>
          {t('providers.models.colModel')}
        </SortTh>
        <SortTh sortKey='tier' sort={sort} className='px-2 text-left'>
          {t('providers.models.colTier')}
        </SortTh>
        <SortTh sortKey='contextWindow' sort={sort} className={HEAD_CELL} align='right'>
          {t('providers.models.colContext')}
        </SortTh>
        <SortTh sortKey='inputPer1M' sort={sort} className={HEAD_CELL} align='right'>
          {t('providers.models.colIn')}
        </SortTh>
        <SortTh sortKey='cachedInputPer1M' sort={sort} className={HEAD_CELL} align='right'>
          {t('providers.models.colCached')}
        </SortTh>
        <SortTh sortKey='outputPer1M' sort={sort} className={HEAD_CELL} align='right'>
          {t('providers.models.colOut')}
        </SortTh>
        {/* The two override pickers are controls, not values the operator
            scans down a column, so they stay unsorted. */}
        {withOverride ? <th className='px-2 text-left font-medium'>{t('providers.models.colShape')}</th> : null}
        {withOverride ? <th className='px-2 text-left font-medium'>{t('providers.models.colEffort')}</th> : null}
        <SortTh sortKey='test' sort={sort} className='px-2 text-center' align='center'>
          {t('providers.models.colTest')}
        </SortTh>
        <SortTh sortKey='enabled' sort={sort} className='pl-2 pr-6 text-right' align='right'>
          {t('providers.models.colOn')}
        </SortTh>
      </tr>
    </thead>
  )
}

const DASH = '—'
const TIERS: readonly Tier[] = ['fable', 'opus', 'sonnet', 'haiku']
const EFFORTS: readonly ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

// Narrowing by lookup rather than by assertion: the select hands back a
// string, and the only strings that mean anything are the ones in these
// tables. Anything else — including the dash — clears the override.
const toTier = (value: string): Tier | null => {
  const found = TIERS.find((tier) => tier === value)
  return found === undefined ? null : found
}
const toEffort = (value: string): ReasoningEffort | null => {
  const found = EFFORTS.find((effort) => effort === value)
  return found === undefined ? null : found
}

function Row({
  row,
  withOverride,
  onToggle,
  onTier,
  onEffort
}: {
  row: ModelRow
  withOverride: boolean
  onToggle: (model: string, next: boolean) => void
  onTier: (model: string, next: Tier | null) => void
  onEffort: (model: string, next: ReasoningEffort | null) => void
}) {
  const { t } = useTranslation()
  // Subscription models carry no per-token price, so their money columns
  // read as absent rather than as a number worth comparing.
  const priceTone = withOverride ? '' : 'text-muted-foreground'
  return (
    <tr
      className={cn('border-t border-border/60 transition-colors hover:bg-muted/50', row.enabled ? '' : 'opacity-45')}
    >
      <td className='py-2.5 pl-6 pr-2'>
        <div className='flex items-center gap-2'>
          <span className='font-mono text-xs'>{row.name}</span>
          {row.legacy ? <Pill tone='mute'>{t('providers.models.legacy')}</Pill> : null}
        </div>
      </td>
      <td className='px-2'>
        <OverrideCell
          value={row.tier === null ? DASH : row.tier}
          tone={row.tierSource}
          label={t('providers.models.setTier', { model: row.name })}
          options={[
            { value: DASH, label: t('providers.models.tierAuto') },
            ...TIERS.map((tier) => ({ value: tier, label: tier }))
          ]}
          onChange={(next) => onTier(row.name, toTier(next))}
        />
      </td>
      <td className={cn(NUM_CELL, 'text-muted-foreground')}>{fmtContext(row.contextWindow)}</td>
      <td className={cn(NUM_CELL, priceTone)}>{fmtCost(row.inputPer1M)}</td>
      <td className={cn(NUM_CELL, 'text-muted-foreground')}>{fmtCost(row.cachedInputPer1M)}</td>
      <td className={cn(NUM_CELL, priceTone)}>{fmtCost(row.outputPer1M)}</td>
      {withOverride ? (
        <td className='px-2 font-mono text-[12px] text-muted-foreground'>
          {row.apiStyleOverride === null ? DASH : row.apiStyleOverride}
        </td>
      ) : null}
      {withOverride ? (
        <td className='px-2'>
          <OverrideCell
            value={row.effort === null ? DASH : row.effort}
            tone={row.effort === null ? 'unset' : 'manual'}
            label={t('providers.models.setEffort', { model: row.name })}
            options={[
              { value: DASH, label: t('providers.models.effortDefault') },
              ...EFFORTS.map((effort) => ({ value: effort, label: effort }))
            ]}
            onChange={(next) => onEffort(row.name, toEffort(next))}
          />
        </td>
      ) : null}
      <td className='px-2 text-center text-sm leading-none'>
        <TestIcon status={row.test} />
      </td>
      <td className='py-2.5 pl-2 pr-6 text-right'>
        <Toggle
          on={row.enabled}
          label={t('providers.models.toggleModel', { model: row.name })}
          onClick={() => onToggle(row.name, !row.enabled)}
        />
      </td>
    </tr>
  )
}

export function ModelsTable({
  rows,
  limit,
  withOverride,
  onToggle,
  onTier,
  onEffort
}: {
  rows: ModelRow[]
  /** Rows to render. Paging happens AFTER the sort, not before it: given
   *  the pre-sliced page, "cheapest first" ranked the visible eight of 61
   *  models and answered a question nobody asked. */
  limit?: number
  withOverride: boolean
  onToggle: (model: string, next: boolean) => void
  onTier: (model: string, next: Tier | null) => void
  onEffort: (model: string, next: ReasoningEffort | null) => void
}) {
  const { t } = useTranslation()
  // Hooks run before the empty-state return: an early return above a hook
  // changes the hook order between renders.
  const sort = useTableSort<ModelRow, ModelSortKey>(rows, modelSortValue)
  if (rows.length === 0) {
    return <div className='px-6 pb-6 text-xs text-muted-foreground'>{t('providers.models.empty')}</div>
  }
  return (
    <table className='w-full table-fixed'>
      <colgroup>
        <col />
        <col className='w-20' />
        <col className='w-20' />
        <col className='w-20' />
        <col className='w-20' />
        <col className='w-20' />
        {withOverride ? <col className='w-24' /> : null}
        {withOverride ? <col className='w-24' /> : null}
        <col className={withOverride ? 'w-14' : 'w-16'} />
        <col className={withOverride ? 'w-16' : 'w-20'} />
      </colgroup>
      <Head withOverride={withOverride} sort={sort} />
      <tbody>
        {(limit === undefined ? sort.sorted : sort.sorted.slice(0, limit)).map((row) => (
          <Row
            key={row.name}
            row={row}
            withOverride={withOverride}
            onToggle={onToggle}
            onTier={onTier}
            onEffort={onEffort}
          />
        ))}
      </tbody>
    </table>
  )
}
