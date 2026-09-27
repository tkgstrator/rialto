/**
 * Rialto application shell — the navigation tree and the frame every
 * screen renders into.
 *
 * Replaces the 21-item `AppShell` navigation: the old build gave each
 * absorbed component its own top-level entry, which is why Router-related
 * settings were spread across five sibling links. The information
 * architecture here is the one the approved mocks use
 * (`mocks/_shared/shell.js`).
 *
 * The sidebar is the app's ONLY navigation. Sub-views live in it as a
 * second level rather than in a section rail (Settings) or a tab strip
 * (Routing, Activity): two vertical menus side by side spent 27rem on
 * navigation before any content began, and a horizontal strip meant the
 * same list existed in two shapes depending on which screen you were on.
 * With one tree the rule has no exceptions — sidebar navigates, the
 * content area holds nothing but content.
 *
 * Providers' children are the two auth modes, not the providers. That
 * distinction is the whole reason it has children now: the rail this
 * replaces was a list of objects with quota meters and live/invalid
 * state — data, which would have turned the menu into a dashboard — but
 * it grouped that data under two fixed headings, and those are
 * destinations like any other. Keeping the rail cost 288px beside a
 * 256px sidebar, so the screen it introduced spent 34rem on navigation
 * before any content began, which is the same arithmetic the paragraph
 * above rejects.
 */

import { cn } from 'cn'
import { useTheme } from 'next-themes'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Outlet, useLocation } from 'react-router-dom'
import { useConfig } from '@/components/ConfigProvider'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { api, type HealthResponse, type IdentityResponse } from '@/lib/api'
import { APP_VERSION } from '@/version'
import { FOOTER_ROW, IdentityRow, ServingRow } from './ShellFooter'
import { NavItem, RailTip } from './ShellNavigation'
import { NavSearch } from './ShellSearch'
import { childOf, NAV, providerListChildOf, sectionOf } from './shell-navigation'

export { childOf, sectionOf } from './shell-navigation'

