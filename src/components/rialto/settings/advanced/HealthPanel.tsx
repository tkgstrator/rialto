/**
 * The Health tab: whatever `GET /health` says, unedited.
 *
 * The probe lives at the root rather than under `/api` so uptime checks
 * do not need the bootstrap token. That also puts it outside the Vite
 * dev-server's default passthrough, so it is listed explicitly in the
 * dev-server exclude list — without that entry the SPA shell answers and
 * every check reads unreachable.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pill, RButton } from '@/components/rialto/primitives'
import { SectionHead } from '@/components/rialto/settings/fields'
import { SettingsField } from '@/components/rialto/settings/SettingsLayout'
import { api, type HealthResponse } from '@/lib/api'

const CHECK_TONES = { ok: 'ok', fail: 'bad', skip: 'mute' } as const

export function HealthPanel() {
  const { t } = useTranslation()
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [reachable, setReachable] = useState(true)

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
          <RButton variant='ghost' icon='ri-refresh-line' onClick={load}>
            {t('settings.advanced.refresh')}
          </RButton>
        }
      />
      <SettingsField label={t('settings.advanced.status')} hint={t('settings.advanced.statusHint')}>
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
      <SettingsField label={t('settings.advanced.reportedVersion')} hint={t('settings.advanced.reportedVersionHint')}>
        <span className='font-mono text-xs'>{health === null ? '–' : `v${health.version}`}</span>
      </SettingsField>
      <SettingsField label={t('settings.advanced.uptime')} hint={t('settings.advanced.uptimeHint')}>
        <span className='font-mono text-xs tabular-nums'>{health === null ? '–' : health.uptime_seconds}</span>
      </SettingsField>
      <SettingsField label={t('settings.advanced.dependencyChecks')} hint={t('settings.advanced.dependencyChecksHint')}>
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
    </>
  )
}
