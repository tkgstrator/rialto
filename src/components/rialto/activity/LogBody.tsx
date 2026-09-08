/**
 * The reading pane: one request group, rendered line by line or raw.
 *
 * `LogRow` is not exported — a line only ever appears inside this pane,
 * and the raw toggle means the pane decides whether rows are rendered at
 * all. Search is applied here rather than by the caller because the
 * toggle has to filter both branches identically.
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { type LogGroup, type LogLine, lineDetail, shortReqId } from '@/components/rialto/activity/log-lines'
import { chipFor, GUTTER, LEVEL_TEXT, LEVEL_TONE } from '@/components/rialto/activity/log-view'
import { NoteBox } from '@/components/rialto/activity/shared'
import { Pill, RButton } from '@/components/rialto/primitives'
import dayjs from '@/lib/dayjs'
import { cn } from '@/lib/utils'

function LogRow({ line }: { line: LogLine }) {
  const chip = chipFor(line.level)
  const detail = useMemo(() => lineDetail(line.raw), [line.raw])
  return (
    <div className='group flex gap-0 hover:bg-muted/50'>
      <span className={cn('w-0.5 shrink-0', GUTTER[chip])} />
      <span className='w-28 shrink-0 py-1 pl-3 font-mono text-[12px] tabular-nums text-muted-foreground'>
        {line.time === 0 ? '' : dayjs(line.time).format('HH:mm:ss.SSS')}
      </span>
      <span className={cn('w-16 shrink-0 py-1 pl-2 font-mono text-[11px] uppercase', LEVEL_TEXT[chip])}>
        {line.level}
      </span>
      <span className='min-w-0 flex-1 py-1 pr-4'>
        <span className='font-mono text-[12px]'>{line.msg}</span>
        {detail === '' ? null : <span className='ml-2 font-mono text-[12px] text-muted-foreground'>{detail}</span>}
      </span>
    </div>
  )
}

export function LogBody({
  fileName,
  group,
  query,
  onQuery,
  raw,
  onToggleRaw
}: {
  fileName: string
  group: LogGroup | null
  query: string
  onQuery: (next: string) => void
  raw: boolean
  onToggleRaw: () => void
}) {
  const { t } = useTranslation()
  const lines = group === null ? [] : group.lines
  const shown = query === '' ? lines : lines.filter((l) => l.raw.toLowerCase().includes(query.toLowerCase()))
  const copy = () => {
    // Clipboard writes are permission-gated, and a refused one leaves the
    // pane looking exactly like a successful copy — the operator only finds
    // out when they paste. `?.` covers the API being absent altogether,
    // which it is on a non-secure origin.
    navigator.clipboard
      ?.writeText(lines.map((l) => l.raw).join('\n'))
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)))
  }
  return (
    <div className='min-w-0 overflow-y-auto'>
      <div className='flex items-center gap-2 border-b border-border px-4 py-2.5'>
        <span className='font-mono text-[12px] text-muted-foreground'>{fileName}</span>
        <i className='ri-arrow-right-s-line text-sm text-muted-foreground/50' />
        <span className='font-mono text-[12px]'>{group === null ? '—' : shortReqId(group.id)}</span>
        {group === null ? null : <Pill tone={LEVEL_TONE[chipFor(group.level)]}>{chipFor(group.level)}</Pill>}
        <div className='ml-auto flex items-center gap-2'>
          <div className='flex h-7 w-44 items-center gap-2 rounded-md border border-border px-2.5 text-xs text-muted-foreground'>
            <i className='ri-search-line text-sm' />
            <input
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              placeholder={t('activity.logs.searchInGroup')}
              className='min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground'
            />
          </div>
          <RButton variant='ghost' icon='ri-file-copy-line' onClick={copy} disabled={lines.length === 0}>
            {t('activity.logs.copy')}
          </RButton>
          <RButton variant='ghost' icon='ri-code-line' aria-pressed={raw} onClick={onToggleRaw}>
            {t('activity.logs.raw')}
          </RButton>
        </div>
      </div>
      {raw ? (
        <pre className='overflow-x-auto px-4 py-2 font-mono text-[12px] leading-relaxed'>
          {shown.map((l) => l.raw).join('\n')}
        </pre>
      ) : (
        <div className='py-1'>
          {shown.map((line) => (
            <LogRow key={line.key} line={line} />
          ))}
        </div>
      )}
      <div className='px-4 py-4'>
        <NoteBox>{t('activity.logs.note')}</NoteBox>
      </div>
      <div className='h-6' />
    </div>
  )
}
