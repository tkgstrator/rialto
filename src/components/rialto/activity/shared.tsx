/**
 * Presentational pieces shared by the four Activity views.
 *
 * Class lists are copied from `mocks/activity*.html` verbatim so the
 * pixel-diff harness measures design differences, not markup drift.
 */

import { cn } from 'cn'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Mono, Pill, SurfacePill } from '@/components/rialto/primitives'
import { SelectPicker } from '@/components/rialto/SelectPicker'

/** Rendered wherever a column has no value for this row. */
export const DASH = '—'

export interface FilterOption<T extends string> {
  id: T
  label: string
}

export function FilterSelect<T extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: T
  options: readonly FilterOption<T>[]
  onChange: (next: T) => void
}) {
  const { t } = useTranslation()
  const current = options.find((o) => o.id === value)
  return (
    <SelectPicker
      label={label}
      value={value}
      options={options.map((option) => ({ value: option.id, label: option.label }))}
      onChange={(next) => {
        const option = options.find(({ id }) => id === next)
        if (option !== undefined) onChange(option.id)
      }}
      reading={
        <>
          <span className='text-muted-foreground'>{label}</span>
          <span>{current === undefined ? t('activity.common.all') : current.label}</span>
        </>
      }
    />
  )
}

/** Headline number above the tables. `size` follows the two mocks that use it. */
export function StatTile({
  label,
  value,
  sub,
  size = 'lg'
}: {
  label: string
  value: ReactNode
  sub: string
  size?: 'lg' | 'base'
}) {
  return (
    <div className='border-l-2 border-l-border px-4 py-3 transition-colors hover:border-l-foreground/30 hover:bg-muted/50'>
      <div className='text-[12px] uppercase tracking-wider text-muted-foreground'>{label}</div>
      <div className={cn('mt-1 font-mono tabular-nums', size === 'lg' ? 'text-lg' : 'text-base')}>{value}</div>
      <div className='text-[12px] text-muted-foreground'>{sub}</div>
    </div>
  )
}

/**
 * A 429 is a failover step, not an error the caller saw, so it is warned
 * rather than damned.
 */
export function StatusPill({ status }: { status: number }) {
  if (status === 429) return <Pill tone='warn'>429</Pill>
  if (status >= 200 && status < 300) return <Pill tone='ok'>{status}</Pill>
  return <Pill tone='bad'>{status}</Pill>
}

/** Endpoint cell. A row with no surface recorded says so instead of guessing one. */
export function SurfaceCell({ path }: { path: string | null }) {
  const { t } = useTranslation()
  return path === null ? <Mono>{t('activity.common.untracked')}</Mono> : <SurfacePill path={path} />
}

/** The dashed explanatory block the mocks close their tables with. */
export function NoteBox({ children }: { children: ReactNode }) {
  return (
    <div className='rounded-md border border-dashed border-border px-4 py-3 text-[12px] leading-relaxed text-muted-foreground'>
      <i className='ri-information-line mr-1 align-[-1px]' />
      {children}
    </div>
  )
}

/** Loading / empty / error copy, in the one place a screen body can be empty. */
export function ScreenMessage({ tone = 'mute', children }: { tone?: 'mute' | 'bad'; children: ReactNode }) {
  return (
    <div className={cn('px-6 py-6 text-xs', tone === 'bad' ? 'text-destructive' : 'text-muted-foreground')}>
      {children}
    </div>
  )
}
