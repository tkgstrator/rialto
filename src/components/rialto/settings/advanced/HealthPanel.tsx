/**
 * The Health tab: what `GET /health` returned.
 *
 * The probe lives at the root rather than under `/api` so uptime checks
 * need no credential. That also puts it outside the Vite dev-server's
 * default passthrough, so it is listed explicitly in the dev-server
 * exclude list — without that entry the SPA shell answers and every
 * check reads unreachable.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pill, RButton } from '@/components/rialto/primitives'
import { SectionHead } from '@/components/rialto/settings/fields'
import { SettingsField } from '@/components/rialto/settings/SettingsLayout'
import { api, type HealthResponse } from '@/lib/api'
import { fmtUptime } from '@/lib/rialto/format'

const CHECK_TONES = { ok: 'ok', fail: 'bad', skip: 'mute' } as const

export function HealthPanel() {
  const { t } = useTranslation()
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [reachable, setReachable] = useState(true)
  const [raw, setRaw] = useState(false)

  const load = useCallback(() => {
    api
      .getHealth()
      .then((res) => {
        setHealth(res)
        setReachable(true)
      })
      .catch(() => setReachable(false))
  }, [])

  useEffect(load, [load])

  return (
    <>
      <SectionHead
        title={t('settings.advanced.healthTitle')}
        meta={t('settings.advanced.healthMeta')}
        actions={
          <div className='flex items-center gap-2'>
            {/* The parsed rows above are a reading of the probe; this is
                the probe. `/health` is the contract an uptime monitor
                consumes, so being able to see exactly what it returned —
                including a check this screen has no row for yet — is the
                difference between diagnosing the server and diagnosing
                this panel. */}
            <RButton variant='ghost' icon='ri-code-line' onClick={() => setRaw((prev) => !prev)}>
              {t('settings.advanced.rawJson')}
            </RButton>
            <RButton variant='outline' icon='ri-refresh-line' onClick={load}>
              {t('settings.advanced.recheck')}
            </RButton>
          </div>
        }
      />
      {/* No hints under these labels. Each value says what it is, and the
          prose that explained them read as noise beside a status pill. */}
      <SettingsField label={t('settings.advanced.status')}>
        {!reachable ? (
          <Pill tone='bad'>{t('settings.advanced.unreachable')}</Pill>
        ) : health === null ? (
          <Pill tone='mute'>{t('settings.advanced.probing')}</Pill>
        ) : health.status === 'ok' ? (
          <Pill tone='ok'>{t('settings.advanced.statusOk')}</Pill>
        ) : (
          <Pill tone='warn'>{t('settings.advanced.degraded')}</Pill>
        )}
      </SettingsField>
      <SettingsField label={t('settings.advanced.reportedVersion')}>
        <span className='font-mono text-xs'>{health === null ? '–' : `v${health.version}`}</span>
      </SettingsField>
      <SettingsField label={t('settings.advanced.uptime')}>
        <span className='font-mono text-xs tabular-nums'>
          {health === null ? '–' : fmtUptime(health.uptime_seconds)}
        </span>
      </SettingsField>
      <SettingsField label={t('settings.advanced.dependencyChecks')}>
        {health === null ? (
          <span className='text-[12px] text-muted-foreground'>{t('settings.advanced.nothingReported')}</span>
        ) : (
          <div className='flex flex-wrap items-center gap-2'>
            {Object.entries(health.checks).map(([name, state]) => (
              <Pill key={name} tone={CHECK_TONES[state]}>
                {name} · {state}
              </Pill>
            ))}
          </div>
        )}
      </SettingsField>
      {raw ? (
        <div className='px-6 pb-4'>
          <pre className='overflow-x-auto rounded-md border border-border bg-muted/40 px-4 py-3 font-mono text-[12px] leading-relaxed'>
            {health === null ? t('settings.advanced.nothingReported') : JSON.stringify(health, null, 2)}
          </pre>
        </div>
      ) : null}
    </>
  )
}
