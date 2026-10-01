/**
 * The model table on a provider detail.
 *
 * Prices stay in three separate right-aligned columns (in / cached / out).
 * One packed "$3/$0.30/$15" cell is unreadable and unsortable, and the
 * three legs are independently null — a vendor that publishes no cached
 * price still publishes the other two.
 */

import { cn } from 'cn'
import { useTranslation } from 'react-i18next'
import { Pill, Toggle } from '@/components/rialto/primitives'
import { SortTh, type SortValue, useTableSort } from '@/components/rialto/table-sort'
import { fmtCost } from '@/lib/sessions/format'
import { effortLadder } from './capability-reading'
import { fmtContext, type ModelRow } from './derive'
import {
  DASH,
  EffortCell,
  EffortLevelsCell,
  ImagePriceBadge,
  TestIcon,
  ThinkingOffCell,
  TierCell
} from './ModelsTableCells'
import { SwitchReading } from './SwitchReading'
import { TIERS, type TierView } from './tier-aliases'
import type { ReasoningEffort, Tier } from './types'

export { TestIcon, TierCell } from './ModelsTableCells'

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
// orders by is what the cell shows. `test` is a short enum rendered as a
// glyph; sorting it alphabetically groups like with like, which is the
// whole point of clicking it. The tier sorts by the first tier a model
// belongs to, in strip order — fable first ascending — rather than by the
// label, which would put haiku ahead of opus; a model in none is missing,
// and sorts last either way.
const modelSortValue = (row: ModelRow, key: ModelSortKey): SortValue => {
  if (key !== 'tier') return row[key]
  const [first] = row.tiers
  return first === undefined ? null : TIERS.indexOf(first.tier)
}

const NUM_CELL = 'px-2 text-right font-mono text-xs tabular-nums'

// The Effort levels and Thinking off columns, shown only once the table
// is 84rem wide. Measured on the table rather than the viewport: the
// sidebar and a provider's own optional columns take their share first.
// Below that they are dropped, not squeezed, so the model name keeps its
// room; the effort picker still offers only the recorded levels.
const WIDE_CELL = 'hidden @min-[84rem]:table-cell'
const WIDE_COL = 'hidden @min-[84rem]:table-column'

// The Effort levels column, sized for the longest ladder a row reports:
// its badges sit on one line and would otherwise run on into the Tier
// column, as a Codex list up to `ultra` did at a fixed 16rem. At 12px the
// widest badges (medium, minimal) are about 58px and the rest narrower, so
// 16rem holds any four levels and each level past that adds 2.5rem, with
// room to spare at every count. At 84rem, where the column first shows,
// the model name keeps 19.5rem beside Claude's five levels and Thinking
// off, and 12rem even beside all eight.
const EFFORT_LEVELS_WIDTHS = ['w-64', 'w-70', 'w-80', 'w-90', 'w-100'] as const
const effortLevelsWidth = (rows: readonly ModelRow[]): string => {
  const longest = Math.max(
    0,
    ...rows.map((row) => (row.supportedEfforts === null ? 0 : effortLadder(row.supportedEfforts).length))
  )
  return EFFORT_LEVELS_WIDTHS[Math.min(Math.max(longest - 4, 0), EFFORT_LEVELS_WIDTHS.length - 1)]
}
const HEAD_CELL = 'px-2 text-right font-medium'

