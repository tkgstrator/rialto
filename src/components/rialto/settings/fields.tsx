import { SelectPicker } from '@/components/rialto/SelectPicker'
import { Switch } from '@/components/ui/switch'
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

import { cn } from 'cn'
import type { ReactNode } from 'react'
import { SettingsField } from '@/components/rialto/settings/SettingsLayout'

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
      <Switch aria-label={label} checked={value} onCheckedChange={onChange} />
    </SettingsField>
  )
}

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
      <SelectPicker
        label={label}
        value={value}
        onChange={onChange}
        className='min-w-40 font-mono'
        options={options.map((option) => ({ value: option, label: option }))}
      />
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
    // Wraps on a phone instead of squeezing: nowrap, a long meta shrank to
    // a column one word wide beside the actions. Wrapped, each part takes
    // the line it needs and the actions keep `ml-auto` on whichever line
    // they land.
    <div
      className={cn(
        'flex items-center gap-3 px-6 pb-3 max-md:flex-wrap max-md:gap-y-2 max-md:px-4',
        title === undefined ? 'pt-5' : 'border-t border-border pt-6'
      )}
    >
      {title === undefined ? null : <h2 className='text-sm font-semibold'>{title}</h2>}
      {lead}
      {meta ? <span className='text-[12px] text-muted-foreground'>{meta}</span> : null}
      {actions ? <div className='ml-auto flex items-center gap-2'>{actions}</div> : null}
    </div>
  )
}
