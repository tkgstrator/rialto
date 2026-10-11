import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { RButton } from '@/components/rialto/primitives'
import { api } from '@/lib/api'
import type { CodexDeviceStartResponse, OAuthFlowResult } from '@/schemas/api/oauth'
import { ConnectAuthStep, type OAuthKind } from './ConnectAuthStep'
import {
  importCredentials,
  pollCodexDevice,
  startCodexDevice,
  startOAuth,
  submitManualCallback
} from './connect-actions'
import { accountLabel } from './derive'
import type { CatalogEntry, SubAccountWire } from './types'

export function ReauthenticateAccount({
  account,
  kind,
  providerName,
  now,
  onClose,
  onDone
}: {
  account: SubAccountWire
  kind: OAuthKind
  providerName: string
  now: number
  onClose: () => void
  onDone: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [state, setState] = useState<string | null>(null)
  const [device, setDevice] = useState<CodexDeviceStartResponse | null>(null)
  const [manualUrl, setManualUrl] = useState('')
  const entry: CatalogEntry = {
    name: providerName,
    displayName: kind === 'claude' ? 'Claude' : 'Codex',
    vendor: kind,
    authMode: 'subscription',
    apiBaseUrl: kind === 'claude' ? 'https://api.anthropic.com' : 'https://chatgpt.com/backend-api',
    cli: kind,
    credentialsPath: kind === 'claude' ? '~/.claude/.credentials.json' : '~/.codex/auth.json',
    models: [],
    enabled: true,
    lastRefreshedAt: null
  }

  const finish = useCallback(async () => {
    setBusy(true)
    setState(null)
    setDevice(null)
    toast.success(t('providers.accounts.reauthenticated', { account: accountLabel(account) }))
    await onDone().catch(() => {})
    onClose()
  }, [account, t, onDone, onClose])

  useEffect(() => {
    if (state === null && device === null) return
    const poll =
      device !== null
        ? () => pollCodexDevice(device.flowId)
        : () => api.get<OAuthFlowResult>(`/oauth/status/${encodeURIComponent(state === null ? '' : state)}`)
    const polling = { live: true, inFlight: false }
    const stopped = (message: string) => {
      setState(null)
      setDevice(null)
      setError(message)
    }
    const applyResult = async (result: OAuthFlowResult) => {
      if (!polling.live || result.status === 'pending') return
      if (result.status === 'connected') await finish()
      else stopped(result.status === 'error' ? result.error : t('providers.connect.deviceExpired'))
    }
    const failed = (err: unknown) => {
      if (polling.live) stopped(err instanceof Error ? err.message : t('providers.connect.errorRequest'))
    }
    const tick = async () => {
      if (polling.inFlight) return
      polling.inFlight = true
      try {
        await applyResult(await poll())
      } catch (err) {
        failed(err)
      } finally {
        polling.inFlight = false
      }
    }
    const timer = setInterval(
      () => {
        void tick()
      },
      device === null ? 1500 : device.intervalSeconds * 1000
    )
    return () => {
      polling.live = false
      clearInterval(timer)
    }
  }, [state, device, t, finish])

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('providers.connect.errorRequest'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className='border-y border-border' aria-label={t('providers.accounts.reauthenticate')}>
      <div className='flex items-center gap-2 px-4 py-3'>
        <div className='min-w-0 flex-1'>
          <h3 className='truncate text-sm font-semibold'>
            {t('providers.accounts.reauthenticateAccount', { account: accountLabel(account) })}
          </h3>
          <p className='mt-1 text-xs text-muted-foreground'>{t('providers.accounts.reauthenticateHint')}</p>
        </div>
        <RButton variant='ghost' onClick={onClose} disabled={busy}>
          {t('common.cancel')}
        </RButton>
      </div>
      <ConnectAuthStep
        entry={entry}
        oauthKind={kind}
        pending={state !== null}
        device={device}
        busy={busy}
        failure={error === null ? null : { message: error, at: null }}
        now={now}
        manualUrl={manualUrl}
        apiKeyDraft=''
        onSignIn={() => {
          void run(async () => {
            setState(await startOAuth(kind, t, account.id))
          })
        }}
        onStartDevice={() => {
          void run(async () => {
            setDevice(await startCodexDevice(account.id))
          })
        }}
        onImport={(file) => {
          void run(async () => {
            setState(null)
            setDevice(null)
            await importCredentials(kind, file, t, account.id)
            await finish()
          })
        }}
        onManualUrlChange={setManualUrl}
        onSubmitManual={() => {
          void run(async () => {
            setState(null)
            await submitManualCallback(manualUrl, t, state === null ? undefined : state)
            await finish()
          })
        }}
        onApiKeyChange={() => {}}
        onSaveApiKey={() => {}}
      />
    </section>
  )
}
