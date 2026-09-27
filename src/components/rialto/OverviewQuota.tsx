import { cn } from 'cn'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { Meter } from '@/components/rialto/primitives'
import type { OverviewQuotaRow } from '@/lib/api'
import { fmtUntil, fmtValueRatio } from '@/lib/rialto/format'
import { fmtCost, fmtTokens } from '@/lib/sessions/format'
import { ROW_LINK } from './overview-shared'

/**
 * One subscription account and every limit it is under.
 *
 * Nothing is marked as "the one that matters". Anthropic's `limits[]`
 * rows carry an `is_active` flag and it is tempting to badge, but its
 * meaning is not documented and a live sample cannot settle it: session
 * 25% inactive, weekly_all 63% active, weekly_scoped 8% inactive, which
 * is neither "highest percent" nor "one per group". A badge nobody can
 * explain is worse than no badge.
 *
 * The order is ours and is explainable: shortest window first, per-model
 * rows under the 7d they belong to.
 *
 * The account line carries no percentage. It used to show the worst
 * window's, which nothing on the row said — beside a list where every
 * line already shows its own, an unlabelled number in the corner is a
 * question rather than an answer.
 */
/**
 * What the account carried, at the models' API prices — "API equivalent",
 * never a bill. The same four columns as the windows above it, one figure
 * per cell: this week's tokens and cost, then 30 days' cost against the
 * plan fee and the ratio of the two.
 */
function UsageLine({ label, middle, ratio, cost }: { label: string; middle: string; ratio: string; cost: string }) {
  return (
    <div className='flex items-baseline gap-3 pt-2'>
      <span className='w-28 shrink-0 font-mono text-[12px] text-muted-foreground'>{label}</span>
      <span className='w-64 shrink-0 text-right font-mono text-[12px] tabular-nums text-muted-foreground'>
        {middle}
      </span>
      <span className='w-10 shrink-0 text-right font-mono text-[12px] tabular-nums'>{ratio}</span>
      <span className='w-20 shrink-0 text-right font-mono text-[12px] tabular-nums'>{cost}</span>
    </div>
  )
}

export function QuotaAccount({ row, now }: { row: OverviewQuotaRow; now: number }) {
  const { t } = useTranslation()
  return (
    // No hairline between accounts. Once they flow into columns each rule
    // spans only its own column, so an odd count left one stopping partway
    // across the section; the account name already heads each block.
    <Link to='/activity/usage' className={cn('block px-6 py-3', ROW_LINK)}>
      <div className='flex items-baseline gap-2'>
        <span className='text-xs font-medium'>{row.account}</span>
        {/* `count` rather than the `{{n}}` the neighbouring counters use:
            "1 limits" is wrong, and this one really can be 1. i18next
            reads the _one/_other pair; the plain key is there because the
            locale-parity test scans for the literal string in the source
            and cannot know about plural suffixes. */}
        <span className='text-[12px] text-muted-foreground/70'>
          {t('overview.quotaLimitCount', { count: row.windows.length })}
        </span>
      </div>
      <div className='mt-2'>
        {row.windows.map((w) => (
          <div key={`${w.window}-${w.scope}`} className='flex items-baseline gap-3 pt-2 first:pt-0'>
            <span className='w-28 shrink-0 font-mono text-[12px] text-muted-foreground'>
              {w.scope === null ? w.window : `${w.window} · ${w.scope}`}
            </span>
            {/* Capped, not stretched: full width, a 63% bar and a 65% bar
                are impossible to tell apart and the number that matters
                ends up a pane away from its label. */}
            <div className='w-64 shrink-0'>
              <Meter pct={w.pct} />
            </div>
            <span className='w-10 shrink-0 text-right font-mono text-[12px] tabular-nums text-muted-foreground'>
              {w.pct}%
            </span>
            {/* A window whose reset time has passed is waiting on the
                next poll, not resetting "in" anything — but the full
                sentence wrapped to four lines in a 5rem cell, so the
                column says "due" and the title carries the rest. */}
            <span
              className='w-20 shrink-0 truncate text-right font-mono text-[12px] tabular-nums text-muted-foreground'
              title={fmtUntil(w.resetAt, now) === null ? t('overview.resetsDue') : undefined}
            >
              {fmtUntil(w.resetAt, now) === null ? t('overview.resetsDueShort') : fmtUntil(w.resetAt, now)}
            </span>
          </div>
        ))}
        {row.usage === null ? null : (
          <>
            <UsageLine
              label={t('overview.usageWeek')}
              middle={t('overview.usageTokens', { tokens: fmtTokens(row.usage.window.totalTokens) })}
              ratio=''
              cost={fmtCost(row.usage.window.costUsd)}
            />
            <UsageLine
              label={t('overview.usage30d')}
              middle={
                row.usage.monthlyPriceUsd === null
                  ? ''
                  : t('overview.usageFee', { fee: fmtCost(row.usage.monthlyPriceUsd) })
              }
              ratio={fmtValueRatio(row.usage.valueRatio)}
              cost={fmtCost(row.usage.last30d.costUsd)}
            />
          </>
        )}
      </div>
    </Link>
  )
}
