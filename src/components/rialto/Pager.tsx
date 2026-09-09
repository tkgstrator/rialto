/**
 * Range footer for an unbounded list.
 *
 * Lived inside ActivitySessions, which is how Requests and Logs ended up
 * rendering whatever the first fetch returned with no way to reach the
 * rest — Requests capped at 200 rows and said so in its subtitle, which
 * names a limit without offering a way past it. One definition so the
 * three screens cannot disagree about what paging looks like.
 *
 * The range is spelled out rather than a page number: "26–50 of 128"
 * answers both "where am I" and "how much is there", and a page number
 * answers neither without knowing the page size.
 *
 * `total` is optional because a count is not always cheap. Without it the
 * footer shows the range alone and Next is enabled while the page came
 * back full — the only honest signal available when nothing has counted
 * the rest.
 */
import { useTranslation } from 'react-i18next'
import { RButton } from '@/components/rialto/primitives'

export function Pager({
  page,
  pageSize,
  loaded,
  total,
  onPage,
  compact = false
}: {
  page: number
  pageSize: number
  /** Rows on screen now — the last page is shorter than `pageSize`. */
  loaded: number
  total: number | undefined
  onPage: (next: number) => void
  /**
   * Icon-only controls for a narrow column. Activity → Logs pages its
   * request rail, which has no room for the worded buttons.
   */
  compact?: boolean
}) {
  const { t } = useTranslation()
  const first = page * pageSize + 1
  const last = page * pageSize + loaded
  const hasNext = total === undefined ? loaded === pageSize : last < total
  // Nothing to page through: one short page is the whole list, and a
  // footer that only ever says "1–6 of 6" is furniture.
  if (page === 0 && !hasNext) return null

  const range =
    total === undefined
      ? t('activity.sessions.rangeUnknownTotal', { first, last })
      : t('activity.sessions.range', { first, last, total })

  if (compact) {
    return (
      <div className='flex items-center gap-1 border-t border-border px-4 py-2'>
        <span className='text-[12px] text-muted-foreground'>{range}</span>
        <div className='ml-auto flex items-center'>
          <button
            type='button'
            aria-label={t('common.previous')}
            disabled={page === 0}
            onClick={() => onPage(page - 1)}
            className='inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40'
          >
            <i className='ri-arrow-left-s-line text-sm' />
          </button>
          <button
            type='button'
            aria-label={t('common.next')}
            disabled={!hasNext}
            onClick={() => onPage(page + 1)}
            className='inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40'
          >
            <i className='ri-arrow-right-s-line text-sm' />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className='flex items-center gap-3 border-t border-border px-6 py-3'>
      <span className='text-[12px] text-muted-foreground'>{range}</span>
      <div className='ml-auto flex items-center gap-2'>
        <RButton variant='ghost' icon='ri-arrow-left-s-line' disabled={page === 0} onClick={() => onPage(page - 1)}>
          {t('common.previous')}
        </RButton>
        <RButton variant='ghost' disabled={!hasNext} onClick={() => onPage(page + 1)}>
          {t('common.next')}
        </RButton>
      </div>
    </div>
  )
}
