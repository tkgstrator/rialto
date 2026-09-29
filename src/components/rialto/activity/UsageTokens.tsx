import { useTranslation } from 'react-i18next'
import type { TokenUsageRow } from '@/components/rialto/activity/usage-derive'
import { scopePaths } from '@/components/rialto/activity/use-surfaces'
import { Meter, SurfaceScope } from '@/components/rialto/primitives'
import type { InboundSurfaceWire } from '@/lib/api'
import { fmtAgo, fmtCount } from '@/lib/rialto/format'
import { fmtCost } from '@/lib/sessions/format'

export function TokenRow({
  row,
  surfaces,
  now
}: {
  row: TokenUsageRow
  surfaces: readonly InboundSurfaceWire[]
  now: number
}) {
  const { t } = useTranslation()
  const paths = scopePaths(surfaces, row.surfaces)
  const revoked = row.kind === 'revoked'
  return (
    <tr className='border-t border-border/60 transition-colors hover:bg-muted/50'>
      <td className='py-2.5 pl-6 pr-3'>
        {revoked ? (
          <>
            <div className='truncate text-xs font-medium text-muted-foreground'>
              {t('activity.usage.revokedTokens')}
            </div>
            <div className='text-[12px] text-muted-foreground'>{t('activity.usage.revokedTokensHint')}</div>
          </>
        ) : (
          <>
            <div className='truncate text-xs font-medium'>{row.name}</div>
            <div className='font-mono text-[12px] text-muted-foreground'>{row.prefix}</div>
          </>
        )}
      </td>
      <td className='px-3'>
        {revoked ? (
          <span className='text-[12px] text-muted-foreground'>–</span>
        ) : (
          <SurfaceScope paths={paths} allLabel={t('settings.access.scopeAll')} />
        )}
      </td>
      <td className='px-3 text-right font-mono text-xs tabular-nums'>{fmtCount(row.requestCount)}</td>
      <td className='px-3 text-right font-mono text-xs tabular-nums'>{fmtCost(row.costUsd)}</td>
      <td className='px-3'>
        <div className='flex items-center gap-2'>
          <Meter pct={row.sharePct === null ? 0 : row.sharePct} tone='mute' />
          <span className='w-8 shrink-0 text-right font-mono text-[12px] tabular-nums text-muted-foreground'>
            {row.sharePct === null ? '–' : `${row.sharePct}%`}
          </span>
        </div>
      </td>
      <td className='py-2.5 pl-3 pr-6 text-right font-mono text-[12px] tabular-nums text-muted-foreground'>
        {revoked ? '–' : row.lastUsedAt === null ? t('settings.access.never') : fmtAgo(row.lastUsedAt, now)}
      </td>
    </tr>
  )
}
