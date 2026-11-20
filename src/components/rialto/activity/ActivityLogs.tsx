/**
 * Activity › Logs — the pino file tail, newest first.
 *
 * One pane, not three. The file rail and the request rail were 34rem of
 * chrome standing beside the lines for the whole life of the screen, on
 * the premise that one request produces a story worth opening. It does
 * not: Rialto writes exactly two lines carrying a reqId — the access
 * log's `POST /v1/messages 200 4411ms` and, at debug only,
 * provider-fetch's `final request`. Everything else in the file is boot,
 * OAuth, sync jobs and vendor scrapes, which have no request at all. So a
 * "group" was one line behind a disclosure arrow, reached through two
 * rails.
 *
 * What is left is the file, the level filter, the search and the lines,
 * each of which opens to the whole event.
 */

import { enUS, ja, zhCN } from 'date-fns/locale'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useConfig } from '@/components/ConfigProvider'
import { LogBody } from '@/components/rialto/activity/LogBody'
import { type LogLine, parseLogLines } from '@/components/rialto/activity/log-lines'
import { chipFor, LEVEL_CHIPS, type LevelChip } from '@/components/rialto/activity/log-view'
import { NoteBox, ScreenMessage } from '@/components/rialto/activity/shared'
import { useActivityCounts } from '@/components/rialto/activity/use-activity-counts'
import { Pager } from '@/components/rialto/Pager'
import { RButton } from '@/components/rialto/primitives'
import { Screen } from '@/components/rialto/Screen'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'
import dayjs from '@/lib/dayjs'
import type { LogFile } from '@/lib/log-viewer/types'

const FOLLOW_INTERVAL_MS = 5000

/** Lines per page. A tail is read from the top, not scrolled to the end. */
const PAGE = 100

function logDate(file: LogFile): string {
  const match = /^(\d{4}-\d{2}-\d{2})(?:-\d+)?\.log$/.exec(file.name)
  return match === null ? dayjs(file.lastModified).format('YYYY-MM-DD') : match[1]
}

