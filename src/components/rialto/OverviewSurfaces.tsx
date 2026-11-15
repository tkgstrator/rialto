import { cn } from 'cn'
import { useTranslation } from 'react-i18next'
import type { OverviewResponse } from '@/lib/api'
import { fmtCount, fmtLatency, fmtRate } from '@/lib/rialto/format'

function SurfaceStat({ label, value, mute }: { label: string; value: string; mute: boolean }) {
  return (
    <div>
      <div className='text-[12px] uppercase tracking-wider text-muted-foreground/70'>{label}</div>
      <div className={cn('mt-0.5 font-mono text-sm tabular-nums', mute && 'text-muted-foreground')}>{value}</div>
    </div>
  )
}

/**
 * The same four surfaces as tiles, for a pane wide enough to hold them in
 * one row: there the table's path column was mostly air, with each row's
 * figures a screen away from the path they belong to. The tile is Spend's
 * flat tile, so the two rows read as one grid. With no header row over
 * them, every figure carries its own label.
 */
export function SurfaceTiles({ data }: { data: OverviewResponse }) {
  const { t } = useTranslation()
  return (
    <div className='hidden grid-cols-4 gap-px px-6 pb-6 @min-[72rem]:grid'>
      {data.surfaces.map((s) => (
        <div key={s.id} className='min-w-0 border-l-2 border-l-border px-4 py-3'>
          <div className='flex items-baseline gap-2'>
            <span className='min-w-0 truncate font-mono text-xs' title={s.path}>
              {s.path}
            </span>
          </div>
          <div className='text-[12px] text-muted-foreground'>{s.client}</div>
          <div className='mt-3 grid grid-cols-3 gap-3'>
            <SurfaceStat label={t('overview.colRequests')} value={fmtCount(s.requests)} mute={false} />
            <SurfaceStat label='p50' value={fmtLatency(s.p50Ms)} mute />
            <SurfaceStat label={t('overview.colErrors')} value={fmtRate(s.errorRate)} mute />
          </div>
        </div>
      ))}
    </div>
  )
}

export function SurfaceTable({ data }: { data: OverviewResponse }) {
  const { t } = useTranslation()
  return (
    <table className='w-full table-fixed @min-[72rem]:hidden'>
      <colgroup>
        <col />
        <col className='w-28' />
        <col className='w-20' />
        <col className='w-24' />
      </colgroup>
      <thead>
        <tr className='text-[12px] uppercase tracking-wider text-muted-foreground/70 [&>th]:h-9 [&>th]:whitespace-nowrap [&>th]:align-bottom [&>th]:pb-2'>
          <th className='pl-6 pr-3 text-left font-medium'>{t('overview.colSurface')}</th>
          <th className='px-3 text-right font-medium'>{t('overview.colRequests')}</th>
          <th className='px-3 text-right font-medium'>p50</th>
          <th className='pl-3 pr-6 text-right font-medium'>{t('overview.colErrors')}</th>
        </tr>
      </thead>
      <tbody>
        {data.surfaces.map((s) => (
          <tr key={s.id} className='border-t border-border/60'>
            <td className='py-2.5 pl-6 pr-3'>
              <div className='font-mono text-xs'>{s.path}</div>
              <div className='text-[12px] text-muted-foreground'>{s.client}</div>
            </td>
            <td className='px-3 text-right font-mono text-xs tabular-nums'>{fmtCount(s.requests)}</td>
            <td className='px-3 text-right font-mono text-xs tabular-nums text-muted-foreground'>
              {fmtLatency(s.p50Ms)}
            </td>
            <td className='py-2.5 pl-3 pr-6 text-right font-mono text-xs tabular-nums text-muted-foreground'>
              {fmtRate(s.errorRate)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
