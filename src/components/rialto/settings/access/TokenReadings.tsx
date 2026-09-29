import { useTranslation } from 'react-i18next'
import { SettingsField } from '@/components/rialto/settings/SettingsLayout'
import type { AccessTokenWire } from '@/lib/api'
import { fmtAgo, fmtCount } from '@/lib/rialto/format'
import { fmtTokenCount } from '@/lib/rialto/settings/access-tokens'
import { fmtCost } from '@/lib/sessions/format'

export function TokenReadings({ token, now }: { token: AccessTokenWire; now: number }) {
  const { t } = useTranslation()
  return (
    <>
      <SettingsField label={t('settings.access.detailUsage')} hint={t('settings.access.detailUsageHint')}>
        <div className='flex items-center gap-4 font-mono text-xs tabular-nums'>
          <span>{t('settings.access.detailRequests', { n: fmtCount(token.requestCount) })}</span>
          <span className='text-muted-foreground'>·</span>
          <span>{fmtCost(token.costUsd)}</span>
          <span className='text-muted-foreground'>·</span>
          {/* Same window and same absent-dash as the Cost beside it, so
              the row reads as one span rather than three. */}
          <span>
            {t('settings.access.detailTokens', {
              in: fmtTokenCount(token.inputTokens),
              out: fmtTokenCount(token.outputTokens)
            })}
          </span>
          <span className='text-muted-foreground'>·</span>
          <span className='text-muted-foreground'>
            {token.lastUsedAt === null
              ? t('settings.access.never')
              : t('settings.access.lastUsedAgo', { ago: fmtAgo(token.lastUsedAt, now) })}
          </span>
        </div>
      </SettingsField>

      <SettingsField label={t('settings.access.detailLifetime')} hint={t('settings.access.detailLifetimeHint')}>
        <div className='space-y-1 font-mono text-xs'>
          <div>{t('settings.access.detailCreated', { date: token.createdAt.slice(0, 10) })}</div>
          <div>
            {token.expiresAt === null
              ? t('settings.access.detailNoExpiry')
              : t('settings.access.detailExpires', { date: token.expiresAt.slice(0, 10) })}
          </div>
          {/* Absent until the secret has actually been replaced — a
              "never rotated" line on a week-old token is noise, but on
              a two-year-old one the absence is the point, so it is the
              date that appears rather than a reassuring default. */}
          {token.rotatedAt === null ? null : (
            <div>{t('settings.access.detailRotated', { date: token.rotatedAt.slice(0, 10) })}</div>
          )}
        </div>
      </SettingsField>
    </>
  )
}
