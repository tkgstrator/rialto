/**
 * The selector's constraints on the profile, as a footer to the chain they
 * constrain.
 *
 * These were a right rail. Four rows do not fill a page, so the rail ran
 * the full height beside a table that ended after five — a tall empty
 * column next to a short full one, with the emptier half taking 320px
 * from the chain and from the two bands above it. Under the table they
 * still read as context you take in while reordering, and they land in
 * the space the rail was leaving blank anyway.
 *
 * Three cells. A fourth showed a healthiness floor that nothing on the
 * request path reads, and a reading with no effect invites an edit with
 * no effect.
 *
 * Each cell is a reading until the screen's Edit is pressed, then the
 * control that sets it. There is no Save here: the edit rides the chain's
 * own Revert / Save, because both live in one profile and one PUT carries
 * both.
 */

import { cn } from 'cn'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  type ConstraintEdit,
  type ExhaustedBehavior,
  exhaustedBehaviorOf,
  parseQuotaSkipPct,
  quotaSkipPctOf,
  type TierSubstitution,
  tierSubstitutionOf
} from './derive'

// bg-background so the cells sit on the 1px grid gap rather than letting
// the border colour show through them.
const ROW =
  'border-l-2 border-l-transparent bg-background px-4 py-3 transition-colors hover:border-l-border hover:bg-muted/50'

const SUBSTITUTIONS: readonly TierSubstitution[] = ['upDown', 'up', 'down', 'same']

const SUBSTITUTION_KEYS: Record<TierSubstitution, string> = {
  upDown: 'routing.chain.substitutionUpDown',
  up: 'routing.chain.substitutionUp',
  down: 'routing.chain.substitutionDown',
  same: 'routing.chain.substitutionSame'
}

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

// A native select inside the Profile picker's box, as SelectField does in
// Settings: the mock's look, with an accessible picker for free.
function SubstitutionSelect({
  value,
  label,
  onChange
}: {
  value: TierSubstitution
  label: string
  onChange: (next: TierSubstitution) => void
}) {
  const { t } = useTranslation()
  return (
    <div className='relative ml-auto inline-flex'>
      <select
        value={value}
        aria-label={label}
        onChange={(event) => {
          const next = SUBSTITUTIONS.find((s) => s === event.target.value)
          if (next !== undefined) onChange(next)
        }}
        className='inline-flex h-8 appearance-none items-center rounded-md border border-border bg-transparent pl-2.5 pr-7.5 text-xs transition-colors hover:bg-muted/60'
      >
        {SUBSTITUTIONS.map((substitution) => (
          <option key={substitution} value={substitution}>
            {t(SUBSTITUTION_KEYS[substitution])}
          </option>
        ))}
      </select>
      <i className='ri-arrow-down-s-line pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground' />
    </div>
  )
}

// Both choices stay visible, like Routed / Passthrough in band 2 — but the
// wrapper is pinned to h-8 rather than sized by its items' padding, so it
// lines up with the select and the input in the cells beside it.
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

// Local text, so a half-typed value can exist on screen. Only a whole
// percentage reaches the profile; anything else is reported up so Save
// stays off until it is fixed. The input mounts fresh on every Edit, so
// it never has to follow a value changed underneath it.
function QuotaSkipInput({
  value,
  label,
  onChange,
  onValidity
}: {
  value: number
  label: string
  onChange: (next: number) => void
  onValidity: (valid: boolean) => void
}) {
  const [text, setText] = useState(String(value))
  const valid = parseQuotaSkipPct(text) !== null
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
          const parsed = parseQuotaSkipPct(next)
          onValidity(parsed !== null)
          if (parsed !== null) onChange(parsed)
        }}
        className='w-full min-w-0 bg-transparent text-right outline-none'
      />
      <span className='text-muted-foreground'>%</span>
    </div>
  )
}

export function ChainConstraints({
  constraints,
  editing,
  onEdit,
  onValidity
}: {
  constraints: Record<string, unknown> | null
  editing: boolean
  onEdit: (edit: ConstraintEdit) => void
  onValidity: (valid: boolean) => void
}) {
  const { t } = useTranslation()
  const substitution = tierSubstitutionOf(constraints)
  const exhausted = exhaustedBehaviorOf(constraints)
  const quotaSkip = quotaSkipPctOf(constraints)
  const substitutionLabel = t('routing.chain.tierSubstitution')
  const quotaSkipLabel = t('routing.chain.quotaSkip')
  return (
    <div className='mt-6 border-t border-border'>
      <div className='px-6 pt-4 pb-2'>
        <h2 className='text-[12px] font-semibold uppercase tracking-wider text-muted-foreground'>
          {t('routing.chain.constraints')}
        </h2>
      </div>
      <div className='grid grid-cols-3 gap-px bg-border/60'>
        <ConstraintCell label={substitutionLabel} hint={t('routing.chain.tierSubstitutionHint')}>
          {editing ? (
            <SubstitutionSelect
              value={substitution}
              label={substitutionLabel}
              onChange={(value) => onEdit({ kind: 'tierSubstitution', value })}
            />
          ) : (
            <Reading>{t(SUBSTITUTION_KEYS[substitution])}</Reading>
          )}
        </ConstraintCell>
        <ConstraintCell label={t('routing.chain.whenExhausted')} hint={t('routing.chain.whenExhaustedHint')}>
          {editing ? (
            <ExhaustedSwitch value={exhausted} onChange={(value) => onEdit({ kind: 'exhaustedBehavior', value })} />
          ) : (
            <Reading>{exhausted === 'passthrough' ? t('routing.common.modePassthrough') : '429'}</Reading>
          )}
        </ConstraintCell>
        <ConstraintCell label={quotaSkipLabel} hint={t('routing.chain.quotaSkipHint')}>
          {editing ? (
            <QuotaSkipInput
              value={quotaSkip}
              label={quotaSkipLabel}
              onChange={(value) => onEdit({ kind: 'quotaSkipPct', value })}
              onValidity={onValidity}
            />
          ) : (
            <Reading>{`${quotaSkip}%`}</Reading>
          )}
        </ConstraintCell>
      </div>
    </div>
  )
}
