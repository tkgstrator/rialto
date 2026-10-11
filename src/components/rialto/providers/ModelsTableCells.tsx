import { cn } from 'cn'
import { useTranslation } from 'react-i18next'
import { openAiEffortsFor } from '@/shared/model-reasoning-effort'
import { effortLadder, type ThinkingOffReading, thinkingOffReadings } from './capability-reading'
import type { ModelRow } from './derive'
import { TIERS, type TierView } from './tier-aliases'
import type { ReasoningEffort, TestStatus, Tier } from './types'

const TEST_ICON: Record<TestStatus, string> = {
  ok: 'ri-check-line text-emerald-600 dark:text-emerald-400',
  fail: 'ri-close-line text-destructive',
  unknown: 'ri-subtract-line text-muted-foreground/50'
}

export function TestIcon({ status }: { status: TestStatus }) {
  return <i className={TEST_ICON[status]} />
}

/** The two states an effort cell can be in: someone chose one, or the vendor picks. */
type CellTone = 'set' | 'unset'

const CELL_TONE: Record<CellTone, string> = {
  set: 'bg-muted text-foreground',
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
  reading = value,
  tone,
  label,
  options,
  onChange
}: {
  value: string
  reading?: string
  tone: CellTone
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
      {reading}
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

/**
 * The same cell while the page reads: the picker's tone, so a chosen
 * effort still stands out from the vendor default, without the chevron
 * that says it opens.
 */
function ReadCell({ value, tone }: { value: string; tone: CellTone }) {
  return (
    <span className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-[12px]', CELL_TONE[tone])}>{value}</span>
  )
}

export const DASH = '—'
const EFFORTS: readonly ReasoningEffort[] = [
  'auto',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra'
]

// Narrowing by lookup rather than by assertion: the select hands back a
// string, and only options in this table are accepted.
const toEffort = (value: string): ReasoningEffort | null => {
  const found = EFFORTS.find((effort) => effort === value)
  return found === undefined ? null : found
}

/**
 * The tier column: every tier this model belongs to on its provider,
 * filled where the tier reaches it today and outlined where it does not
 * (an older or switched-off model its name still says).
 *
 * A derived tier follows model switches and remains a reading. A manual
 * tier is assignable while editing: the same staged alias state that feeds
 * the strip above feeds these buttons, so both controls always agree.
 */
export function TierCell({
  row,
  editable,
  tiers,
  onAlias
}: {
  row: ModelRow
  editable?: boolean
  tiers?: readonly TierView[]
  onAlias?: (tier: Tier, model: string | null) => void
}) {
  const canEdit = editable === true
  const resolvedTiers = tiers === undefined ? [] : tiers
  const changeAlias = onAlias === undefined ? () => {} : onAlias
  const { t } = useTranslation()
  const manual = resolvedTiers.filter((view) => view.mode === 'manual')
  if (!canEdit || manual.length === 0) {
    if (row.tiers.length === 0) return <span className='text-[12px] text-muted-foreground/50'>{DASH}</span>
    return (
      <span className='inline-flex items-center gap-1 whitespace-nowrap'>
        {row.tiers.map(({ tier, routed }) => (
          <span
            key={tier}
            className={cn(
              'inline-flex items-center rounded px-1.5 text-[12px]',
              routed ? 'bg-muted py-0.5' : 'border border-border py-px text-muted-foreground/70'
            )}
          >
            {tier}
          </span>
        ))}
      </span>
    )
  }
  return (
    <span className='inline-flex flex-wrap items-center gap-1'>
      {TIERS.map((tier) => {
        const view = manual.find((candidate) => candidate.tier === tier)
        if (view === undefined) return null
        const selected = view.model === row.name
        return (
          <button
            key={tier}
            type='button'
            aria-pressed={selected}
            aria-label={t('providers.models.setTier', { model: row.name, tier })}
            onClick={() => changeAlias(tier, selected ? null : row.name)}
            className={cn(
              'inline-flex items-center rounded px-1.5 text-[12px] transition-colors',
              selected
                ? 'bg-muted py-0.5 text-foreground'
                : 'border border-border py-px text-muted-foreground/70 hover:bg-muted/60 hover:text-foreground'
            )}
          >
            {tier}
          </button>
        )
      })}
    </span>
  )
}

/** The effort column: a picker while editing, the reading otherwise. */
export function EffortCell({
  row,
  editable,
  effortKind,
  onEffort
}: {
  row: ModelRow
  editable: boolean
  effortKind: 'openai' | 'claude-code'
  onEffort: (model: string, next: ReasoningEffort | null) => void
}) {
  const { t } = useTranslation()
  const value = row.effort === null ? DASH : row.effort
  const reading = row.effort === 'auto' ? t('providers.models.effortAuto') : value
  const tone = row.effort === null ? 'unset' : 'set'
  // What the model's own list reported wins; an api_key OpenAI model, which
  // records nothing, falls back to the static table.
  const known =
    row.supportedEfforts !== null
      ? row.supportedEfforts
      : effortKind === 'claude-code'
        ? null
        : openAiEffortsFor(row.name)
  const manualOptions =
    known === null
      ? effortKind === 'claude-code'
        ? EFFORTS.filter((option) => option === 'auto' || option === row.effort)
        : EFFORTS
      : EFFORTS.filter((option) => option === 'auto' || option === row.effort || known.includes(option))
  if (!editable) return <ReadCell value={reading} tone={tone} />
  return (
    <OverrideCell
      value={value}
      reading={reading}
      tone={tone}
      label={t('providers.models.setEffort', { model: row.name })}
      options={[
        { value: DASH, label: t('providers.models.effortDefault') },
        ...manualOptions.map((option) => ({
          value: option,
          label: option === 'auto' ? t('providers.models.effortAutoOption') : option
        }))
      ]}
      onChange={(next) => onEffort(row.name, toEffort(next))}
    />
  )
}

/** A value that holds, filled; one that says "nothing here", outlined — the tier column's two treatments. */
function Badge({ children, filled = true }: { children: string; filled?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 text-[12px]',
        filled ? 'bg-muted py-0.5' : 'border border-border py-px text-muted-foreground/70'
      )}
    >
      {children}
    </span>
  )
}

