import { useTranslation } from 'react-i18next'
import { FieldGroup } from '@/components/ui/field'
import type { AccessTokenWire } from '@/lib/api'
import { fmtAgo, fmtCount } from '@/lib/rialto/format'
import { fmtTokenCount } from '@/lib/rialto/settings/access-tokens'
import { fmtCost } from '@/lib/sessions/format'

function Readings({ title, items }: { title: string; items: Array<[string, string]> }) {
  return (
    <FieldGroup className='gap-2'>
      <h2 className='text-xs font-medium'>{title}</h2>
      <dl className='divide-y divide-border/60 text-xs'>
        {items.map(([label, value]) => (
          <div key={label} className='flex justify-between gap-3 py-1.5'>
            <dt className='text-muted-foreground'>{label}</dt>
            <dd className='text-right font-mono tabular-nums'>{value}</dd>
          </div>
        ))}
      </dl>
    </FieldGroup>
  )
}

export function TokenReadings({ token, now }: { token: AccessTokenWire; now: number }) {
  const { t } = useTranslation()
  const usage: Array<[string, string]> = [
    [t('settings.access.colRequests'), fmtCount(token.requestCount)],
    [t('settings.access.colCost'), fmtCost(token.costUsd)],
    [t('settings.access.colInputTokens'), fmtTokenCount(token.inputTokens)],
    [t('settings.access.colOutputTokens'), fmtTokenCount(token.outputTokens)],
    [
      t('settings.access.colLastUsed'),
      token.lastUsedAt === null
        ? t('settings.access.never')
        : t('settings.access.lastUsedAgo', { ago: fmtAgo(token.lastUsedAt, now) })
    ]
  ]
  const lifetime: Array<[string, string]> = [
    [t('settings.access.createdLabel'), token.createdAt.slice(0, 10)],
    [
      t('settings.access.colExpires'),
      token.expiresAt === null ? t('settings.access.detailNoExpiry') : token.expiresAt.slice(0, 10)
    ]
  ]
  if (token.rotatedAt !== null) lifetime.push([t('settings.access.rotatedLabel'), token.rotatedAt.slice(0, 10)])
  return (
    <div className='border-t border-border/60'>
      <div className='grid max-w-3xl gap-4 px-4 py-4 md:grid-cols-2 md:gap-6 md:px-6'>
        <Readings title={t('settings.access.detailUsage')} items={usage} />
        <Readings title={t('settings.access.detailLifetime')} items={lifetime} />
      </div>
    </div>
  )
}
