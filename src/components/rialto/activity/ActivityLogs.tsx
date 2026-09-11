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
 * each of which opens to the whole event. Where a request was routed, and
 * why, is Activity › Requests, which reads the archive rather than the log.
 */

import { cn } from 'cn'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useConfig } from '@/components/ConfigProvider'
import { LogBody } from '@/components/rialto/activity/LogBody'
import { type LogLine, parseLogLines } from '@/components/rialto/activity/log-lines'
import { chipFor, LEVEL_CHIPS, type LevelChip } from '@/components/rialto/activity/log-view'
import { FilterSelect, NoteBox, ScreenMessage } from '@/components/rialto/activity/shared'
import { useActivityCounts } from '@/components/rialto/activity/use-activity-counts'
import { Pager } from '@/components/rialto/Pager'
import { RButton } from '@/components/rialto/primitives'
import { Screen } from '@/components/rialto/Screen'
import { api } from '@/lib/api'
import { formatFileSize } from '@/lib/log-viewer/format'
import type { LogFile } from '@/lib/log-viewer/types'

const FOLLOW_INTERVAL_MS = 5000

/** Lines per page. A tail is read from the top, not scrolled to the end. */
const PAGE = 100

/**
 * File list + line fetch. Split out of the screen so the screen itself
 * stays a layout: the fetch has four states, and holding both in one
 * function pushed it past the complexity ceiling.
 */
function useLogFiles() {
  const [files, setFiles] = useState<LogFile[]>([])
  const [file, setFile] = useState<LogFile | null>(null)
  const [rawLines, setRawLines] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .getLogFiles()
      .then((res) => {
        setFiles(res)
        setFile(res.length === 0 ? null : res[0])
      })
      .catch((e: Error) => setError(e.message))
  }, [])

  const loadLines = useCallback(() => {
    if (file === null) return
    api
      .getLogs(file.path)
      .then((res) => {
        setRawLines(res)
        setError(null)
      })
      .catch((e: Error) => setError(e.message))
  }, [file])

  useEffect(loadLines, [loadLines])

  return { files, file, setFile, rawLines, error, loadLines }
}

/** One level, on or off. Off is the absence of a border, not a grey pill. */
function LevelChipButton({ level, on, onToggle }: { level: LevelChip; on: boolean; onToggle: () => void }) {
  return (
    <button
      type='button'
      aria-pressed={on}
      onClick={onToggle}
      className={cn(
        'h-7 rounded-md border px-2.5 text-xs transition-colors',
        on ? 'border-border bg-muted/60' : 'border-transparent text-muted-foreground hover:bg-muted/50'
      )}
    >
      {level}
    </button>
  )
}

/** The toolbar and the lines. Owns the reading state (file, level, search, page). */
function LogPane({
  files,
  file,
  onSelectFile,
  lines
}: {
  files: LogFile[]
  file: LogFile
  onSelectFile: (next: LogFile) => void
  lines: LogLine[]
}) {
  const { t } = useTranslation()
  // debug is on: with the rails gone there is nothing else competing for
  // the space, and `final request` is the only line that says which
  // upstream a request actually reached.
  const [levels, setLevels] = useState<Set<LevelChip>>(new Set(LEVEL_CHIPS))
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
    setLevels(next)
    setPage(0)
  }

  return (
    // Capped, not stretched, and left-aligned so the toolbar and the lines
    // under it share one left edge. A log line has a natural length; a
    // wider window should not pull the message away from the fields that
    // qualify it.
    <div className='min-w-0'>
      <div className='max-w-[64rem]'>
        <div className='flex flex-wrap items-center gap-2 border-b border-border px-6 py-3'>
          {/* The file is a control, not a rail: it is chosen once per
              visit and then never looked at again. */}
          <FilterSelect
            label={t('activity.logs.file')}
            value={file.path}
            options={files.map((f) => ({ id: f.path, label: `${f.name} · ${formatFileSize(f.size)}` }))}
            onChange={(path) => {
              const next = files.find((f) => f.path === path)
              if (next !== undefined) onSelectFile(next)
            }}
          />
          <span className='mx-1 h-4 w-px bg-border' />
          {LEVEL_CHIPS.map((level) => (
            <LevelChipButton key={level} level={level} on={levels.has(level)} onToggle={() => toggleLevel(level)} />
          ))}
          <div className='ml-auto flex h-7 w-44 items-center gap-2 rounded-md border border-border px-2.5 text-xs text-muted-foreground'>
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
  const { files, file, setFile, rawLines, error, loadLines } = useLogFiles()
  const [follow, setFollow] = useState(false)
  const _counts = useActivityCounts()
  // Whether the file this screen reads is being written at all. Off is the
  // shipped default, and an empty or frozen tail with nothing saying so
  // reads as a broken screen.
  const { config } = useConfig()
  const fileLogOff = config !== null && config.LOG === false
  const offNotice = fileLogOff ? (
    <div className='max-w-[64rem] px-6 pt-4 pb-1'>
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

  const lines = useMemo(() => parseLogLines(rawLines), [rawLines])

  // No Download. The screens hand out no files: the log is read here, or
  // on the host it is written to.
  return (
    <Screen
      subtitle={
        file === null ? undefined : t('activity.logs.subtitle', { file: file.name, size: formatFileSize(file.size) })
      }
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
      ) : file === null ? (
        // With file logging off the notice already says why there is nothing.
        offNotice === null ? (
          <ScreenMessage>{t('activity.logs.noFiles')}</ScreenMessage>
        ) : (
          offNotice
        )
      ) : (
        <>
          {offNotice}
          {/* Remount per file so the level filter, search and page reset with it. */}
          <LogPane key={file.path} files={files} file={file} onSelectFile={setFile} lines={lines} />
        </>
      )}
    </Screen>
  )
}
