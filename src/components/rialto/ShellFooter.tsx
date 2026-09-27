import { cn } from 'cn'
import { useTranslation } from 'react-i18next'
import { NavLink } from 'react-router-dom'
import type { HealthResponse, IdentityResponse } from '@/lib/api'
import { RailTip } from './ShellNavigation'

/**
 * Sidebar footer identity row.
 *
 * Display only. It reports who the edge said is calling; it never gates
 * anything. The access decision itself belongs at the edge (Cloudflare
 * Access) and in the API-key middleware, never in a rendered string.
 */
export function IdentityRow({ identity, collapsed }: { identity: IdentityResponse | null; collapsed: boolean }) {
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
        {/* aria-hidden when expanded: the visible spans below already
            carry the name. Collapsed, aria-label above covers it anyway. */}
        <i aria-hidden className={cn('w-4 shrink-0 text-base leading-none', icon)} />
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
export const FOOTER_ROW =
  'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors hover:bg-sidebar-accent/60'

/**
 * Sidebar serving indicator.
 *
 * The dot reports what /api/health actually said. A degraded server
 * (reachable, but a dependency check failed) is the case worth catching
 * early, and a permanently-green dot would hide exactly that.
 */
export function ServingRow({
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
