/**
 * The shell's navigation at phone width: a bottom tab bar, and a sheet
 * behind "More" that holds the whole tree.
 *
 * The folded 56px rail was the phone's navigation before this, and on a
 * 390px screen it cost a seventh of the width on every page while its
 * flyouts opened sideways into the content. A bottom bar costs height
 * instead, which a phone has more of, and sits where a thumb already is.
 *
 * The bar carries the four sections worth checking on the move — is it
 * serving, what are the accounts doing, who is calling, what did it cost
 * — and More carries everything, those four included, so the sheet alone
 * is a complete map and nothing is reachable only by knowing the bar.
 * Routing and Settings are configuration: the kind of change made at a
 * desk, and the phone layout draws them read-mostly anyway.
 */

import { cn } from 'cn'
import { useTheme } from 'next-themes'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { NavLink, useLocation } from 'react-router-dom'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import type { HealthResponse, IdentityResponse } from '@/lib/api'
import { FOOTER_ROW, IdentityRow, ServingRow } from './ShellFooter'
import { NAV, type NavEntry } from './shell-navigation'

const BAR_IDS: readonly string[] = ['overview', 'providers', 'activity', 'access-tokens']

/** The bar's labels get ~78px each; "Access tokens" and its Japanese
 *  spelling do not fit, so that one entry has a short form. */
const BAR_LABEL_KEYS: Record<string, string> = {
  'access-tokens': 'shell.navTokensShort'
}

const BAR_ITEM = 'flex min-w-0 flex-1 flex-col items-center gap-0.5 pt-2 pb-1.5 text-[11px] transition-colors'

export function PhoneTabBar({
  activeSection,
  activeChild,
  health,
  reachable,
  port,
  identity
}: {
  activeSection: string | undefined
  activeChild: string | undefined
  health: HealthResponse | null
  reachable: boolean
  port: number | undefined
  identity: IdentityResponse | null
}) {
  const { t } = useTranslation()
  const [moreOpen, setMoreOpen] = useState(false)
  // Every row in the sheet is a link somewhere else, so any navigation
  // ends its job. Keyed on the location's key rather than its path so a
  // tap on the page already showing closes it too; adjusted during
  // render, React's pattern for state that follows a changing input.
  const { key } = useLocation()
  const [seenKey, setSeenKey] = useState(key)
  if (seenKey !== key) {
    setSeenKey(key)
    setMoreOpen(false)
  }
  const bar = NAV.filter((item) => BAR_IDS.includes(item.id))
  const inMore = activeSection !== undefined && !BAR_IDS.includes(activeSection)

  return (
    <nav className='flex shrink-0 border-t border-border bg-background md:hidden'>
      {bar.map((item) => {
        const on = item.id === activeSection
        return (
          <NavLink
            key={item.id}
            to={item.href}
            className={cn(BAR_ITEM, on ? 'font-medium text-foreground' : 'text-muted-foreground')}
          >
            <i aria-hidden className={cn(item.icon, 'text-lg leading-none')} />
            <span className='max-w-full truncate px-1'>
              {t(BAR_LABEL_KEYS[item.id] === undefined ? item.labelKey : BAR_LABEL_KEYS[item.id])}
            </span>
          </NavLink>
        )
      })}
      <button
        type='button'
        aria-expanded={moreOpen}
        onClick={() => setMoreOpen(true)}
        className={cn(BAR_ITEM, inMore ? 'font-medium text-foreground' : 'text-muted-foreground')}
      >
        <i aria-hidden className='ri-menu-line text-lg leading-none' />
        <span>{t('shell.more')}</span>
      </button>
      <MoreSheet
        open={moreOpen}
        onOpenChange={setMoreOpen}
        activeSection={activeSection}
        activeChild={activeChild}
        health={health}
        reachable={reachable}
        port={port}
        identity={identity}
      />
    </nav>
  )
}

function MoreSheet({
  open,
  onOpenChange,
  activeSection,
  activeChild,
  health,
  reachable,
  port,
  identity
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  activeSection: string | undefined
  activeChild: string | undefined
  health: HealthResponse | null
  reachable: boolean
  port: number | undefined
  identity: IdentityResponse | null
}) {
  const { t } = useTranslation()
  const { resolvedTheme, setTheme } = useTheme()
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side='bottom' className='max-h-[85dvh] gap-0 bg-sidebar pb-[env(safe-area-inset-bottom)]'>
        <SheetTitle className='px-4 pt-4 pb-2 text-sm'>Rialto</SheetTitle>
        <SheetDescription className='sr-only'>{t('shell.moreDescription')}</SheetDescription>
        <div className='flex flex-col overflow-y-auto px-2 pb-2'>
          {NAV.map((item) => (
            <MoreSection key={item.id} item={item} activeSection={activeSection} activeChild={activeChild} />
          ))}
          <div className='mt-2 border-t border-sidebar-border pt-2'>
            <ServingRow health={health} reachable={reachable} port={port} collapsed={false} />
            <IdentityRow identity={identity} collapsed={false} />
            <button
              type='button'
              onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
              className={cn(FOOTER_ROW, 'text-sidebar-foreground/70')}
            >
              <i aria-hidden className='ri-contrast-2-line w-4 shrink-0 text-base leading-none opacity-80' />
              <span>{t('shell.theme')}</span>
              <span className='ml-auto font-mono text-[12px] text-muted-foreground'>{resolvedTheme}</span>
            </button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

/** A section and its pages as one block: the section on its own row, its
 *  pages as chips beneath, so the sheet stays short enough to take in at
 *  a glance rather than scrolling a second copy of the sidebar tree. */
function MoreSection({
  item,
  activeSection,
  activeChild
}: {
  item: NavEntry
  activeSection: string | undefined
  activeChild: string | undefined
}) {
  const { t } = useTranslation()
  const on = item.id === activeSection
  return (
    <div className='py-1'>
      <NavLink
        to={item.href}
        className={cn(
          'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm',
          on ? 'font-medium text-sidebar-accent-foreground' : 'text-sidebar-foreground/80'
        )}
      >
        <i aria-hidden className={cn(item.icon, 'text-base leading-none opacity-80')} />
        <span>{t(item.labelKey)}</span>
      </NavLink>
      {item.children.length === 0 ? null : (
        <div className='flex flex-wrap gap-1.5 pb-1 pl-9'>
          {item.children.map((child) => (
            <NavLink
              key={child.id}
              to={child.href}
              className={cn(
                'rounded-md border px-2.5 py-1 text-xs',
                on && child.id === activeChild
                  ? 'border-foreground/40 bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                  : 'border-sidebar-border text-sidebar-foreground/70'
              )}
            >
              {t(child.labelKey)}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  )
}
