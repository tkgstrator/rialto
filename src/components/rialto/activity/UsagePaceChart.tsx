import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import {
  type ChartPoint,
  capPacePoints,
  PACE_CHART_MAX,
  type UsageSeries
} from '@/components/rialto/activity/usage-derive'
import dayjs from '@/lib/dayjs'

/**
 * Series colours, validated rather than chosen by eye.
 *
 *   light  #2563eb / #d97706 / #7c3aed  on #ffffff
 *   dark   #3b82f6 / #d97706 / #8b5cf6  on #0a0a0a
 *
 * Every check passes in both modes (worst adjacent CVD ΔE 32.3 light,
 * 30.2 dark). They are Tailwind classes rather than hex so the dark step
 * is a deliberate second choice, not an automatic flip of the light one.
 *
 * Assigned in fixed order and never cycled: a fourth account's window
 * takes slot 4, and a filter that removes a series must not repaint the
 * ones that remain. Past the list, `seriesClass` returns the muted stroke
 * — an unnamed extra line is better than two series sharing a colour.
 */
const SERIES_STROKE = [
  'text-blue-600 dark:text-blue-500',
  'text-amber-600 dark:text-amber-600',
  'text-violet-600 dark:text-violet-500',
  'text-teal-600 dark:text-teal-500'
] as const
const SERIES_DOT = [
  'bg-blue-600 dark:bg-blue-500',
  'bg-amber-600',
  'bg-violet-600 dark:bg-violet-500',
  'bg-teal-600 dark:bg-teal-500'
] as const

/**
 * One tick per local midnight inside the plotted range.
 *
 * Recharts defaults to a tick per data point, which on 120 buckets prints
 * the same weekday twenty times in a row. Days are the unit the operator
 * reads a week in, so the axis is built from them rather than from the
 * sampling rate.
 */
const dayTicks = (points: readonly ChartPoint[]): number[] => {
  const first = points.at(0)
  const last = points.at(-1)
  if (first === undefined || last === undefined) return []
  const start = dayjs(first.t).startOf('day')
  const days = dayjs(last.t).diff(start, 'day') + 1
  return Array.from({ length: Math.max(0, days) }, (_, i) => start.add(i, 'day').valueOf()).filter(
    (tick) => tick >= first.t && tick <= last.t
  )
}

const seriesClass = (index: number): string =>
  index < SERIES_STROKE.length ? SERIES_STROKE[index] : 'text-muted-foreground'
const dotClass = (index: number): string => (index < SERIES_DOT.length ? SERIES_DOT[index] : 'bg-muted-foreground')

function ChartTooltip({
  active,
  payload,
  label,
  series,
  points
}: {
  active?: boolean
  payload?: { dataKey?: string | number; value?: number | string }[]
  label?: number | string
  series: readonly UsageSeries[]
  points: readonly ChartPoint[]
}) {
  const { t } = useTranslation()
  if (active !== true || payload === undefined || payload.length === 0) return null
  const point = points.find((p) => p.t === label)
  return (
    <div className='w-44 rounded-md border border-border bg-background px-3 py-2 shadow-sm'>
      <div className='text-[12px] text-muted-foreground'>
        {typeof label === 'number' ? dayjs(label).format('ddd HH:mm') : ''}
      </div>
      {series.map((s, index) => {
        const entry = payload.find((p) => p.dataKey === s.metric)
        const value = point?.[s.metric]
        if (entry === undefined || typeof value !== 'number') return null
        return (
          <div key={s.metric} className='mt-1 flex items-center gap-2'>
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass(index)}`} />
            <span className='text-[12px]'>{s.label}</span>
            <span className='ml-auto font-mono text-[12px] tabular-nums'>{`${Math.round(value)}%`}</span>
          </div>
        )
      })}
      {payload.length === 0 ? (
        <div className='mt-1 text-[12px] text-muted-foreground'>{t('common.loading')}</div>
      ) : null}
    </div>
  )
}

export function UtilizationChart({ points, series }: { points: ChartPoint[]; series: readonly UsageSeries[] }) {
  const ticks = useMemo(() => dayTicks(points), [points])
  const plottedPoints = useMemo(() => capPacePoints(points, series), [points, series])
  return (
    <>
      {/* Identity never rests on colour alone: the legend names every
          series, and four or fewer are the case this screen has. No note
          on how the samples were taken beside it — the sampling rate is
          the collector's business, not the reader's. */}
      <div className='flex items-center gap-4 px-6 pb-3'>
        {series.map((s, index) => (
          <span key={s.metric} className='flex items-center gap-1.5 text-[12px] text-muted-foreground'>
            <span className={`h-1.5 w-4 rounded-full ${dotClass(index)}`} />
            {s.label}
          </span>
        ))}
      </div>
      <div className='px-6 pb-5' style={{ height: 200 }}>
        <ResponsiveContainer width='100%' height='100%'>
          <LineChart data={plottedPoints} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} className='stroke-border' strokeWidth={1} />
            {/* 12px, the floor everything else on these screens uses.
                The axes were at 10 and were the only text under it. */}
            <XAxis
              dataKey='t'
              type='number'
              scale='time'
              domain={['dataMin', 'dataMax']}
              ticks={ticks}
              tickFormatter={(value: number) => dayjs(value).format('ddd')}
              tickLine={false}
              axisLine={false}
              className='fill-muted-foreground'
              tick={{ fontSize: 12 }}
            />
            <YAxis
              domain={[0, PACE_CHART_MAX]}
              ticks={[0, 100, 200, PACE_CHART_MAX]}
              allowDataOverflow
              tickFormatter={(value: number) => `${value}%`}
              tickLine={false}
              axisLine={false}
              className='fill-muted-foreground'
              tick={{ fontSize: 12 }}
              width={40}
            />
            <Tooltip
              content={<ChartTooltip series={series} points={points} />}
              cursor={{ className: 'stroke-border' }}
            />
            {series.map((s, index) => (
              <Line
                key={s.metric}
                type='monotone'
                dataKey={s.metric}
                stroke='currentColor'
                className={seriesClass(index)}
                strokeWidth={2}
                dot={false}
                // A gap is the honest rendering of a collector outage;
                // joining across it invents a line through unmeasured hours.
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </>
  )
}