/** Whether the keystroke belongs to a field the operator is editing. */
function isTyping(target: EventTarget | null): boolean {
  if (target === null || !(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/** Below this the sidebar collapses itself; see `RialtoShell`. */
const NARROW_QUERY = '(max-width: 1023px)'
const RAIL_WIDTH = 'w-14'
export function RialtoShell() {
  // No auth branch here: a 401 never reaches this component, because
  // ProtectedRoute sends it to /access-denied before the shell mounts.
  const { t } = useTranslation()
  const { config } = useConfig()
  const { resolvedTheme, setTheme } = useTheme()
  const { pathname } = useLocation()
  const [identity, setIdentity] = useState<IdentityResponse | null>(null)
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [reachable, setReachable] = useState(true)
  const [mounted, setMounted] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  /**
   * The sections standing open.
   *
   * Nothing closes on its own. Arriving in a section opens it and it stays
   * open after you leave, so walking Routing → Providers → Activity builds
   * up the tree you have been working in rather than collapsing each one
   * behind you. Only the chevron closes a section, and a closed one stays
   * closed until you open it or navigate back into it.
   */
  const [open, setOpen] = useState<readonly string[]>([])

  useEffect(() => {
    setMounted(true)
    api
      .getIdentity()
      .then(setIdentity)
      .catch(() => {
        // Display-only row; a failed probe just leaves it on the local
        // fallback rather than blocking the shell from rendering.
      })
    api
      .getHealth()
      .then((res) => {
        setHealth(res)
        setReachable(true)
      })
      .catch(() => setReachable(false))
  }, [])

  /**
   * Narrow windows start collapsed.
   *
   * Bound to the breakpoint CROSSING, not evaluated on every render: a
   * manual toggle then stands until the window actually changes class,
   * which is what keeps "I opened it on purpose" from being undone by
   * the next re-render.
   */
  useEffect(() => {
    const mql = window.matchMedia(NARROW_QUERY)
    setCollapsed(mql.matches)
    const onChange = (event: MediaQueryListEvent) => setCollapsed(event.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setSearchOpen((prev) => !prev)
      }
      // Not while the operator is typing. ⌘B/Ctrl+B is a text binding in
      // its own right (bold, and back-a-character on a Mac), and a
      // sidebar that folds mid-sentence reads as the app losing the
      // keystroke. ⌘K above is deliberately left as it was — a
      // pre-existing binding people already use from anywhere.
      if (event.key === 'b' && (event.metaKey || event.ctrlKey) && !isTyping(event.target)) {
        event.preventDefault()
        setCollapsed((prev) => !prev)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // The version the process reports, not the one compiled into this
  // bundle: after an image upgrade a cached bundle would otherwise keep
  // announcing the build it came from. Falls back to the constant until
  // /health answers, and stays there if it never does.
  const shellVersion = health === null ? APP_VERSION : health.version

  const activeSection = sectionOf(pathname)?.id
  // childOf resolves the two list pages by URL prefix; a provider's own
  // page needs its auth_mode instead (see providerListChildOf above), so
  // that path is only tried once the URL alone came up empty.
  const pathChild = childOf(pathname)
  const providers = config === null ? [] : config.Providers
  const activeChild = (pathChild === undefined ? providerListChildOf(pathname, providers) : pathChild)?.id
  const port = config?.PORT
  const themeLabel = mounted && resolvedTheme ? resolvedTheme : ''

  const isOpen = useCallback((id: string) => open.includes(id), [open])
  const toggle = useCallback(
    (id: string) => setOpen((prev) => (prev.includes(id) ? prev.filter((entry) => entry !== id) : [...prev, id])),
    []
  )

  // Arriving opens the section you arrived in, and leaving does not undo
  // it. Landing on a section whose own pages are hidden is the one state
  // worth ruling out; everything after that is the operator's call.
  useEffect(() => {
    if (activeSection === undefined) return
    setOpen((prev) => (prev.includes(activeSection) ? prev : [...prev, activeSection]))
  }, [activeSection])

  return (
    <TooltipProvider delayDuration={300}>
      {/* h-dvh, not h-screen: on mobile 100vh is the height the viewport
          would have with the browser chrome hidden, so the last row of any
          screen sits under the address bar until you scroll. */}
      <div className='safe-area-inset flex h-dvh w-full overflow-hidden bg-background text-foreground'>
        <aside
          className={cn(
            'flex shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200',
            collapsed ? RAIL_WIDTH : 'w-64'
          )}
        >
          <div
            className={cn(
              'flex h-14 items-center border-b border-sidebar-border',
              collapsed ? 'justify-center' : 'gap-2 px-4'
            )}
          >
            {collapsed ? (
              <RailTip label={t('shell.expandSidebar')} shortcut='⌘B' collapsed>
                <button
                  type='button'
                  aria-label={t('shell.expandSidebar')}
                  aria-expanded={false}
                  onClick={() => setCollapsed(false)}
                  className='group flex size-9 items-center justify-center rounded-md transition-colors hover:bg-sidebar-accent/60'
                >
                  {/* The mark doubles as the control: it swaps to the unfold
                      glyph under the pointer, so the rail keeps its identity
                      without spending one of its few rows on a button. */}
                  <span className='flex size-6 items-center justify-center rounded bg-foreground text-background group-hover:hidden'>
                    <i className='ri-route-line text-sm leading-none' />
                  </span>
                  <i className='ri-menu-unfold-line hidden text-base leading-none text-muted-foreground group-hover:block' />
                </button>
              </RailTip>
            ) : (
              <>
                <div className='flex size-6 items-center justify-center rounded bg-foreground text-background'>
                  <i className='ri-route-line text-sm leading-none' />
                </div>
                <span className='text-sm font-semibold tracking-tight'>Rialto</span>
                <span className='ml-auto font-mono text-[12px] text-muted-foreground'>v{shellVersion}</span>
                <button
                  type='button'
                  aria-label={t('shell.collapseSidebar')}
                  aria-expanded
                  onClick={() => setCollapsed(true)}
                  className='-mr-1.5 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground'
                >
                  <i className='ri-menu-fold-line text-base leading-none' />
                </button>
              </>
            )}
          </div>

          <nav className='flex flex-1 flex-col gap-0.5 overflow-y-auto p-2'>
            <div className='px-0 pb-2'>
              <RailTip label={t('shell.searchPlaceholder')} shortcut='⌘K' collapsed={collapsed}>
                <button
                  type='button'
                  onClick={() => setSearchOpen(true)}
                  aria-label={t('shell.searchPlaceholder')}
                  className={cn(
                    'flex h-9 w-full items-center rounded-md border border-sidebar-border text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent/60',
                    collapsed ? 'justify-center' : 'gap-2 px-2.5'
                  )}
                >
                  <i className='ri-search-line text-base leading-none' />
                  {collapsed ? null : (
                    <>
                      <span>{t('shell.searchPlaceholder')}</span>
                      <span className='ml-auto font-mono text-[12px] opacity-60'>⌘K</span>
                    </>
                  )}
                </button>
              </RailTip>
            </div>
            {NAV.map((item) => (
              <NavItem
                key={item.id}
                item={item}
                activeSection={activeSection}
                activeChild={activeChild}
                open={isOpen(item.id)}
                collapsed={collapsed}
                onToggle={() => toggle(item.id)}
              />
            ))}
          </nav>

          <div className='border-t border-sidebar-border p-2'>
            <ServingRow health={health} reachable={reachable} port={port} collapsed={collapsed} />
            <IdentityRow identity={identity} collapsed={collapsed} />
            <RailTip label={t('shell.theme')} shortcut={themeLabel} collapsed={collapsed}>
              <button
                type='button'
                aria-label={collapsed ? t('shell.theme') : undefined}
                onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
                className={cn(FOOTER_ROW, 'text-sidebar-foreground/70', collapsed ? 'justify-center px-0' : '')}
              >
                <i aria-hidden className='ri-contrast-2-line w-4 shrink-0 text-base leading-none opacity-80' />
                {collapsed ? null : (
                  <>
                    <span>{t('shell.theme')}</span>
                    <span className='ml-auto font-mono text-[12px] text-muted-foreground'>{themeLabel}</span>
                  </>
                )}
              </button>
            </RailTip>
          </div>
        </aside>

        <div className='flex min-w-0 flex-1 flex-col'>
          <Outlet />
        </div>
        <NavSearch open={searchOpen} onOpenChange={setSearchOpen} />
        <Toaster />
      </div>
    </TooltipProvider>
  )
}
