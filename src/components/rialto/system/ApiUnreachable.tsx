/**
 * The UI loaded but /api/* is not answering.
 *
 * This is the one system state that must not be a friendly shrug. When the
 * database is down the proxy at /v1/* usually keeps serving from its
 * cached configuration, so "everything is broken" is both wrong and
 * expensive — the operator needs to know what is still up before they
 * restart anything.
 */
import { useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Pill, RButton } from '@/components/rialto/primitives'
import { api, type HealthResponse } from '@/lib/api'
import { cn } from '@/lib/utils'
import { SystemPage } from './SystemPage'

const POLL_MS = 5000

type CheckState = HealthResponse['checks'][string]

// /health resolving at all is the liveness signal; it rejects on a
// transport failure or a non-JSON body, which is what "unreachable"
// actually means here.
interface Probe {
  health: HealthResponse | null
  detail: string
}

// /health reports `db` and `redis`; an unlabelled one falls through to
// its raw key below, which is how `redis` came to be rendered verbatim.
const CHECK_LABEL_KEYS: Record<string, string> = {
  db: 'settings.server.database',
  redis: 'settings.server.redis'
}

const CHECK_DOTS: Record<CheckState, string> = {
  ok: 'bg-emerald-500',
  fail: 'bg-destructive',
  skip: 'bg-amber-500'
}

// compose.yaml names the Postgres service `postgres`. A failed check is
// only worth a command when there is exactly one obvious next one.
const REMEDIES: Record<string, string> = { db: 'docker compose up -d postgres' }

const probeHealth = async (): Promise<Probe> => {
  try {
    const health = await api.getHealth()
    return { health, detail: `${health.status} · /health` }
  } catch (error) {
    return { health: null, detail: error instanceof Error ? error.message : 'no response' }
  }
}

function StatusRow({ label, tone, detail }: { label: string; tone: string; detail: string }) {
  return (
    <div className='flex items-center gap-2 rounded-md border border-border px-3 py-1.5'>
      <span className={cn('size-1.5 rounded-full', tone)} />
      <span className='text-[12px]'>{label}</span>
      <span className='ml-auto font-mono text-[12px] text-muted-foreground'>{detail}</span>
    </div>
  )
}

export function ApiUnreachable({ probe, onRetry }: { probe: Probe | null; onRetry?: () => void }) {
  const { t } = useTranslation()
  // Unknown check names render as themselves rather than being dropped: a
  // check the UI has never heard of is still one the operator should see
  // failing.
  const checks = probe === null || probe.health === null ? [] : Object.entries(probe.health.checks)
  const remedy = checks
    .filter(([, state]) => state === 'fail')
    .map(([name]) => REMEDIES[name])
    .find((command) => command !== undefined)

  return (
    <div className='w-full max-w-sm'>
      <div className='flex items-center gap-2'>
        <i className='ri-plug-line text-base text-destructive' />
        <h3 className='text-sm font-semibold'>{t('system.unreachable.title')}</h3>
        <Pill tone='warn'>{t('system.unreachable.retrying')}</Pill>
      </div>
      <p className='mt-2 text-[12px] leading-relaxed text-muted-foreground'>
        <Trans i18nKey='system.unreachable.body' components={{ mono: <span className='font-mono' /> }} />
      </p>
      <div className='mt-3 space-y-1.5'>
        <StatusRow
          label={t('system.unreachable.proxy')}
          tone={probe === null ? 'bg-muted-foreground/40' : probe.health === null ? 'bg-destructive' : 'bg-emerald-500'}
          detail={probe === null ? t('settings.advanced.probing') : probe.detail}
        />
        {checks.map(([name, state]) => {
          const knownKey = CHECK_LABEL_KEYS[name]
          return (
            <StatusRow
              key={name}
              label={knownKey === undefined ? name : t(knownKey)}
              tone={CHECK_DOTS[state]}
              detail={state}
            />
          )
        })}
      </div>
      {remedy === undefined ? null : (
        <div className='mt-3 rounded-md bg-muted/60 px-3 py-2 font-mono text-[12px]'>{remedy}</div>
      )}
      {onRetry === undefined ? null : (
        // The automatic retry below only fires once /health answers. A
        // config fetch can also fail for reasons /health never sees, and
        // then nothing but this button gets the operator off the page.
        <div className='mt-3'>
          <RButton variant='outline' icon='ri-refresh-line' onClick={onRetry}>
            {t('system.unreachable.retryNow')}
          </RButton>
        </div>
      )}
    </div>
  )
}

/**
 * Route / error-boundary entry. Keeps probing so the page self-heals.
 *
 * "Self-heals" used to mean only that the status dots went green: the
 * poll updated its own state and nothing re-fetched the config, so the
 * operator sat on a page reading "retrying" next to three healthy rows
 * until they reloaded by hand. `onRecovered` is what closes that loop.
 */
export function ApiUnreachableScreen({ onRecovered }: { onRecovered?: () => void }) {
  const [probe, setProbe] = useState<Probe | null>(null)

  useEffect(() => {
    const mounted = { value: true }
    const run = () => {
      // Deliberately floating. `probeHealth` resolves either way — its own
      // try/catch turns a rejection into `{ health: null, detail }`, which
      // is the failure this screen exists to render — so a `.catch` here
      // would be unreachable rather than a missing one.
      void probeHealth().then((next) => {
        if (!mounted.value) return
        setProbe(next)
        // The server is answering again, so the fetch that put us here is
        // worth repeating. Whoever mounted this owns what "retry" means.
        if (next.health !== null && onRecovered !== undefined) onRecovered()
      })
    }
    run()
    const timer = setInterval(run, POLL_MS)
    return () => {
      mounted.value = false
      clearInterval(timer)
    }
  }, [onRecovered])

  return (
    <SystemPage>
      <ApiUnreachable probe={probe} onRetry={onRecovered} />
    </SystemPage>
  )
}
