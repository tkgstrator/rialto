/**
 * The two left-hand rails: files, then the requests inside the selected
 * file.
 *
 * They share a file because they are the same control at two zoom levels
 * — a vertical list of `border-l-2` buttons where the active one carries
 * the accent — and keeping the markup adjacent is what stops the two
 * lists from drifting apart visually.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { type LogGroup, shortReqId } from '@/components/rialto/activity/log-lines'
import { chipFor, groupKey, LEVEL_CHIPS, LEVEL_TONE, type LevelChip } from '@/components/rialto/activity/log-view'
import { Pager } from '@/components/rialto/Pager'
import { Pill } from '@/components/rialto/primitives'
import dayjs from '@/lib/dayjs'
import { formatFileSize } from '@/lib/log-viewer/format'
import type { LogFile } from '@/lib/log-viewer/types'
import { cn } from '@/lib/utils'

export function FileRail({
  files,
  activePath,
  onSelect,
  levels,
  onToggleLevel
}: {
  files: LogFile[]
  activePath: string | null
  onSelect: (file: LogFile) => void
  levels: Set<LevelChip>
  onToggleLevel: (level: LevelChip) => void
}) {
  const { t } = useTranslation()
  return (
    <aside className='min-w-0 overflow-y-auto border-r border-border'>
      <div className='flex items-center gap-2 px-4 pt-5 pb-2'>
        <h2 className='text-[12px] font-semibold uppercase tracking-wider text-muted-foreground'>
          {t('activity.logs.railFiles')}
        </h2>
      </div>
      {files.map((file) => (
        <button
          key={file.path}
          type='button'
          onClick={() => onSelect(file)}
          className={cn(
            'flex w-full items-center gap-2 border-l-2 px-4 py-2 text-left transition-colors',
            file.path === activePath
              ? 'border-l-foreground bg-muted/60'
              : 'border-l-transparent hover:border-l-border hover:bg-muted/50'
          )}
        >
          <i className='ri-file-text-line text-sm text-muted-foreground' />
          <span className='truncate font-mono text-[12px]'>{file.name}</span>
          <span className='ml-auto shrink-0 font-mono text-[11px] text-muted-foreground'>
            {formatFileSize(file.size)}
          </span>
        </button>
      ))}
      <div className='border-t border-border px-4 py-3'>
        <div className='text-[12px] text-muted-foreground'>{t('activity.logs.railLevel')}</div>
        <div className='mt-1.5 flex flex-wrap gap-1'>
          {LEVEL_CHIPS.map((level) => (
            <button
              key={level}
              type='button'
              onClick={() => onToggleLevel(level)}
              className={cn(
                'rounded border px-1.5 py-0.5 text-[11px] transition-colors',
                levels.has(level)
                  ? 'border-foreground/40 bg-muted/60'
                  : 'border-border text-muted-foreground hover:bg-muted/50'
              )}
            >
              {level}
            </button>
          ))}
        </div>
      </div>
    </aside>
  )
}

/**
 * How many request groups the rail holds at once.
 *
 * The rail rendered every group in the file. A busy hour is hundreds,
 * and they are all the same height, so the scrollbar became the only
 * navigation — with no way to tell how far in you were. Paged, and the
 * count in the header now says how many there are rather than how many
 * happen to be drawn.
 */
const GROUP_PAGE = 25

export function GroupRail({
  groups,
  activeKey,
  onSelect
}: {
  groups: LogGroup[]
  activeKey: string
  onSelect: (key: string) => void
}) {
  const { t } = useTranslation()
  const [page, setPage] = useState(0)
  // A file switch or a level filter rebuilds the list under the cursor;
  // staying on page 7 of a list that now has two pages shows nothing.
  const pageCount = Math.max(1, Math.ceil(groups.length / GROUP_PAGE))
  const current = Math.min(page, pageCount - 1)
  const shown = groups.slice(current * GROUP_PAGE, current * GROUP_PAGE + GROUP_PAGE)
  return (
    <aside className='flex min-w-0 flex-col overflow-hidden border-r border-border'>
      <div className='flex items-center gap-2 px-4 pt-5 pb-2'>
        <h2 className='text-[12px] font-semibold uppercase tracking-wider text-muted-foreground'>
          {t('activity.logs.railRequests')}
        </h2>
        <span className='ml-auto font-mono text-[11px] text-muted-foreground'>{groups.length}</span>
      </div>
      <div className='min-h-0 flex-1 overflow-y-auto'>
        {shown.map((group) => {
          const chip = chipFor(group.level)
          return (
            <button
              key={groupKey(group)}
              type='button'
              onClick={() => onSelect(groupKey(group))}
              className={cn(
                'block w-full border-l-2 px-4 py-2.5 text-left transition-colors',
                groupKey(group) === activeKey
                  ? 'border-l-foreground bg-muted/60'
                  : 'border-l-transparent hover:border-l-border hover:bg-muted/50'
              )}
            >
              <div className='flex items-center gap-2'>
                <span className='font-mono text-[12px] tabular-nums text-muted-foreground'>
                  {group.firstTime === 0 ? '--:--:--' : dayjs(group.firstTime).format('HH:mm:ss')}
                </span>
                <Pill tone={LEVEL_TONE[chip]}>{chip}</Pill>
                <span className='ml-auto font-mono text-[11px] text-muted-foreground'>
                  {t('activity.logs.lineCount', { n: group.lines.length })}
                </span>
              </div>
              <div className='mt-1 truncate text-[12px]'>{group.summary}</div>
              <div className='mt-0.5 font-mono text-[11px] text-muted-foreground'>{shortReqId(group.id)}</div>
            </button>
          )
        })}
      </div>
      <Pager
        page={current}
        pageSize={GROUP_PAGE}
        loaded={shown.length}
        total={groups.length}
        onPage={setPage}
        compact
      />
    </aside>
  )
}
