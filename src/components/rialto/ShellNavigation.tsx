import { cn } from 'cn'
import {
  type ReactElement,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'
import { NavLink } from 'react-router-dom'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { NavChild, NavEntry } from './shell-navigation'

const RAIL_ITEM = 'flex h-9 items-center justify-center rounded-md transition-colors'
/**
 * The label a collapsed row cannot show, restored on hover.
 *
 * A pass-through while the sidebar is open: the label is right there, and
 * a tooltip repeating it just flickers under the pointer as you travel
 * down the tree.
 */
export function RailTip({
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
          {/* aria-hidden: Chromium folds a Remix Icon's ::before glyph (a
              private-use codepoint) into the link's accessible name, so
              getByRole('link', { name: … }) matched nothing and a screen
              reader announced a junk character ahead of the label. */}
          <i aria-hidden className={cn(item.icon, 'text-base leading-none opacity-80')} />
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

export function NavItem({
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
          {/* aria-hidden — see the note on the popover copy of this link
              above; this is the same link at full width. */}
          <i aria-hidden className={cn(item.icon, 'text-base leading-none opacity-80')} />
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