const Dash = () => <span className='text-[12px] text-muted-foreground/50'>{DASH}</span>

/**
 * The Effort levels column: what the model's own list reported, lowest
 * first. A dash until it has been read; `unsupported` for a model whose
 * list names no level, which is a fact rather than a gap.
 */
export function EffortLevelsCell({ efforts }: { efforts: ModelRow['supportedEfforts'] }) {
  const { t } = useTranslation()
  if (efforts === null) return <Dash />
  if (efforts.length === 0) return <Badge filled={false}>{t('providers.models.capEffortNone')}</Badge>
  return (
    <span className='inline-flex items-center gap-1'>
      {effortLadder(efforts).map((level) => (
        <Badge key={level}>{level}</Badge>
      ))}
    </span>
  )
}

const thinkingCondition = (reading: ThinkingOffReading): string | null => {
  if (reading.when === 'always') return null
  if (reading.when === 'upTo') return `≤ ${reading.effort}`
  return reading.keys.join('/')
}

/**
 * The Thinking off column: each setting the model takes, as a badge in
 * its wire spelling, with the efforts it holds at beside it. `always on`
 * when it takes neither. A dash until the probe has run, which it does
 * only on switched-on models.
 */
export function ThinkingOffCell({ row }: { row: ModelRow }) {
  const { t } = useTranslation()
  if (row.thinkingOff === null) return <Dash />
  const readings = thinkingOffReadings(row.thinkingOff, row.supportedEfforts)
  if (readings.length === 0) return <Badge filled={false}>{t('providers.models.capThinkingAlwaysOn')}</Badge>
  return (
    <span className='inline-flex items-center gap-1.5'>
      {readings.map((reading) => {
        const condition = thinkingCondition(reading)
        return (
          <span key={reading.setting} className='inline-flex items-center gap-1.5'>
            <Badge>{reading.setting}</Badge>
            {condition === null ? null : <span className='text-[12px] text-muted-foreground'>{condition}</span>}
          </span>
        )
      })}
    </span>
  )
}

export function ImagePriceBadge({ pricing }: { pricing: ModelRow['imagePricing'] }) {
  if (pricing === null) return null
  return (
    <span
      className='text-[11px] text-muted-foreground'
      title={`API-equivalent USD per 1M tokens (not subscription billing). Text input $${pricing.textInputPer1M}, cached text input $${pricing.cachedTextInputPer1M}; image input $${pricing.imageInputPer1M}, cached image input $${pricing.cachedImageInputPer1M}, image output $${pricing.imageOutputPer1M}. Snapshot ${pricing.snapshot}. Source: ${pricing.source}. Supports ${pricing.endpoints.join(', ')}.`}
    >
      image · API equivalent
    </span>
  )
}
