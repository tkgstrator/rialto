/**
 * Activity › Sessions at phone width.
 *
 * The four headline tiles as a two-by-two grid, and a session as the two
 * things it is opened for — which one, and what it cost — with where it
 * came in, the model it mostly ran on and how long ago it was last seen
 * on the line beneath. Turns, the token split and the cache column stay
 * on the desktop table and on the session's own screen.
 */
import { useTranslation } from 'react-i18next'
import type { WindowTotals } from '@/components/rialto/activity/data'
import type { Enriched } from '@/components/rialto/activity/sessions-derive'
import { SurfaceCell } from '@/components/rialto/activity/shared'
import { PhoneRow, PhoneStats } from '@/components/rialto/primitives'
import { fmtAgo, fmtRate, shortId } from '@/lib/rialto/format'
import { fmtCost, fmtTokens } from '@/lib/sessions/format'

export function SessionsPhoneStats({ totals, rangeLabel }: { totals: WindowTotals | null; rangeLabel: string }) {
  const { t } = useTranslation()
  return (
    <div className='border-b border-border pt-4'>
      <PhoneStats
        items={[
          {
            label: t('activity.sessions.statRequests'),
            value: totals === null ? '–' : totals.requests.toLocaleString(),
            note: rangeLabel.toLowerCase()
          },
          {
            label: t('activity.sessions.statTokens'),
            value: totals === null ? '–' : fmtTokens(totals.tokens),
            note: t('activity.sessions.statTokensSub')
          },
          {
            label: t('activity.sessions.statCost'),
            value: totals === null ? '–' : fmtCost(totals.apiKeyCostUsd),
            note: t('activity.sessions.statCostSub')
          },
          {
            label: t('activity.sessions.statCacheHit'),
            value: totals === null ? '–' : fmtRate(totals.cacheHitRate),
            note: t('activity.sessions.statCacheHitSub')
          }
        ]}
      />
    </div>
  )
}

/**
 * Newest first, as the endpoint returns them: with no column headers to
 * click there is no sort, and the order the list arrives in is the one a
 * phone is checked for — what just happened.
 */
export function SessionsPhoneList({ rows, now }: { rows: Enriched[]; now: number }) {
  const { t } = useTranslation()
  return (
    <div className='[&>*:first-child]:border-t-0'>
      {rows.map((row) => {
        const { session } = row
        return (
          <PhoneRow
            key={session.sessionId}
            href={`/activity/sessions/${encodeURIComponent(session.sessionId)}`}
            primary={<span className='font-mono'>{shortId(session.sessionId)}</span>}
            trailing={fmtCost(session.totalCostUsd)}
            secondary={
              <>
                <SurfaceCell path={row.surfacePath} />
                <span className='min-w-0 truncate font-mono'>
                  {row.model === null ? t('activity.common.untracked') : row.model}
                  {row.otherModels === 0 ? null : <span className='text-muted-foreground/60'> +{row.otherModels}</span>}
                </span>
                <span className='ml-auto shrink-0 font-mono tabular-nums'>{fmtAgo(session.lastAt, now)}</span>
              </>
            }
          />
        )
      })}
    </div>
  )
}
