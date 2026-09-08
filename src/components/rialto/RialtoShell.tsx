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
import { useTheme } from 'next-themes'
import {
  type ReactElement,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useConfig } from '@/components/ConfigProvider'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Toaster } from '@/components/ui/sonner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { api, type HealthResponse, type IdentityResponse } from '@/lib/api'
import { cn } from '@/lib/utils'
import { APP_VERSION } from '@/version'

/** A destination. Sub-entries are leaves, which is why they are a type of
 *  their own rather than a NavEntry with an empty list to carry around. */
interface NavChild {
  id: string
  labelKey: string
  icon: string
  href: string
}

interface NavEntry extends NavChild {
  children: readonly NavChild[]
}

/**
 * Sub-entries carry no counts on purpose. A menu answers "where can I go",
 * not "how much is in there", and those numbers move on every request — a
 * sidebar carrying them ticks in the corner of the eye while you read
 * something else. The screens still show them where the data is.
 */
const NAV: readonly NavEntry[] = [
  { id: 'overview', labelKey: 'shell.navOverview', icon: 'ri-dashboard-3-line', href: '/overview', children: [] },
  // Routing has no children: the chain IS the screen, and it is the only
  // selector.
  { id: 'routing', labelKey: 'shell.navRouting', icon: 'ri-git-branch-line', href: '/routing', children: [] },
  // Neither child is href '/providers' — the section root redirects to
  // the first instead. Activity and Settings can let their first child
  // hold the section's own path because `childOf` matches by prefix and
  // every deeper route of theirs belongs to that child. Here it does
  // not: `/providers/openai` is an api_key provider, and a Subscriptions
  // child at '/providers' would light up on it.
  {
    id: 'providers',
    labelKey: 'shell.navProviders',
    icon: 'ri-plug-line',
    href: '/providers',
    children: [
      {
        id: 'subscriptions',
        labelKey: 'providers.rail.subscriptions',
        icon: 'ri-shield-user-line',
        href: '/providers/subscriptions'
      },
      { id: 'api-keys', labelKey: 'providers.rail.apiKeys', icon: 'ri-key-line', href: '/providers/api-keys' }
    ]
  },
  // Next to Providers because it is the same question pointed the other
  // way: Providers is outbound (who Rialto sends to), this is inbound
  // (who may send to Rialto). It lived under Settings, where a list
  // carrying per-token spend, rotation and revocation does not belong —
  // that is operations, not configuration. Settings → Access keeps the
  // half that really is configuration: who may administer the install.
  {
    id: 'access-tokens',
    labelKey: 'shell.navAccessTokens',
    icon: 'ri-key-2-line',
    href: '/access-tokens',
    children: []
  },
  {
    id: 'activity',
    labelKey: 'shell.navActivity',
    icon: 'ri-pulse-line',
    href: '/activity',
    children: [
      { id: 'sessions', labelKey: 'activity.common.tabSessions', icon: 'ri-chat-1-line', href: '/activity' },
      { id: 'requests', labelKey: 'activity.common.tabRequests', icon: 'ri-exchange-line', href: '/activity/requests' },
      { id: 'usage', labelKey: 'activity.common.tabUsage', icon: 'ri-battery-2-line', href: '/activity/usage' },
      { id: 'logs', labelKey: 'activity.common.tabLogs', icon: 'ri-file-list-2-line', href: '/activity/logs' }
    ]
  },
  {
    id: 'settings',
    labelKey: 'shell.navSettings',
    icon: 'ri-settings-3-line',
    href: '/settings',
    children: [
      { id: 'server', labelKey: 'settings.rail.server', icon: 'ri-server-line', href: '/settings' },
      { id: 'access', labelKey: 'settings.rail.access', icon: 'ri-key-2-line', href: '/settings/access' },
      { id: 'logging', labelKey: 'settings.rail.logging', icon: 'ri-file-list-2-line', href: '/settings/logging' },
      { id: 'personas', labelKey: 'settings.rail.personas', icon: 'ri-user-voice-line', href: '/settings/personas' },
      {
        id: 'statusline',
        labelKey: 'settings.rail.statusline',
        icon: 'ri-layout-bottom-line',
        href: '/settings/statusline'
      },
      { id: 'advanced', labelKey: 'settings.rail.advanced', icon: 'ri-terminal-box-line', href: '/settings/advanced' }
    ]
  }
]

