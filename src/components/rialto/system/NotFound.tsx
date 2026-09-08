/**
 * Unknown path. Replaces the not-found half of ErrorPage.
 *
 * The Rialto refactor collapsed 21 top-level routes into 5, so most 404s
 * here are a bookmark or a muscle-memory URL rather than a typo. Naming
 * the screen the old path was folded into turns a dead end into a
 * redirect the operator can follow.
 */
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'
import { RButton } from '@/components/rialto/primitives'
import { SystemPage } from './SystemPage'

// Keyed by first path segment, so /sessions/<id> resolves like /sessions.
const MERGED_INTO: Record<string, string> = {
  '/router-tiers': 'shell.navRouting',
  '/router-preferences': 'shell.navRouting',
  '/router-utilization': 'shell.navRouting',
  '/routing-map': 'shell.navRouting',
  '/models': 'shell.navProviders',
  '/subscriptions': 'shell.navProviders',
  '/transformers': 'shell.navProviders',
  '/sessions': 'shell.navActivity',
  '/usage': 'shell.navActivity',
  '/cost': 'shell.navActivity',
  '/logs': 'shell.navActivity',
  '/personas': 'shell.navSettings',
  '/json': 'shell.navSettings'
  // `/presets` and `/debug` are deliberately absent. Both were removed
  // rather than merged (the presets screen in c0b0742, the Advanced
  // scratchpad tab in ebf10bd), so "moved into Settings" sent operators
  // looking for a screen that is not there. They fall through to the
  // plain not-a-page sentence instead.
}

type Translate = (key: string, options?: Record<string, unknown>) => string

const explain = (pathname: string, t: Translate): string => {
  // /login is not a merged screen, it is a deleted concept: Cloudflare
  // Access authenticates at the edge and the app renders no login form.
  if (pathname.startsWith('/login')) return t('system.notFound.loginGone')
  const segments = pathname.split('/')
  const root = segments.length > 1 ? `/${segments[1]}` : pathname
  const merged = MERGED_INTO[root]
  return merged === undefined ? t('system.notFound.notAPage') : t('system.notFound.movedInto', { screen: t(merged) })
}

export function NotFound({ pathname }: { pathname: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  return (
    <div className='w-full max-w-xs text-center'>
      <div className='font-mono text-2xl tabular-nums text-muted-foreground/40'>404</div>
      <h3 className='mt-2 text-sm font-semibold'>{t('system.notFound.title')}</h3>
      <p className='mt-1.5 text-[12px] leading-relaxed text-muted-foreground'>
        <span className='font-mono'>{pathname}</span> {explain(pathname, t)}
      </p>
      <RButton variant='outline' icon='ri-arrow-left-line' className='mt-4' onClick={() => navigate('/overview')}>
        {t('shell.navOverview')}
      </RButton>
    </div>
  )
}

/** Route entry for the `*` catch-all. */
export function NotFoundScreen() {
  const { pathname } = useLocation()
  return (
    <SystemPage>
      <NotFound pathname={pathname} />
    </SystemPage>
  )
}
