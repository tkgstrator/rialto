/**
 * The profile's constraints, as a footer to the map they constrain.
 *
 * These were a right rail once. Four rows do not fill a page, so the rail
 * ran the full height beside a table that ended far sooner — a tall empty
 * column next to a short full one. Under the table they still read as
 * context you take in while reordering, in space the rail left blank.
 *
 * Four cells, each one a knob the tier router reads on every request:
 * what to answer when every route of a tier is out of quota, and the two
 * health gates (quota used, error rate, and the sample floor under the
 * error rate). Tier substitution is gone — substituting a tier is a row
 * in the map now, written where a reader can see it, not a gate deciding
 * which rows a request may use.
 *
 * Each cell is a reading until the screen's Edit is pressed, then the
 * control that sets it. There is no Save here: the edit rides the map's
 * own Revert / Save, because both live in one profile and one PUT carries
 * both.
 */

import { cn } from 'cn'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RoutingConstraintsWire } from '@/lib/api'
import { type ConstraintEdit, errorRatePctOf, parseSampleCount, parseWholePercent } from './derive'
import type { TypedConstraint } from './useTierMapActions'

type ExhaustedBehavior = RoutingConstraintsWire['exhaustedBehavior']

// bg-background so the cells sit on the 1px grid gap rather than letting
// the border colour show through them.
const ROW =
  'border-l-2 border-l-transparent bg-background px-4 py-3 transition-colors hover:border-l-border hover:bg-muted/50'

// The header row is h-8 in both states: the grid stretches the cells to
// one height, and a 32px control beside a 16px reading would sink its
// label below the labels next to it.
function ConstraintCell({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div className={ROW}>
      <div className='flex min-h-8 items-center gap-2'>
        <span className='text-xs'>{label}</span>
        {children}
      </div>
      <div className='mt-0.5 text-[12px] text-muted-foreground'>{hint}</div>
    </div>
  )
}

function Reading({ children }: { children: ReactNode }) {
  return <span className='ml-auto font-mono text-xs'>{children}</span>
}

// Both choices stay visible, like Routed / Passthrough in band 2 — but the
// wrapper is pinned to h-8 rather than sized by its items' padding, so it
// lines up with the inputs in the cells beside it.
function ExhaustedSwitch({
  value,
  onChange
}: {
  value: ExhaustedBehavior
  onChange: (next: ExhaustedBehavior) => void
}) {
  const { t } = useTranslation()
  const options: readonly { value: ExhaustedBehavior; label: string }[] = [
    { value: '429', label: '429' },
    { value: 'passthrough', label: t('routing.chain.modePassthroughLabel') }
  ]
  return (
    <div className='ml-auto flex h-8 items-center rounded-md border border-border p-0.5'>
      {options.map((option) => (
        <button
          key={option.value}
          type='button'
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            'flex h-full items-center rounded px-2.5 text-[12px]',
            option.value === value
              ? 'bg-foreground font-medium text-background'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

// Local text, so a half-typed value can exist on screen. Only a parsed
// value reaches the draft; anything else is reported up so Save stays off
// until it is fixed. The input mounts fresh on every Edit, so it never has
// to follow a value changed underneath it.
function NumberInput({
  value,
  unit,
  label,
  parse,
  onChange,
  onValidity
}: {
  value: number
  /** Drawn inside the box, so an edited cell still reads the way its reading did. */
  unit: string | null
  label: string
  parse: (text: string) => number | null
  onChange: (next: number) => void
  onValidity: (valid: boolean) => void
}) {
  const [text, setText] = useState(String(value))
  const valid = parse(text) !== null
  return (
    <div
      className={cn(
        'ml-auto inline-flex h-8 w-20 items-center justify-end gap-1 rounded-md border px-2.5 font-mono text-xs focus-within:border-foreground/40',
        valid ? 'border-border' : 'border-destructive'
      )}
    >
      <input
        type='text'
        inputMode='numeric'
        value={text}
        aria-label={label}
        aria-invalid={!valid}
        onChange={(event) => {
          const next = event.target.value
          setText(next)
          const parsed = parse(next)
          onValidity(parsed !== null)
          if (parsed !== null) onChange(parsed)
        }}
        className='w-full min-w-0 bg-transparent text-right outline-none'
      />
      {unit === null ? null : <span className='text-muted-foreground'>{unit}</span>}
    </div>
  )
}

export function TierConstraints({
  constraints,
  editing,
  onEdit,
  onValidity
}: {
  constraints: RoutingConstraintsWire
  editing: boolean
  onEdit: (edit: ConstraintEdit) => void
  onValidity: (field: TypedConstraint, valid: boolean) => void
}) {
  const { t } = useTranslation()
  const errorRatePct = errorRatePctOf(constraints)
  const quotaSkipLabel = t('routing.chain.quotaSkip')
  const errorRateLabel = t('routing.tiers.errorRateSkip')
  const minSamplesLabel = t('routing.tiers.minSamples')
  return (
    <div className='mt-6 border-t border-border'>
      <div className='px-6 pt-4 pb-2'>
        <h2 className='text-[12px] font-semibold uppercase tracking-wider text-muted-foreground'>
          {t('routing.chain.constraints')}
        </h2>
      </div>
      <div className='grid grid-cols-4 gap-px bg-border/60'>
        <ConstraintCell label={t('routing.chain.whenExhausted')} hint={t('routing.tiers.whenExhaustedHint')}>
          {editing ? (
            <ExhaustedSwitch
              value={constraints.exhaustedBehavior}
              onChange={(value) => onEdit({ kind: 'exhaustedBehavior', value })}
            />
          ) : (
            <Reading>
              {constraints.exhaustedBehavior === 'passthrough' ? t('routing.common.modePassthrough') : '429'}
            </Reading>
          )}
        </ConstraintCell>
        <ConstraintCell label={quotaSkipLabel} hint={t('routing.tiers.quotaSkipHint')}>
          {editing ? (
            <NumberInput
              value={constraints.quotaSkipPct}
              unit='%'
              label={quotaSkipLabel}
              parse={parseWholePercent}
              onChange={(value) => onEdit({ kind: 'quotaSkipPct', value })}
              onValidity={(valid) => onValidity('quotaSkipPct', valid)}
            />
          ) : (
            <Reading>{`${constraints.quotaSkipPct}%`}</Reading>
          )}
        </ConstraintCell>
        {/* Stored as a fraction (0.5), edited and read as a percentage:
            every other threshold on this screen is a percentage, and
            "0.5" beside "100%" reads as a different kind of knob. */}
        <ConstraintCell label={errorRateLabel} hint={t('routing.tiers.errorRateSkipHint')}>
          {editing ? (
            <NumberInput
              value={errorRatePct}
              unit='%'
              label={errorRateLabel}
              parse={parseWholePercent}
              onChange={(value) => onEdit({ kind: 'errorRateSkipPct', value })}
              onValidity={(valid) => onValidity('errorRateSkipPct', valid)}
            />
          ) : (
            <Reading>{`${errorRatePct}%`}</Reading>
          )}
        </ConstraintCell>
        <ConstraintCell label={minSamplesLabel} hint={t('routing.tiers.minSamplesHint')}>
          {editing ? (
            <NumberInput
              value={constraints.minHealthSamples}
              unit={null}
              label={minSamplesLabel}
              parse={parseSampleCount}
              onChange={(value) => onEdit({ kind: 'minHealthSamples', value })}
              onValidity={(valid) => onValidity('minHealthSamples', valid)}
            />
          ) : (
            <Reading>{constraints.minHealthSamples}</Reading>
          )}
        </ConstraintCell>
      </div>
    </div>
  )
}
