import { cn } from 'cn'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'
import { Pill } from '@/components/rialto/primitives'
import type { OverviewResponse, OverviewSurfaceTraffic } from '@/lib/api'
import { fmtCount, fmtLatency, fmtRate } from '@/lib/rialto/format'
import { ROW_LINK } from './overview-shared'

export function RoutingModePill({ mode }: { mode: OverviewSurfaceTraffic['routingMode'] }) {
  const { t } = useTranslation()
  return mode === 'routed' ? (
    <Pill tone='ok' title={t('overview.modeRoutedHint')}>
      {t('routing.common.modeRouted')}
    </Pill>
  ) : (
    <Pill tone='mute' title={t('overview.modePassthroughHint')}>
      {t('routing.common.modePassthrough')}
    </Pill>
  )
}

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
        <Link
          key={s.id}
          to={`/routing?surface=${s.id}`}
          className='min-w-0 border-l-2 border-l-border px-4 py-3 transition-colors hover:bg-muted/50 hover:border-l-foreground/30'
        >
          <div className='flex items-baseline gap-2'>
            <span className='min-w-0 truncate font-mono text-xs' title={s.path}>
              {s.path}
            </span>
            <span className='ml-auto shrink-0'>
              <RoutingModePill mode={s.routingMode} />
            </span>
          </div>
          <div className='text-[12px] text-muted-foreground'>{s.client}</div>
          <div className='mt-3 grid grid-cols-3 gap-3'>
            <SurfaceStat label={t('overview.colRequests')} value={fmtCount(s.requests)} mute={false} />
            <SurfaceStat label='p50' value={fmtLatency(s.p50Ms)} mute />
            <SurfaceStat label={t('overview.colErrors')} value={fmtRate(s.errorRate)} mute />
          </div>
        </Link>
      ))}
    </div>
  )
}

export function SurfaceTable({ data }: { data: OverviewResponse }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  return (
    <table className='w-full table-fixed @min-[72rem]:hidden'>
      <colgroup>
        <col />
        <col className='w-32' />
        <col className='w-28' />
        <col className='w-20' />
        <col className='w-24' />
      </colgroup>
      <thead>
        <tr className='text-[12px] uppercase tracking-wider text-muted-foreground/70 [&>th]:h-9 [&>th]:whitespace-nowrap [&>th]:align-bottom [&>th]:pb-2'>
          <th className='pl-6 pr-3 text-left font-medium'>{t('overview.colSurface')}</th>
          <th className='px-3 text-left font-medium'>{t('overview.colRouting')}</th>
          <th className='px-3 text-right font-medium'>{t('overview.colRequests')}</th>
          <th className='px-3 text-right font-medium'>p50</th>
          <th className='pl-3 pr-6 text-right font-medium'>{t('overview.colErrors')}</th>
        </tr>
      </thead>
      <tbody>
        {data.surfaces.map((s) => (
          <tr
            key={s.id}
            className={cn('border-t border-border/60', ROW_LINK)}
            onClick={() => navigate(`/routing?surface=${s.id}`)}
          >
            <td className='py-2.5 pl-6 pr-3'>
              {/* The link carries the row for the keyboard; the row's own
                  onClick is the pointer affordance the hover promises.
                  `block`, because an inline <a> ahead of the client-name
                  div below it gets an invisible line-box strut from the
                  td's own font metrics — a few px nobody drew, repeated
                  down every row until the whole table read taller than
                  the mock's. */}
              <Link to={`/routing?surface=${s.id}`} className='block font-mono text-xs hover:underline'>
                {s.path}
              </Link>
              <div className='text-[12px] text-muted-foreground'>{s.client}</div>
            </td>
            <td className='px-3'>
              <RoutingModePill mode={s.routingMode} />
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
