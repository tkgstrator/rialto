/**
 * Where the OAuth callback tab ends up. Replaces OauthResultPage.
 *
 * The token exchange and the SubAccount write already happened server-side
 * (GET /callback for claude, the standalone :1455 listener for codex) by
 * the time this mounts, so both states are read-only reports — there is
 * nothing here to retry in place.
 *
 * Query params, unchanged from the old page so live redirects keep working:
 *   status   = "ok" | "error"
 *   provider = "claude" | "codex"
 *   message  = human-readable detail (error only)
 */
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { RButton } from '@/components/rialto/primitives'
import { SystemPage } from './SystemPage'

// The callback only ever sends claude or codex today; gemini is here so a
// third flow does not land on the generic label the day it ships.
const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI'
}

const providerLabel = (raw: string | null, fallback: string): string => {
  if (raw === null) return fallback
  const known = PROVIDER_LABELS[raw]
  return known === undefined ? fallback : known
}

export function OauthConnected({ provider }: { provider: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  return (
    <div className='w-full max-w-xs text-center'>
      <div className='mx-auto flex size-10 items-center justify-center rounded-full bg-emerald-500/10'>
        <i className='ri-check-line text-lg text-emerald-600 dark:text-emerald-400' />
      </div>
      <h3 className='mt-3 text-sm font-semibold'>{t('system.oauth.connected', { provider })}</h3>
      <p className='mt-1.5 text-[12px] leading-relaxed text-muted-foreground'>{t('system.oauth.connectedBody')}</p>
      <RButton variant='outline' className='mt-4' onClick={() => navigate('/providers')}>
        {t('system.oauth.backToRialto')} <i className='ri-arrow-right-line text-sm' />
      </RButton>
    </div>
  )
}

export function OauthFailed({ message }: { message: string | null }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  return (
    <div className='w-full max-w-sm text-center'>
      <div className='mx-auto flex size-10 items-center justify-center rounded-full bg-destructive/10'>
        <i className='ri-close-line text-lg text-destructive' />
      </div>
      <h3 className='mt-3 text-sm font-semibold'>{t('system.oauth.failedTitle')}</h3>
      <p className='mt-1.5 text-[12px] leading-relaxed text-muted-foreground'>{t('system.oauth.failedBody')}</p>
      {message === null ? null : (
        <div className='mt-3 rounded-md bg-muted/60 px-3 py-2 text-left font-mono text-[12px] leading-relaxed whitespace-pre-wrap'>
          {message}
        </div>
      )}
      <div className='mt-4 flex justify-center gap-2'>
        {/* The single-use `state` was consumed by the failed exchange, so
            "try again" has to restart the flow from Providers rather than
            replay this URL. */}
        <RButton variant='primary' icon='ri-refresh-line' onClick={() => navigate('/providers')}>
          {t('system.oauth.tryAgain')}
        </RButton>
        <RButton variant='outline' onClick={() => navigate('/overview')}>
          {t('common.back')}
        </RButton>
      </div>
    </div>
  )
}

/** Route entry for /oauth-result — picks the state off the query string. */
export function OauthResultScreen() {
  const { t } = useTranslation()
  const [params] = useSearchParams()
  const status = params.get('status')
  const message = params.get('message')

  return (
    <SystemPage>
      {status === 'ok' ? (
        <OauthConnected provider={providerLabel(params.get('provider'), t('system.oauth.genericProvider'))} />
      ) : (
        // Anything that is not an explicit success is a failure: a
        // callback that lost its status param did not complete either.
        <OauthFailed message={message === null || message.length === 0 ? null : message} />
      )}
    </SystemPage>
  )
}