function useLogDates() {
  const [files, setFiles] = useState<LogFile[]>([])
  const [selection, setSelection] = useState<string | null>(null)
  const [result, setResult] = useState<{ date: string; lines: string[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const byDate = useMemo(() => {
    const groups = new Map<string, LogFile[]>()
    // The API lists recent files first. Read chunks in write order.
    for (const file of [...files].reverse()) {
      const date = logDate(file)
      const group = groups.get(date)
      if (group === undefined) groups.set(date, [file])
      else group.push(file)
    }
    return groups
  }, [files])
  const dates = useMemo(() => [...byDate.keys()].sort(), [byDate])
  const date = selection === null ? dates.at(-1) : selection

  useEffect(() => {
    api
      .getLogFiles()
      .then(setFiles)
      .catch((cause: Error) => setError(cause.message))
  }, [])

  const selectDate = (next: string) => {
    if (next === date) return
    generation.current += 1
    setError(null)
    setSelection(next)
  }

  const loadLines = useCallback(() => {
    if (date === undefined) return
    const group = byDate.get(date)
    if (group === undefined) return
    const request = ++generation.current
    Promise.all(group.map((file) => api.getLogs(file.path)))
      .then((chunks) => {
        if (request !== generation.current) return
        setResult({ date, lines: chunks.flat() })
        setError(null)
      })
      .catch((cause: Error) => {
        if (request === generation.current) setError(cause.message)
      })
  }, [date, byDate])

  useEffect(loadLines, [loadLines])
  return { dates, date, selectDate, rawLines: result?.date === date ? result?.lines : undefined, error, loadLines }
}

function LogDatePicker({
  date,
  dates,
  onSelect
}: {
  date: string
  dates: readonly string[]
  onSelect: (date: string) => void
}) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const selected = dayjs(date).toDate()
  const locale = i18n.language.startsWith('ja') ? ja : i18n.language.startsWith('zh') ? zhCN : enUS
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type='button' variant='outline' size='sm' aria-label={t('activity.logs.date', { date })}>
          {date}
        </Button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-auto p-0'>
        <Calendar
          mode='single'
          locale={locale}
          selected={selected}
          defaultMonth={selected}
          startMonth={dayjs(dates[0]).toDate()}
          endMonth={dayjs(dates.at(-1)).toDate()}
          disabled={(day) => !dates.includes(dayjs(day).format('YYYY-MM-DD'))}
          onSelect={(day) => {
            if (day === undefined) return
            onSelect(dayjs(day).format('YYYY-MM-DD'))
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

function LevelChipButton({ level, on, onToggle }: { level: LevelChip; on: boolean; onToggle: () => void }) {
  return (
    <Button
      type='button'
      size='sm'
      variant='outline'
      aria-pressed={on}
      onClick={onToggle}
      className={on ? 'bg-muted' : 'text-muted-foreground'}
    >
      {level}
    </Button>
  )
}

/**
 * The toolbar and the lines. Owns the search and the page, which belong to
 * one date; the level filter is handed in, because this pane is remounted
 * on every date switch and would take it along.
 */
export function LogPane({
  dates,
  date,
  onSelectDate,
  levels,
  onLevelsChange,
  lines
}: {
  dates: readonly string[]
  date: string
  onSelectDate: (next: string) => void
  levels: ReadonlySet<LevelChip>
  onLevelsChange: (next: Set<LevelChip>) => void
  lines: LogLine[]
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)

  const needle = query.trim().toLowerCase()
  // Newest first, the way a tail is read. The file arrives in write order.
  const shown = useMemo(
    () =>
      lines
        .filter((l) => levels.has(chipFor(l.level)) && (needle === '' || l.raw.toLowerCase().includes(needle)))
        .reverse(),
    [lines, levels, needle]
  )

  // The filters rebuild the list under the cursor, so a page index past
  // the new end has to fall back rather than render nothing.
  const pageCount = Math.max(1, Math.ceil(shown.length / PAGE))
  const current = Math.min(page, pageCount - 1)
  const offset = current * PAGE

  const toggleLevel = (level: LevelChip) => {
    const next = new Set(levels)
    if (next.has(level)) next.delete(level)
    else next.add(level)
    onLevelsChange(next)
    setPage(0)
  }

  return (
    // Capped, not stretched, and left-aligned so the toolbar and the lines
    // under it share one left edge. A log line has a natural length; a
    // wider window should not pull the message away from the fields that
    // qualify it.
    <div className='min-w-0'>
      <div className='max-w-[64rem]'>
        <div className='flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 md:px-6'>
          <LogDatePicker date={date} dates={dates} onSelect={onSelectDate} />
          <span className='mx-1 h-4 w-px bg-border max-md:hidden' />
          {LEVEL_CHIPS.map((level) => (
            <LevelChipButton key={level} level={level} on={levels.has(level)} onToggle={() => toggleLevel(level)} />
          ))}
          <div className='ml-auto flex h-7 w-44 items-center gap-2 rounded-md border border-border px-2.5 text-xs text-muted-foreground max-md:w-full'>
            <i className='ri-search-line text-sm' />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setPage(0)
              }}
              placeholder={t('activity.logs.search')}
              className='min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground'
            />
          </div>
        </div>

        <LogBody lines={shown.slice(offset, offset + PAGE)} />

        <Pager
          page={current}
          pageSize={PAGE}
          loaded={Math.min(PAGE, Math.max(0, shown.length - offset))}
          total={shown.length}
          onPage={setPage}
        />

        <div className='h-6' />
      </div>
    </div>
  )
}

export function ActivityLogs() {
  const { t } = useTranslation()
  const { dates, date, selectDate, rawLines, error, loadLines } = useLogDates()
  const [follow, setFollow] = useState(false)
  // Held here, above the per-file remount below, so a file switch keeps it.
  // debug is on: with the rails gone there is nothing else competing for
  // the space, and `final request` is the only line that says which
  // upstream a request actually reached.
  const [levels, setLevels] = useState<Set<LevelChip>>(new Set(LEVEL_CHIPS))
  const _counts = useActivityCounts()
  // Whether the file this screen reads is being written at all. Off is the
  // shipped default, and an empty or frozen tail with nothing saying so
  // reads as a broken screen.
  const { config } = useConfig()
  const fileLogOff = config !== null && config.LOG === false
  const offNotice = fileLogOff ? (
    <div className='max-w-[64rem] px-4 pt-4 pb-1 md:px-6'>
      <NoteBox>
        <Trans
          i18nKey='activity.logs.fileLogOff'
          components={{ settings: <Link to='/settings/logging' className='underline' /> }}
        />
      </NoteBox>
    </div>
  ) : null

  useEffect(() => {
    if (!follow) return
    const timer = setInterval(loadLines, FOLLOW_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [follow, loadLines])

  const lines = useMemo(() => parseLogLines(rawLines === undefined ? [] : rawLines), [rawLines])

  // No Download. The screens hand out no files: the log is read here, or
  // on the host it is written to.
  return (
    <Screen
      actions={
        <RButton
          variant='outline'
          icon='ri-broadcast-line'
          aria-pressed={follow}
          onClick={() => setFollow((v) => !v)}
          className={follow ? 'bg-muted/60' : ''}
        >
          {t('activity.logs.follow')}
        </RButton>
      }
    >
      {error !== null ? (
        <ScreenMessage tone='bad'>{error}</ScreenMessage>
      ) : date === undefined ? (
        // With file logging off the notice already says why there is nothing.
        offNotice === null ? (
          <ScreenMessage>{t('activity.logs.noFiles')}</ScreenMessage>
        ) : (
          offNotice
        )
      ) : (
        <>
          {offNotice}
          <LogPane
            key={date}
            dates={dates}
            date={date}
            onSelectDate={selectDate}
            levels={levels}
            onLevelsChange={setLevels}
            lines={lines}
          />
        </>
      )}
    </Screen>
  )
}
