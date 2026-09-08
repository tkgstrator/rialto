/**
 * Settings frame: the pane its sections render into.
 *
 * SettingsPage / Presets / Personas / StatusLine / Debug were five
 * separate top-level nav entries. They all answer "configure this
 * installation", so they collapse into one screen.
 *
 * The 13rem section rail that used to sit here is gone: it was a second
 * vertical menu beside the sidebar's, so Settings spent 27rem on
 * navigation before the first field. The sections live in the sidebar
 * tree now, and the pane gets the width back. `active` stays because the
 * heading is still drawn from it.
 */
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Screen } from '@/components/rialto/Screen'

/** Section headings, keyed the same way the sidebar names them. */
const SECTION_LABEL_KEYS: Readonly<Record<string, string>> = {
  server: 'settings.rail.server',
  access: 'settings.rail.access',
  logging: 'settings.rail.logging',
  personas: 'settings.rail.personas',
  statusline: 'settings.rail.statusline',
  advanced: 'settings.rail.advanced'
}

export function SettingsLayout({
  active,
  heading,
  subtitle,
  actions,
  headerNote,
  headerBadge,
  headerActions,
  showHeading = true,
  children
}: {
  active: string
  subtitle?: ReactNode
  /** Actions for the app-level title bar. */
  actions?: ReactNode
  /**
   * What the first block on this screen is about, when that is not the
   * screen's own name. The rail already says which screen you are on, so
   * repeating it as the first heading spends a line saying "Access /
   * Access"; the mocks name the block instead — "Admin access" over the
   * credentials, "Server log" over the pino settings.
   */
  heading?: string
  /** The one-line explanation beside the section heading. */
  headerNote?: ReactNode
  /** Status pill beside the section heading (Access shows one). */
  headerBadge?: ReactNode
  /** Actions for the section heading row (Restart, Save, …). */
  headerActions?: ReactNode
  /**
   * Sections whose own first element is a tab strip (Advanced) open
   * straight into it — a heading above the strip is not in the design
   * and would push everything below it out of alignment with the rest.
   */
  showHeading?: boolean
  children: ReactNode
}) {
  const { t } = useTranslation()
  const labelKey = SECTION_LABEL_KEYS[active]
  const title = heading === undefined ? (labelKey === undefined ? '' : t(labelKey)) : heading
  return (
    <Screen subtitle={subtitle} actions={actions}>
      <div className='min-w-0'>
        {showHeading ? (
          <div className='flex items-center gap-3 px-6 pt-6 pb-3'>
            <h2 className='text-sm font-semibold'>{title}</h2>
            {headerBadge}
            {headerNote ? <span className='text-[12px] text-muted-foreground'>{headerNote}</span> : null}
            {headerActions ? <div className='ml-auto'>{headerActions}</div> : null}
          </div>
        ) : null}
        {children}
      </div>
    </Screen>
  )
}

/**
 * One labelled row of the settings form: a fixed-width label column with
 * its hint, and the control. Fixed so controls line up down the pane
 * regardless of how long each label is.
 */
export function SettingsField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className='grid grid-cols-[14rem_1fr] items-start gap-6 border-t border-border/60 px-6 py-4'>
      <div>
        <div className='text-xs font-medium'>{label}</div>
        {hint ? <div className='mt-0.5 text-[12px] leading-snug text-muted-foreground'>{hint}</div> : null}
      </div>
      <div>{children}</div>
    </div>
  )
}
