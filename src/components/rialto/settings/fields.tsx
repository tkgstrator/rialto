/**
 * The controls that go in a settings row's right-hand column.
 *
 * The labelled row itself is `SettingsField` from `SettingsLayout`;
 * these wrap it with the control, sized to the boxes the mock's `field()`
 * helper draws so the pixel-diff measures behaviour rather than markup
 * drift. The one intentional divergence: the mock renders static `div`s
 * and these render real inputs with the same metrics.
 *
 * `SectionHead` is here because `SettingsLayout` renders only the first
 * heading of a pane; every section after it (Data, Update, Retention, …)
 * still needs the same strip.
 */
import type { ReactNode } from 'react'
import { SettingsField } from '@/components/rialto/settings/SettingsLayout'
import { cn } from '@/lib/utils'

/** Shared box metrics for a text input and its read-only twin. */
const BOX = 'flex h-8 max-w-md items-center rounded-md border border-border px-3 font-mono text-xs'

/** A value the server reports but the UI cannot change. */
export function StaticField({ label, hint, value }: { label: string; hint?: string; value: ReactNode }) {
  return (
    <SettingsField label={label} hint={hint}>
      <div className={BOX}>{value}</div>
    </SettingsField>
  )
}

export function TextField({
  label,
  hint,
  value,
  onChange,
  placeholder,
  inputMode
}: {
  label: string
  hint?: string
  value: string
  onChange: (next: string) => void
  placeholder?: string
  inputMode?: 'numeric' | 'text'
}) {
  return (
    <SettingsField label={label} hint={hint}>
      <input
        type='text'
        inputMode={inputMode}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={cn(BOX, 'w-full bg-transparent outline-none focus:border-foreground/40')}
      />
    </SettingsField>
  )
}

/**
 * The pill toggle from the mock. A `button` rather than the mock's
 * `span` — same box, same knob offset — so it is reachable by keyboard.
 */
export function ToggleField({
  label,
  hint,
  value,
  onChange
}: {
  label: string
  hint?: string
  value: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <SettingsField label={label} hint={hint}>
      <button
        type='button'
        role='switch'
        aria-checked={value}
        aria-label={label}
        onClick={() => onChange(!value)}
        className={cn(
          'inline-flex h-5 w-9 items-center rounded-full px-0.5 align-middle transition-colors',
          value ? 'bg-foreground' : 'bg-muted-foreground/30'
        )}
      >
        <span className={cn('size-4 rounded-full bg-background transition-transform', value ? 'translate-x-4' : '')} />
      </button>
    </SettingsField>
  )
}

/**
 * The mock draws a bordered button with a trailing chevron. A native
 * `select` with `appearance-none` keeps that box exactly while giving
 * the real thing an accessible, zero-dependency picker.
 */
export function SelectField({
  label,
  hint,
  value,
  options,
  onChange
}: {
  label: string
  hint?: string
  value: string
  options: readonly string[]
  onChange: (next: string) => void
}) {
  return (
    <SettingsField label={label} hint={hint}>
      <div className='relative inline-flex'>
        <select
          value={value}
          aria-label={label}
          onChange={(e) => onChange(e.target.value)}
          className='inline-flex h-8 min-w-40 appearance-none items-center rounded-md border border-border bg-transparent pl-3 pr-8 font-mono text-xs transition-colors hover:bg-muted/60'
        >
          {options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
        <i className='ri-arrow-down-s-line pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground' />
      </div>
    </SettingsField>
  )
}

/** Heading strip for the second and later sections of a pane. */
export function SectionHead({
  title,
  lead,
  meta,
  actions
}: {
  /**
   * Absent on a screen whose breadcrumb already carries the name — a
   * title repeating it costs a line and a rule for nothing. The row
   * still draws, because the meta and the actions live in it.
   */
  title?: string
  /** Sits between the title and the meta text — a status pill, in practice. */
  lead?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div
      className={cn('flex items-center gap-3 px-6 pb-3', title === undefined ? 'pt-5' : 'border-t border-border pt-6')}
    >
      {title === undefined ? null : <h2 className='text-sm font-semibold'>{title}</h2>}
      {lead}
      {meta ? <span className='text-[12px] text-muted-foreground'>{meta}</span> : null}
      {actions ? <div className='ml-auto flex items-center gap-2'>{actions}</div> : null}
    </div>
  )
}
