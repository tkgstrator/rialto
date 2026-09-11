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

import { cn } from 'cn'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { type LogLine, lineDetail, lineFields } from '@/components/rialto/activity/log-lines'
import { chipFor, GUTTER, LEVEL_TEXT } from '@/components/rialto/activity/log-view'
import dayjs from '@/lib/dayjs'

/**
 * One line, which opens to the whole event.
 *
 * Closed, a row shows what fits — each trailing value clipped to 120
 * characters — and that is exactly the part an error's stack or an
 * upstream's response body needs. Opening it is the only way to read
 * those here. The indented body is built on open, not per row: at debug a
 * single line can carry a whole request body.
 */
function LogRow({ line }: { line: LogLine }) {
  const chip = chipFor(line.level)
  const detail = useMemo(() => lineDetail(line.raw), [line.raw])
  const [open, setOpen] = useState(false)
  return (
    <details className='border-b border-border/40' onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className='flex cursor-pointer list-none gap-0 hover:bg-muted/50 [&::-webkit-details-marker]:hidden'>
        <span className={cn('w-0.5 shrink-0', GUTTER[chip])} />
        <span className='w-28 shrink-0 py-1.5 pl-6 font-mono text-[12px] tabular-nums text-muted-foreground'>
          {line.time === 0 ? '' : dayjs(line.time).format('HH:mm:ss.SSS')}
        </span>
        <span className={cn('w-16 shrink-0 py-1.5 pl-2 font-mono text-[11px] uppercase', LEVEL_TEXT[chip])}>
          {line.level}
        </span>
        <span className={cn('min-w-0 flex-1 py-1.5 pr-6', open ? '' : 'truncate')}>
          <span className='font-mono text-[12px]'>{line.msg}</span>
          {detail === '' ? null : <span className='ml-2 font-mono text-[12px] text-muted-foreground'>{detail}</span>}
        </span>
      </summary>
      {open ? (
        <pre className='overflow-x-auto border-t border-border/40 bg-muted/30 py-2.5 pl-[11.125rem] pr-6 font-mono text-[12px] leading-relaxed text-muted-foreground'>
          {lineFields(line.raw)}
        </pre>
      ) : null}
    </details>
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
