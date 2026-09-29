/**
 * Page frame inside the Rialto shell: the sticky breadcrumb bar plus the
 * one scrolling region beneath it.
 *
 * The shell owns the sidebar and the flex column; each screen owns its own
 * header content, so the subtitle/actions travel with the page component
 * instead of through a context the router has to keep in sync.
 *
 * The trail is DERIVED from the route, not passed. Every screen but
 * Overview sits under one of the five sections and three of them nest a
 * level further, which a bare title could not say: "Access", "Requests"
 * and "Presets" all read as top-level screens when they are not, and the
 * titles had already drifted into naming different depths on neighbouring
 * screens ("Activity" on one, "Logs" on the next). Deriving it also means
 * the trail and the highlighted sidebar row cannot disagree.
 *
 * A page passes `crumbs` only for what the route cannot name on its own —
 * a provider, a session id.
 *
 * `hideChildCrumb` drops the derived child from the trail. Providers' two
 * lists are the case: the sidebar's own sub-entry (Subscriptions / API
 * keys) already says which list this is, so the header repeating it as
 * "Providers / Subscriptions" said the same thing twice — the mocks (
 * `providers.html`, `providers-keys.html`) call `renderShell` with
 * `crumbs: []` for exactly this reason. Defaults to false so every other
 * screen keeps deriving section + child the way it always has.
 */
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation } from 'react-router-dom'
import { Tabs } from '@/components/rialto/primitives'
import { childOf, type NavEntry, sectionOf } from '@/components/rialto/shell-navigation'
import { usePhone } from '@/hooks/use-phone'

export interface Crumb {
  label: ReactNode
  href?: string
}

export function Screen({
  crumbs = [],
  hideChildCrumb = false,
  subtitle,
  actions,
  children
}: {
  crumbs?: readonly Crumb[]
  hideChildCrumb?: boolean
  subtitle?: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const section = sectionOf(pathname)
  const child = childOf(pathname)
  const phone = usePhone()
  const trail: Crumb[] = [
    ...(section === undefined ? [] : [{ label: t(section.labelKey), href: section.href }]),
    ...(child === undefined || hideChildCrumb ? [] : [{ label: t(child.labelKey), href: child.href }]),
    ...crumbs
  ]
  if (phone) {
    return (
      <PhoneScreen trail={trail} deep={crumbs.length > 0} section={section} subtitle={subtitle} actions={actions}>
        {children}
      </PhoneScreen>
    )
  }
  return (
    <>
      <header className='flex h-14 shrink-0 items-center gap-4 border-b border-border px-6'>
        <div className='min-w-0'>
          <h1 className='truncate text-sm font-semibold tracking-tight'>
            {trail.map((crumb, i) => {
              const last = i === trail.length - 1
              return (
                // Index keys: the trail is positional and short-lived, and
                // a crumb's label is not unique (two "Sessions" can appear
                // at different depths).
                // biome-ignore lint/suspicious/noArrayIndexKey: positional by nature
                <span key={i}>
                  {i === 0 ? null : <span className='px-1.5 font-normal text-muted-foreground/40'>/</span>}
                  {last || crumb.href === undefined ? (
                    crumb.label
                  ) : (
                    <Link
                      to={crumb.href}
                      className='font-normal text-muted-foreground transition-colors hover:text-foreground'
                    >
                      {crumb.label}
                    </Link>
                  )}
                </span>
              )
            })}
          </h1>
          {subtitle ? <p className='truncate text-xs text-muted-foreground'>{subtitle}</p> : null}
        </div>
        <div className='ml-auto flex items-center gap-2'>{actions}</div>
      </header>
      <main className='min-h-0 flex-1 overflow-y-auto'>{children}</main>
    </>
  )
}

/**
 * The same frame at phone width.
 *
 * A trail does not fit: "Providers / Subscriptions / Claude Code" beside
 * two header buttons truncated to "Pr…". So the header keeps one title
 * and a way back up. A page one level under a list — a provider, a token,
 * a session — is titled by what it shows and gets a back arrow to the
 * crumb above it; a list page is titled by its section, and the
 * section's own pages sit in a tab strip under the header, because on a
 * phone that strip is the only place they can go (the sidebar that holds
 * them is not drawn).
 *
 * Header actions keep their icon and lose their label — the label stays
 * in the accessible name — since two labelled buttons alone are wider
 * than the title they sit beside.
 */
function PhoneScreen({
  trail,
  deep,
  section,
  subtitle,
  actions,
  children
}: {
  trail: readonly Crumb[]
  /** The page named something the route cannot (a provider, a session):
   *  only then is it a level under a list rather than one of the
   *  section's own pages, which are peers reached from the strip. */
  deep: boolean
  section: NavEntry | undefined
  subtitle?: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const parent = !deep || trail.length < 2 ? undefined : trail[trail.length - 2].href
  // Routing's "Routing / Scenarios" names one page twice; its parent crumb
  // is the page itself, and an arrow back to where you already are is
  // not a way back.
  const back = parent === undefined || parent === pathname ? undefined : parent
  const title =
    back === undefined ? (section === undefined ? trail.at(-1)?.label : t(section.labelKey)) : trail.at(-1)?.label
  const strip = back === undefined && section !== undefined && section.children.length > 0 ? section : undefined
  return (
    <>
      <header className='flex h-14 shrink-0 items-center gap-2 border-b border-border px-4'>
        {back === undefined ? null : (
          <Link
            to={back}
            aria-label={t('shell.back')}
            className='-ml-2 flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground active:bg-muted/60'
          >
            <i aria-hidden className='ri-arrow-left-s-line text-xl leading-none' />
          </Link>
        )}
        <div className='min-w-0 flex-1'>
          <h1 className='truncate text-sm font-semibold tracking-tight'>{title}</h1>
          {subtitle ? <p className='truncate text-xs text-muted-foreground'>{subtitle}</p> : null}
        </div>
        <div className='flex shrink-0 items-center gap-1 [&_[data-rbutton-label]]:sr-only [&>button]:px-2'>
          {actions}
        </div>
      </header>
      {strip === undefined ? null : <SectionStrip section={strip} />}
      <main className='min-h-0 flex-1 overflow-y-auto'>{children}</main>
    </>
  )
}

/** A section's own pages as a tab strip, scrolling sideways when they
 *  outgrow the width (Settings has five). */
function SectionStrip({ section }: { section: NavEntry }) {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const active = childOf(pathname)
  return (
    <nav className='flex shrink-0 overflow-x-auto border-b border-border px-1 whitespace-nowrap [scrollbar-width:none]'>
      <Tabs
        items={section.children.map((c) => ({ id: c.id, label: t(c.labelKey), href: c.href }))}
        active={active === undefined ? '' : active.id}
      />
    </nav>
  )
}
