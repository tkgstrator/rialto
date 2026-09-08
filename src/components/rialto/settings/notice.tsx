/**
 * The two callout treatments the settings mocks use, plus the honest
 * empty state this build needs and the mocks do not.
 *
 * `NotYetAvailable` exists because several mock panels describe
 * capabilities that have no backend yet (the per-token access table, the
 * DB retention counters, the Access policy reader). Rendering them
 * against invented data would make the screen lie about what the server
 * can do, so the panel says so and names what would fill it.
 *
 * Filed under `server/` alongside `fields.tsx` for the same reason —
 * hoist both when the shared settings layout lands.
 */
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Pill } from '@/components/rialto/primitives'

/** Amber callout — a standing condition the operator should know about. */
export function WarnNotice({ title, tag, children }: { title: string; tag?: string; children: ReactNode }) {
  return (
    <div className='rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3'>
      <div className='flex items-center gap-2'>
        <i className='ri-alert-line text-sm text-amber-600 dark:text-amber-400' />
        <span className='text-xs font-medium'>{title}</span>
        {tag ? <Pill tone='warn'>{tag}</Pill> : null}
      </div>
      <p className='mt-1.5 text-[12px] leading-relaxed text-muted-foreground'>{children}</p>
    </div>
  )
}

/** Dashed callout — explanatory copy that is not itself a warning. */
export function InfoNotice({ children }: { children: ReactNode }) {
  return (
    <div className='rounded-md border border-dashed border-border px-4 py-3 text-[12px] leading-relaxed text-muted-foreground'>
      <i className='ri-information-line mr-1 align-[-1px]' />
      {children}
    </div>
  )
}

/**
 * A designed panel with no backend behind it. Deliberately conspicuous:
 * an operator must never mistake this for a real, empty list.
 */
export function NotYetAvailable({ what, needs }: { what: string; needs: ReactNode }) {
  const { t } = useTranslation()
  return (
    <div className='rounded-md border border-dashed border-border px-4 py-4'>
      <div className='flex items-center gap-2'>
        <i className='ri-tools-line text-sm text-muted-foreground' />
        <span className='text-xs font-medium'>{what}</span>
        <Pill tone='mute'>{t('settings.common.notYetAvailable')}</Pill>
      </div>
      <p className='mt-1.5 text-[12px] leading-relaxed text-muted-foreground'>{needs}</p>
    </div>
  )
}