function Head({
  withOverride,
  withTier,
  hasCached,
  hasShape,
  hasEffortReading,
  hasThinkingReading,
  sort
}: {
  withOverride: boolean
  withTier: boolean
  hasCached: boolean
  hasShape: boolean
  hasEffortReading: boolean
  hasThinkingReading: boolean
  sort: ReturnType<typeof useTableSort<ModelRow, ModelSortKey>>
}) {
  const { t } = useTranslation()
  return (
    <thead>
      <tr className='text-[12px] uppercase tracking-wider text-muted-foreground/70 [&>th]:h-9 [&>th]:whitespace-nowrap [&>th]:align-bottom [&>th]:pb-2'>
        <SortTh sortKey='name' sort={sort} className='pl-6 pr-2 text-left'>
          {t('providers.models.colModel')}
        </SortTh>
        {/* Sets of values rather than one each, so like Shape and Effort
            they have nothing to sort by. */}
        {hasEffortReading ? (
          <th className={cn(WIDE_CELL, 'px-2 text-left font-medium')} title={t('providers.models.capEffortTitle')}>
            {t('providers.models.colEffortLevels')}
          </th>
        ) : null}
        {hasThinkingReading ? (
          <th className={cn(WIDE_CELL, 'px-2 text-left font-medium')} title={t('providers.models.capThinkingTitle')}>
            {t('providers.models.colThinkingOff')}
          </th>
        ) : null}
        {withTier ? (
          <SortTh sortKey='tier' sort={sort} className='px-2 text-left'>
            {t('providers.models.colTier')}
          </SortTh>
        ) : null}
        <SortTh sortKey='contextWindow' sort={sort} className={HEAD_CELL} align='right'>
          {t('providers.models.colContext')}
        </SortTh>
        <SortTh sortKey='inputPer1M' sort={sort} className={HEAD_CELL} align='right'>
          {t('providers.models.colIn')}
        </SortTh>
        {hasCached ? (
          <SortTh sortKey='cachedInputPer1M' sort={sort} className={HEAD_CELL} align='right'>
            {t('providers.models.colCached')}
          </SortTh>
        ) : null}
        <SortTh sortKey='outputPer1M' sort={sort} className={HEAD_CELL} align='right'>
          {t('providers.models.colOut')}
        </SortTh>
        {/* The shape reading and the effort picker describe a request, not
            a value the operator scans down a column, so they stay unsorted. */}
        {withOverride && hasShape ? (
          <th className='px-2 text-left font-medium'>{t('providers.models.colShape')}</th>
        ) : null}
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

function Row({
  row,
  withOverride,
  withTier,
  editable,
  effortKind,
  hasCached,
  hasShape,
  hasEffortReading,
  hasThinkingReading,
  tiers,
  onToggle,
  onEffort,
  onAlias
}: {
  row: ModelRow
  withOverride: boolean
  withTier: boolean
  editable: boolean
  effortKind: 'openai' | 'claude-code'
  hasCached: boolean
  hasShape: boolean
  hasEffortReading: boolean
  hasThinkingReading: boolean
  tiers: readonly TierView[]
  onToggle: (model: string, next: boolean) => void
  onEffort: (model: string, next: ReasoningEffort | null) => void
  onAlias: (tier: Tier, model: string | null) => void
}) {
  const { t } = useTranslation()
  // Generic money columns do not describe image vs text modalities.
  const priceTone = withOverride ? '' : 'text-muted-foreground'
  const toggleLabel = t('providers.models.toggleModel', { model: row.name })
  return (
    <tr
      className={cn('border-t border-border/60 transition-colors hover:bg-muted/50', row.enabled ? '' : 'opacity-45')}
    >
      <td className='py-2.5 pl-6 pr-2'>
        <div className='flex items-center gap-2'>
          <span className='font-mono text-xs'>{row.name}</span>
          <ImagePriceBadge pricing={row.imagePricing} />
          {/* Newer than the model its tier routes to, and switched off:
              it serves nothing until someone switches it on, which moves
              the tier to it. */}
          {row.newer ? <Pill tone='info'>{t('providers.models.newer')}</Pill> : null}
          {row.legacy ? <Pill tone='mute'>{t('providers.models.legacy')}</Pill> : null}
        </div>
      </td>
      {hasEffortReading ? (
        <td className={cn(WIDE_CELL, 'px-2 whitespace-nowrap')}>
          <EffortLevelsCell efforts={row.supportedEfforts} />
        </td>
      ) : null}
      {hasThinkingReading ? (
        <td className={cn(WIDE_CELL, 'px-2 whitespace-nowrap')}>
          <ThinkingOffCell row={row} />
        </td>
      ) : null}
      {withTier ? (
        <td className='px-2'>
          <TierCell row={row} editable={editable} tiers={tiers} onAlias={onAlias} />
        </td>
      ) : null}
      <td className={cn(NUM_CELL, 'text-muted-foreground')}>{fmtContext(row.contextWindow)}</td>
      <td className={cn(NUM_CELL, priceTone)}>{fmtCost(row.inputPer1M)}</td>
      {hasCached ? <td className={cn(NUM_CELL, 'text-muted-foreground')}>{fmtCost(row.cachedInputPer1M)}</td> : null}
      <td className={cn(NUM_CELL, priceTone)}>{fmtCost(row.outputPer1M)}</td>
      {withOverride && hasShape ? (
        <td className='px-2 font-mono text-[12px] text-muted-foreground'>
          {row.apiStyleOverride === null ? DASH : row.apiStyleOverride}
        </td>
      ) : null}
      {withOverride ? (
        <td className='px-2'>
          <EffortCell row={row} editable={editable} effortKind={effortKind} onEffort={onEffort} />
        </td>
      ) : null}
      <td className='px-2 text-center text-sm leading-none'>
        <TestIcon status={row.test} />
      </td>
      <td className='py-2.5 pl-2 pr-6 text-right'>
        {editable ? (
          <Toggle on={row.enabled} label={toggleLabel} onClick={() => onToggle(row.name, !row.enabled)} />
        ) : (
          <SwitchReading on={row.enabled} label={toggleLabel} />
        )}
      </td>
    </tr>
  )
}

export function ModelsTable({
  rows,
  limit,
  offset = 0,
  withOverride,
  withTier = false,
  editable = true,
  effortKind = 'openai',
  tiers = [],
  onToggle,
  onEffort,
  onAlias = () => {}
}: {
  rows: ModelRow[]
  /** Rows to render, from `offset`. Paging happens AFTER the sort, not
   *  before it: given the pre-sliced page, "cheapest first" ranked the
   *  visible eight of 61 models and answered a question nobody asked. */
  limit?: number
  offset?: number
  withOverride: boolean
  /** The Tier column. A provider's page has the tiers to fill it; the
   *  add-provider wizard does not resolve them, and a column of dashes
   *  there would say "serves nothing" about models it has not resolved. */
  withTier?: boolean
  /** False while a provider's page reads: the pickers and switches show
   *  their values and take no input until Edit is pressed. The
   *  add-provider wizard's table is always editable. */
  editable?: boolean
  effortKind?: 'openai' | 'claude-code'
  /** Every tier this provider resolves, so manual tiers can be assigned from a model row. */
  tiers?: readonly TierView[]
  onToggle: (model: string, next: boolean) => void
  onEffort: (model: string, next: ReasoningEffort | null) => void
  onAlias?: (tier: Tier, model: string | null) => void
}) {
  const { t } = useTranslation()
  // Hooks run before the empty-state return: an early return above a hook
  // changes the hook order between renders.
  const sort = useTableSort<ModelRow, ModelSortKey>(rows, modelSortValue)
  // A column of nothing but dashes still costs its width, and on a
  // provider whose models carry neither a cached price nor a per-model
  // api-style override that width came out of the model name — which was
  // wrapping to three lines while four columns held `–`. An absent column
  // says the same thing the dashes did, in no space at all.
  const hasCached = rows.some((row) => row.cachedInputPer1M !== null)
  const hasShape = rows.some((row) => row.apiStyleOverride !== null)
  // The same rule for the two capability columns: Codex, which has no
  // thinking probe, gets no Thinking off column, and an api_key provider,
  // which records nothing, gets neither.
  const hasEffortReading = rows.some((row) => row.supportedEfforts !== null)
  const hasThinkingReading = rows.some((row) => row.thinkingOff !== null)
  // Wide enough for two tier pills wherever a model is in two tiers. The
  // subscription table has the room to spare anyway; the api_key one,
  // with Shape and Effort beside it, keeps the narrow column until a row
  // needs more.
  const tierWidth = !withOverride || rows.some((row) => row.tiers.length > 1) ? 'w-28' : 'w-20'

  if (rows.length === 0) {
    return <div className='px-6 pb-6 text-xs text-muted-foreground'>{t('providers.models.empty')}</div>
  }
  return (
    <div className='@container'>
      <table className='w-full table-fixed'>
        <colgroup>
          <col />
          {hasEffortReading ? <col className={cn(WIDE_COL, effortLevelsWidth(rows))} /> : null}
          {hasThinkingReading ? <col className={cn(WIDE_COL, 'w-44')} /> : null}
          {withTier ? <col className={tierWidth} /> : null}
          <col className='w-20' />
          <col className='w-20' />
          {hasCached ? <col className='w-20' /> : null}
          <col className='w-20' />
          {withOverride && hasShape ? <col className='w-24' /> : null}
          {withOverride ? <col className='w-24' /> : null}
          <col className={withOverride ? 'w-14' : 'w-16'} />
          <col className={withOverride ? 'w-16' : 'w-20'} />
        </colgroup>
        <Head
          withOverride={withOverride}
          withTier={withTier}
          hasCached={hasCached}
          hasShape={hasShape}
          hasEffortReading={hasEffortReading}
          hasThinkingReading={hasThinkingReading}
          sort={sort}
        />
        <tbody>
          {(limit === undefined ? sort.sorted : sort.sorted.slice(offset, offset + limit)).map((row) => (
            <Row
              key={row.name}
              row={row}
              withOverride={withOverride}
              withTier={withTier}
              editable={editable}
              effortKind={effortKind}
              hasCached={hasCached}
              hasShape={hasShape}
              hasEffortReading={hasEffortReading}
              hasThinkingReading={hasThinkingReading}
              tiers={tiers}
              onToggle={onToggle}
              onEffort={onEffort}
              onAlias={onAlias}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}
