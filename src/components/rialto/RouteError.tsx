/**
 * Root error boundary.
 *
 * Two very different things arrive here: a path react-router could not
 * match, and a component that threw while rendering. They need different
 * screens — telling someone their bookmark moved when the app actually
 * crashed sends them looking in the wrong place, and vice versa.
 *
 * The crash half has no mock, because a crash screen is not a designed
 * state; it is the state where design has already failed. It renders the
 * thrown message in the same frame as the other system states rather
 * than inventing a diagnosis it cannot support.
 */
import { useTranslation } from 'react-i18next'
import { isRouteErrorResponse, useNavigate, useRouteError } from 'react-router-dom'
import { RButton } from '@/components/rialto/primitives'
import { NotFound } from '@/components/rialto/system/NotFound'
import { SystemPage } from '@/components/rialto/system/SystemPage'

const messageOf = (error: unknown): string | null => {
  if (isRouteErrorResponse(error)) return `${error.status} ${error.statusText}`
  if (error instanceof Error && error.message.length > 0) return error.message
  return null
}

export function RouteError() {
  const { t } = useTranslation()
  const error = useRouteError()
  const navigate = useNavigate()

  if (isRouteErrorResponse(error) && error.status === 404) {
    return (
      <SystemPage>
        <NotFound pathname={window.location.pathname} />
      </SystemPage>
    )
  }

  const message = messageOf(error)
  return (
    <SystemPage>
      <div className='w-full max-w-sm text-center'>
        <div className='font-mono text-2xl tabular-nums text-muted-foreground/40'>!</div>
        <h3 className='mt-2 text-sm font-semibold'>{t('system.crash.title')}</h3>
        <p className='mt-1.5 text-[12px] leading-relaxed text-muted-foreground'>{t('system.crash.body')}</p>
        {message === null ? null : (
          <div className='mt-3 overflow-x-auto rounded-md border border-border px-3 py-2 text-left font-mono text-[12px] text-muted-foreground'>
            {message}
          </div>
        )}
        <div className='mt-4 flex items-center justify-center gap-2'>
          <RButton variant='outline' icon='ri-refresh-line' onClick={() => window.location.reload()}>
            {t('settings.advanced.reload')}
          </RButton>
          <RButton variant='ghost' icon='ri-arrow-left-line' onClick={() => navigate('/overview')}>
            {t('shell.navOverview')}
          </RButton>
        </div>
      </div>
    </SystemPage>
  )
}
