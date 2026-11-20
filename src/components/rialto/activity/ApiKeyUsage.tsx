import { useTranslation } from 'react-i18next'
import { vendorLabel } from '@/components/rialto/providers/vendor-labels'
import { fmtCount } from '@/lib/rialto/format'
import { fmtCost, fmtTokens } from '@/lib/sessions/format'
import { apiKeyVendorName } from '@/shared/custom-provider'
import type { UsageCostResponse } from './data'
import { ScreenMessage } from './shared'

export function ApiKeyUsage({ result, loading }: { result: UsageCostResponse | null; loading: boolean }) {
  const { t } = useTranslation()
  if (result === null) return loading ? <ScreenMessage>{t('common.loading')}</ScreenMessage> : null
  if (!result.providers.length) return <ScreenMessage>{t('activity.usage.apiKeyEmpty')}</ScreenMessage>

  return (
    <ul className='divide-y divide-border px-4 pb-2 md:px-6'>
      {result.providers.map((entry) => {
        const vendor = apiKeyVendorName(entry.provider)
        const label =
          entry.displayName && entry.displayName !== vendor && !entry.accountId
            ? entry.displayName
            : vendorLabel(vendor, vendor)
        const requests = entry.models.reduce((sum, row) => sum + row.requestCount, 0)
        const input = entry.models.reduce(
          (sum, row) => sum + row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens,
          0
        )
        const output = entry.models.reduce((sum, row) => sum + row.outputTokens, 0)
        const stats = [
          [t('settings.access.colRequests'), fmtCount(requests)],
          [t('activity.session.inputTokens'), fmtTokens(input)],
          [t('activity.session.outputTokens'), fmtTokens(output)],
          [t('activity.usage.apiKeyCost'), fmtCost(entry.totalCostUsd)]
        ]
        return (
          <li key={entry.provider} className='grid gap-2 py-3 text-xs md:grid-cols-[minmax(0,1fr)_minmax(24rem,1fr)]'>
            <div className='min-w-0'>
              <div className='font-medium'>{label}</div>
              {entry.accountId ? (
                <div className='break-all font-mono text-muted-foreground'>{entry.accountId}</div>
              ) : null}
            </div>
            <dl className='grid grid-cols-2 gap-2 sm:grid-cols-4'>
              {stats.map(([name, value]) => (
                <div key={name}>
                  <dt className='text-muted-foreground'>{name}</dt>
                  <dd className='font-mono tabular-nums'>{value}</dd>
                </div>
              ))}
            </dl>
          </li>
        )
      })}
    </ul>
  )
}