/** Which top-level section a path belongs to. */
export function sectionOf(pathname: string): NavEntry | undefined {
  return NAV.find((entry) => pathname === entry.href || pathname.startsWith(`${entry.href}/`))
}

/**
 * The deepest child a path matches. Longest href first so `/routing/map`
 * does not resolve to `/routing`, which every routing path starts with.
 */
export function childOf(pathname: string): NavChild | undefined {
  const section = sectionOf(pathname)
  if (section === undefined) return undefined
  return [...section.children]
    .sort((a, b) => b.href.length - a.href.length)
    .find((child) => pathname === child.href || pathname.startsWith(`${child.href}/`))
}

/**
 * Collapsed-sidebar geometry.
 *
 * `w-14` is the smallest width that still centres a 16px icon inside the
 * same 36px hit target the expanded rows use, so collapsing changes what
 * a row says and not how big it is.
 */
const RAIL_WIDTH = 'w-14'
const RAIL_ITEM = 'flex h-9 items-center justify-center rounded-md transition-colors'

/** Whether the keystroke belongs to a field the operator is editing. */
function isTyping(target: EventTarget | null): boolean {
  if (target === null || !(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/** Below this the sidebar collapses itself; see `RialtoShell`. */
const NARROW_QUERY = '(max-width: 1023px)'

/**
 * The label a collapsed row cannot show, restored on hover.
 *
 * A pass-through while the sidebar is open: the label is right there, and
 * a tooltip repeating it just flickers under the pointer as you travel
 * down the tree.
 */
function RailTip({
  label,
  shortcut,
  collapsed,
  children
}: {
  label: string
  shortcut?: string
  collapsed: boolean
  children: ReactElement
}) {
  if (!collapsed) return children
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side='right' className='flex items-center gap-2'>
        <span>{label}</span>
        {shortcut === undefined ? null : <span className='font-mono text-[12px] opacity-60'>{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  )
}

function SubNavItem({
  item,
  active,
  onNavigate
}: {
  item: NavChild
  active: boolean
  // Set when the row lives in a rail flyout: Radix closes on an outside
  // click, and a click on a row inside the panel is not one.
  onNavigate?: () => void
}) {
  const { t } = useTranslation()
  return (
    <NavLink
      to={item.href}
      onClick={onNavigate}
      className={cn(
        // Same 14px as the parent: the level is carried by the indent and
        // by weight when active. Shrinking the type as well says "less
        // important" about the row you are actually on.
        'flex items-center gap-2 rounded-md py-1.5 pr-2.5 pl-[9px] text-sm transition-colors',
        active
          ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
          : 'text-sidebar-foreground/60 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground'
      )}
    >
      <span>{t(item.labelKey)}</span>
    </NavLink>
  )
}

/**
 * A section's second level while the sidebar is folded.
 *
 * Folding must not delete destinations. Below NARROW_QUERY the sidebar
 * folds ITSELF, so on a phone Activity's four views and Settings' six
 * sections were reachable only through the command palette — a keyboard
 * affordance on the one class of device with no keyboard — and the tab
 * strips that used to carry them are gone. The panel holds the same rows
 * the expanded tree draws, on the sidebar's own surface, so the rail
 * reads as the sidebar folded rather than as a second menu.
 *
 * The section takes the first row: once the icon has to open the panel,
 * it can no longer also be the way into the section itself.
 */
function RailSection({
  item,
  isActive,
  activeChild
}: {
  item: NavEntry
  isActive: boolean
  activeChild: string | undefined
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Only a keyboard open moves focus into the panel. Hovering down the
  // rail would otherwise drag the focus ring across every section.
  const byKeyboard = useRef(false)

  const cancelClose = useCallback(() => {
    if (closeTimer.current === null) return
    clearTimeout(closeTimer.current)
    closeTimer.current = null
  }, [])

  // The sideOffset gap is dead space the pointer has to cross on its way
  // into the panel; closing on the first pointerleave shuts it in transit.
  const scheduleClose = useCallback(() => {
    cancelClose()
    closeTimer.current = setTimeout(() => setOpen(false), 140)
  }, [cancelClose])

  useEffect(() => cancelClose, [cancelClose])

  // Touch has no hover: a tap arrives as the trigger's own click, and
  // acting on the synthesised pointerenter as well would open the panel
  // and let the click toggle it straight back shut.
  const hover = {
    onPointerEnter: (event: ReactPointerEvent) => {
      if (event.pointerType === 'touch') return
      cancelClose()
      byKeyboard.current = false
      setOpen(true)
    },
    onPointerLeave: (event: ReactPointerEvent) => {
      if (event.pointerType === 'touch') return
      scheduleClose()
    }
  }
  const close = useCallback(() => setOpen(false), [])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          // The panel names the section, so the trigger carries the name
          // for assistive tech instead of a tooltip that would fight the
          // panel for the same hover.
          aria-label={t(item.labelKey)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') byKeyboard.current = true
          }}
          onClick={(event) => {
            // Radix's trigger toggles. With hover having already opened the
            // panel, a click would therefore close it — the menu flinching
            // away from the pointer that came to use it. preventDefault
            // stops Radix's own handler (composeEventHandlers honours it)
            // and leaves opening to the one line below, which is also the
            // path a tap takes, since touch never fires the hover open.
            event.preventDefault()
            cancelClose()
            setOpen(true)
          }}
          className={cn(
            RAIL_ITEM,
            'relative w-full',
            isActive
              ? 'bg-sidebar-accent text-sidebar-accent-foreground'
              : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground'
          )}
          {...hover}
        >
          <i className={cn(item.icon, 'text-base leading-none opacity-80')} />
          {/* Without the mark the rail reads as five destinations, and the
              pages under a section read as deleted rather than folded. */}
          <i className='absolute right-0 ri-arrow-right-s-line text-[10px] leading-none text-muted-foreground/70' />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side='right'
        align='start'
        sideOffset={4}
        onOpenAutoFocus={(event) => {
          if (!byKeyboard.current) event.preventDefault()
        }}
        className='w-52 gap-0.5 border border-sidebar-border bg-sidebar p-1'
        {...hover}
      >
        <NavLink
          to={item.href}
          onClick={close}
          className='flex items-center gap-2.5 rounded-md px-2.5 py-1.5 font-medium text-sm transition-colors hover:bg-sidebar-accent/60'
        >
          <i className={cn(item.icon, 'text-base leading-none opacity-80')} />
          <span>{t(item.labelKey)}</span>
        </NavLink>
        <div className='my-1 border-sidebar-border border-t' />
        {item.children.map((child) => (
          <SubNavItem key={child.id} item={child} active={isActive && child.id === activeChild} onNavigate={close} />
        ))}
      </PopoverContent>
    </Popover>
  )
}

function NavItem({
  item,
  activeSection,
  activeChild,
  open,
  collapsed,
  onToggle
}: {
  item: NavEntry
  activeSection: string | undefined
  activeChild: string | undefined
  open: boolean
  collapsed: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation()
  const isActive = item.id === activeSection

  // Folded, a section with a second level opens it beside the rail; one
  // without is still just a link with its label moved into a tooltip.
  if (collapsed) {
    if (item.children.length > 0) {
      return <RailSection item={item} isActive={isActive} activeChild={activeChild} />
    }
    return (
      <RailTip label={t(item.labelKey)} collapsed>
        <NavLink
          to={item.href}
          // The tooltip is a description, not a name: with the label gone
          // the row would otherwise reach assistive tech (and any test
          // that queries by role) as an unnamed link.
          aria-label={t(item.labelKey)}
          className={cn(
            RAIL_ITEM,
            isActive
              ? 'bg-sidebar-accent text-sidebar-accent-foreground'
              : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground'
          )}
        >
          <i className={cn(item.icon, 'text-base leading-none opacity-80')} />
        </NavLink>
      </RailTip>
    )
  }

  return (
    <>
      <div className='relative'>
        <NavLink
          to={item.href}
          className={cn(
            'flex items-center gap-2.5 rounded-md py-1.5 pr-2.5 pl-2.5 text-sm transition-colors',
            item.children.length > 0 ? 'pr-8' : '',
            isActive
              ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
              : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground'
          )}
        >
          <i className={cn(item.icon, 'text-base leading-none opacity-80')} />
          <span>{t(item.labelKey)}</span>
        </NavLink>
        {item.children.length > 0 ? (
          // A separate control, not part of the link: expanding a section
          // to look at it is a different intent from going to it, and
          // Cloudflare's sidebar lets several groups stand open at once.
          <button
            type='button'
            aria-label={t(open ? 'shell.collapseSection' : 'shell.expandSection', { section: t(item.labelKey) })}
            aria-expanded={open}
            onClick={onToggle}
            className='absolute inset-y-0 right-0 flex w-8 items-center justify-center text-muted-foreground transition-colors hover:text-foreground'
          >
            <i className={cn(open ? 'ri-arrow-down-s-line' : 'ri-arrow-right-s-line', 'text-sm leading-none')} />
          </button>
        ) : null}
      </div>
      {item.children.length > 0 && open ? (
        // The guide sits at 18px — dead centre of the parent's icon — and
        // the 8px after it keeps the row backgrounds off the line, which
        // otherwise reads as one thick rule with a bite taken out of it.
        <div className='ml-[18px] flex flex-col gap-0.5 border-l border-sidebar-border pl-2'>
          {item.children.map((child) => (
            <SubNavItem key={child.id} item={child} active={isActive && child.id === activeChild} />
          ))}
        </div>
      ) : null}
    </>
  )
}

/**
 * Command palette over every destination in the tree.
 *
 * Once all the sub-views are rows in one menu the menu is long enough that
 * typing beats hunting — it is the same affordance that keeps Cloudflare's
 * own deep sidebar usable, and the reason the search box earns the slot
 * above the tree.
 */
function NavSearch({ open, onOpenChange }: { open: boolean; onOpenChange: (next: boolean) => void }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const go = useCallback(
    (href: string) => {
      onOpenChange(false)
      navigate(href)
    },
    [navigate, onOpenChange]
  )
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title={t('shell.search')}>
      <CommandInput placeholder={t('shell.searchPlaceholder')} />
      <CommandList>
        <CommandEmpty>{t('shell.searchEmpty')}</CommandEmpty>
        {NAV.map((section) => (
          <CommandGroup key={section.id} heading={t(section.labelKey)}>
            <CommandItem value={t(section.labelKey)} onSelect={() => go(section.href)}>
              <i className={cn(section.icon, 'text-base leading-none opacity-80')} />
              {t(section.labelKey)}
            </CommandItem>
            {section.children.map((child) => (
              <CommandItem
                key={child.id}
                // The section name is in the value so "activity logs"
                // finds the child the way the breadcrumb reads it.
                value={`${t(section.labelKey)} ${t(child.labelKey)}`}
                onSelect={() => go(child.href)}
              >
                <i className={cn(child.icon, 'text-base leading-none opacity-80')} />
                {t(child.labelKey)}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  )
}

/**
 * Sidebar footer identity row.
 *
 * Display only. It reports who the edge said is calling; it never gates
 * anything. The access decision itself belongs at the edge (Cloudflare
 * Access) and in the API-key middleware, never in a rendered string.
 */
function IdentityRow({ identity, collapsed }: { identity: IdentityResponse | null; collapsed: boolean }) {
  const { t } = useTranslation()
  const mode = identity === null ? null : identity.mode
  // A local request presents no credential, so labelling it 'token' said
  // one had been checked when none was.
  const icon =
    mode === 'cloudflare_access'
      ? 'ri-shield-check-line text-emerald-500'
      : mode === 'local'
        ? 'ri-computer-line text-muted-foreground'
        : 'ri-key-2-line text-muted-foreground'
  const label = t(
    mode === 'cloudflare_access'
      ? 'shell.identityAccess'
      : mode === 'local'
        ? 'shell.identityLocal'
        : 'shell.identityToken'
  )
  const who = identity?.email ? identity.email : t('settings.access.viaThisMachine')
  return (
    <RailTip label={who} shortcut={label} collapsed={collapsed}>
      <NavLink
        to='/settings/access'
        aria-label={collapsed ? `${who} · ${label}` : undefined}
        className={cn(FOOTER_ROW, collapsed ? 'justify-center px-0' : '')}
      >
        <i className={cn('w-4 shrink-0 text-base leading-none', icon)} />
        {collapsed ? null : (
          <>
            <span className='truncate text-sidebar-foreground/70'>{who}</span>
            <span className='ml-auto shrink-0 font-mono text-[12px] text-muted-foreground'>{label}</span>
          </>
        )}
      </NavLink>
    </RailTip>
  )
}

/**
 * The three footer rows share the nav's row geometry — 16px icon slot,
 * gap-2.5, px-2.5 py-1.5, 14px label. They had grown three different
 * indents (a 6px dot, a 14px icon and a 16px icon, with two gaps), so
 * their labels started at 24 / 34 / 36px while the nav above started at 44.
 */
const FOOTER_ROW =
  'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors hover:bg-sidebar-accent/60'

/**
 * Sidebar serving indicator.
 *
 * The dot reports what /api/health actually said. A degraded server
 * (reachable, but a dependency check failed) is the case worth catching
 * early, and a permanently-green dot would hide exactly that.
 */
function ServingRow({
  health,
  reachable,
  port,
  collapsed
}: {
  health: HealthResponse | null
  reachable: boolean
  port: number | undefined
  collapsed: boolean
}) {
  const { t } = useTranslation()
  const state = !reachable ? 'down' : health === null ? 'unknown' : health.status === 'ok' ? 'ok' : 'degraded'
  const dot = {
    ok: 'bg-emerald-500',
    degraded: 'bg-amber-500',
    down: 'bg-destructive',
    unknown: 'bg-muted-foreground/40'
  }[state]
  const label = t(
    {
      ok: 'shell.serving',
      degraded: 'shell.degraded',
      down: 'shell.unreachable',
      unknown: 'shell.serving'
    }[state]
  )
  const portLabel = port ? `:${port}` : '—'
  return (
    // Collapsed, the dot IS the row — it is the one footer value that
    // still reads at 16px, which is why the rail keeps this row at all.
    <RailTip label={label} shortcut={portLabel} collapsed={collapsed}>
      <NavLink
        to='/settings/advanced?tab=health'
        aria-label={collapsed ? `${label} ${portLabel}` : undefined}
        className={cn(FOOTER_ROW, collapsed ? 'justify-center px-0' : '')}
      >
        {/* The dot keeps its 6px but sits centred in the same 16px slot the
            icons use — the only way a dot and a glyph share a column. */}
        <span className='flex w-4 shrink-0 items-center justify-center'>
          <span className={cn('size-1.5 rounded-full', dot)} />
        </span>
        {collapsed ? null : (
          <>
            <span className='text-sidebar-foreground/70'>{label}</span>
            <span className='ml-auto font-mono text-[12px] text-muted-foreground'>{portLabel}</span>
          </>
        )}
      </NavLink>
    </RailTip>
  )
}

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
  const activeChild = childOf(pathname)?.id
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
                <i className='ri-contrast-2-line w-4 shrink-0 text-base leading-none opacity-80' />
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
