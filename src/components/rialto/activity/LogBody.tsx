/**
 * The lines themselves.
 *
 * `LogRow` is not exported — a line only ever appears inside this list.
 * Filtering, paging and the toolbar belong to the screen; this renders
 * what it is handed, in the order it is handed it.
 *
 * There is no Copy and no Raw here any more. Both belonged to the group
 * pane: Copy took the open group's lines and Raw swapped the rendered
 * group for its JSON. With one flat list there is no group to take.
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { type LogLine, lineDetail } from '@/components/rialto/activity/log-lines'
import { chipFor, GUTTER, LEVEL_TEXT } from '@/components/rialto/activity/log-view'
import dayjs from '@/lib/dayjs'
import { cn } from '@/lib/utils'

function LogRow({ line }: { line: LogLine }) {
  const chip = chipFor(line.level)
  const detail = useMemo(() => lineDetail(line.raw), [line.raw])
  return (
    <div className='flex gap-0 border-b border-border/40 hover:bg-muted/50'>
      <span className={cn('w-0.5 shrink-0', GUTTER[chip])} />
      <span className='w-28 shrink-0 py-1.5 pl-6 font-mono text-[12px] tabular-nums text-muted-foreground'>
        {line.time === 0 ? '' : dayjs(line.time).format('HH:mm:ss.SSS')}
      </span>
      <span className={cn('w-16 shrink-0 py-1.5 pl-2 font-mono text-[11px] uppercase', LEVEL_TEXT[chip])}>
        {line.level}
      </span>
      <span className='min-w-0 flex-1 py-1.5 pr-6'>
        <span className='font-mono text-[12px]'>{line.msg}</span>
        {detail === '' ? null : <span className='ml-2 font-mono text-[12px] text-muted-foreground'>{detail}</span>}
      </span>
    </div>
  )
}

export function LogBody({ lines }: { lines: LogLine[] }) {
  const { t } = useTranslation()
  if (lines.length === 0) {
    return <div className='px-6 py-6 text-xs text-muted-foreground'>{t('activity.logs.noLines')}</div>
  }
  return (
    <>
      {lines.map((line) => (
        <LogRow key={line.key} line={line} />
      ))}
    </>
  )
}
