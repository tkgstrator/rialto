import { cn } from 'cn'
import { useTranslation } from 'react-i18next'
import type {
  AccountUsageIndex,
  AccountWindows,
  ProviderWindows,
  WindowRow
} from '@/components/rialto/activity/usage-derive'
import { Meter, Pill } from '@/components/rialto/primitives'
import type { OverviewAccountUsage } from '@/lib/api-types'
import { fmtUntil, fmtValueRatio } from '@/lib/rialto/format'
import { fmtCost, fmtTokens } from '@/lib/sessions/format'

// The vendor mark beside a provider's name — the same glyphs the Add
// provider rail draws. A hand-added provider has no vendor to draw.
const KIND_ICON: Record<ProviderWindows['kind'], string> = {
  claude: 'ri-sparkling-line',
  codex: 'ri-terminal-line',
  other: 'ri-plug-line'
}

// One line per window rather than a stacked block: six windows across two
// accounts is the common shape, and three lines each pushed the two
// panels below it off the first screen.
function WindowLine({ row, now }: { row: WindowRow; now: number }) {
  const { t } = useTranslation()
  return (
    <div className='flex items-center gap-3 border-t border-border/60 px-6 py-2.5 transition-colors hover:bg-muted/50'>
      <span className='w-24 shrink-0 truncate text-xs'>{row.label}</span>
      <span className='w-12 shrink-0 font-mono text-[12px] text-muted-foreground'>
        {row.scope === null ? '' : row.scope}
      </span>
      <div className='min-w-0 flex-1'>
        <Meter pct={row.pct} />
      </div>
      <span className='w-10 shrink-0 text-right font-mono text-xs tabular-nums'>{`${Math.round(row.pct)}%`}</span>
      {/* A duration is a number: mono and tabular so the column lines
          up. "4h 06m" and "4d 01h" are different widths otherwise. */}
      <span className='w-20 shrink-0 text-right font-mono text-[12px] tabular-nums text-muted-foreground'>
        {fmtUntil(row.resetsAt, now) === null ? t('overview.resetsDue') : fmtUntil(row.resetsAt, now)}
      </span>
    </div>
  )
}

function UsageRow({ label, cells }: { label: string; cells: { text: string; width: string; mute?: boolean }[] }) {
  return (
    <div className='flex items-center gap-3 border-t border-border/60 px-6 py-2.5 transition-colors hover:bg-muted/50'>
      <span className='w-24 shrink-0 truncate text-xs'>{label}</span>
      <span className='min-w-0 flex-1' />
      {cells.map((cell) => (
        <span
          key={cell.width}
          className={cn(
            cell.width,
            'shrink-0 text-right font-mono text-[12px] tabular-nums',
            cell.mute ? 'text-muted-foreground' : ''
          )}
        >
          {cell.text}
        </span>
      ))}
    </div>
  )
}

/**
 * What the account carried, at the models' API prices — "API equivalent",
 * never a bill. The block a subscription provider's page draws under each
 * account, set in this panel's row rhythm so it reads as more rows of the
 * windows above it: this week's tokens and cost, then 30 days' cost against
 * the plan fee and the ratio of the two.
 */
function UsageLines({ usage }: { usage: OverviewAccountUsage }) {
  const { t } = useTranslation()
  return (
    <>
      <div className='flex items-center gap-3 border-t border-border/60 px-6 pt-2.5 pb-1.5 text-[12px] uppercase tracking-wider text-muted-foreground/60'>
        <span className='w-24 shrink-0'>{t('providers.accounts.usageHeader')}</span>
        <span className='min-w-0 flex-1' />
        <span className='w-16 shrink-0 text-right'>{t('providers.accounts.usageTokens')}</span>
        <span className='w-14 shrink-0 text-right'>{t('providers.accounts.usageCost')}</span>
        <span className='w-12 shrink-0 text-right'>{t('providers.accounts.usageFee')}</span>
        <span className='w-10 shrink-0 text-right'>×</span>
      </div>
      <UsageRow
        label={t('providers.accounts.usageThisWeek')}
        cells={[
          { text: fmtTokens(usage.window.totalTokens), width: 'w-16' },
          { text: fmtCost(usage.window.costUsd), width: 'w-14' },
          { text: '', width: 'w-12' },
          { text: '', width: 'w-10' }
        ]}
      />
      <UsageRow
        label={t('providers.accounts.usage30d')}
        cells={[
          { text: '', width: 'w-16' },
          { text: fmtCost(usage.last30d.costUsd), width: 'w-14' },
          { text: usage.monthlyPriceUsd === null ? '–' : fmtCost(usage.monthlyPriceUsd), width: 'w-12', mute: true },
          { text: fmtValueRatio(usage.valueRatio), width: 'w-10' }
        ]}
      />
    </>
  )
}

/**
 * An account's name, its plan, its windows, and what it carried.
 *
 * The plan pill carries the multiplier because the multiplier is the plan:
 * "Max" and "Pro" are each two plans, and a 20x at 60% has four times the
 * headroom of a 5x at 60%, so a pill that cannot tell them apart makes
 * every meter under it unreadable.
 */
function AccountBlock({
  account,
  usage,
  now
}: {
  account: AccountWindows
  usage: OverviewAccountUsage | undefined
  now: number
}) {
  const { t } = useTranslation()
  return (
    <div className='min-w-0'>
      <div className='flex items-baseline gap-2 px-6 pb-1'>
        <span className='truncate text-xs font-medium'>{account.account}</span>
        {account.plan === null ? null : <Pill tone='info'>{account.plan}</Pill>}
        <span className='ml-auto text-[12px] text-muted-foreground/70'>{t('activity.usage.resetsIn')}</span>
      </div>
      {account.windows.map((row) => (
        <WindowLine key={`${row.label}-${row.scope}`} row={row} now={now} />
      ))}
      {usage === undefined ? null : <UsageLines usage={usage} />}
    </div>
  )
}

/**
 * One provider's accounts, under its name.
 *
 * Grouped rather than flowed through one grid: flattened, a Claude account
 * and a Codex account shared a row with nothing on either saying which
 * vendor it was, and "5-hour 88%" reads the same under both. The row name
 * sits beside the label only when it says something the label does not —
 * nothing stops two subscription providers on one vendor, and "Claude
 * Code" alone would not tell them apart.
 */
export function ProviderGroup({
  group,
  accountUsage,
  now
}: {
  group: ProviderWindows
  accountUsage: AccountUsageIndex
  now: number
}) {
  const { t } = useTranslation()
  return (
    <div className='@container border-t border-border/60 pt-3 first:border-t-0 first:pt-0'>
      <div className='flex items-center gap-2 px-6 pb-2'>
        <i className={`${KIND_ICON[group.kind]} text-sm leading-none text-muted-foreground`} />
        <span className='text-[12px] font-semibold uppercase tracking-wider text-muted-foreground'>{group.label}</span>
        {group.name === null ? null : <span className='font-mono text-[12px] text-muted-foreground'>{group.name}</span>}
        <span className='text-[12px] text-muted-foreground/70'>
          {t('activity.usage.accountCount', { count: group.accounts.length })}
        </span>
      </div>
      {/* As many accounts per row as get 28rem each, up to three: the fixed
          columns of a window line take 360px, and 28rem leaves the meter a
          track worth reading. Given the whole width each meter became 800px
          of track carrying one figure, with "resets in" a screen away from
          the percentage it qualifies.
          Measured on the group, not the viewport: the sidebar folds with
          ⌘B at any width, so a viewport breakpoint held one column across
          200px of width the section actually had.
          An empty column is left empty rather than stretching the accounts
          to fill the row — and never lent to the next provider. */}
      <div className='grid grid-cols-1 gap-x-px pb-3 @min-[56rem]:grid-cols-2 @min-[84rem]:grid-cols-3'>
        {group.accounts.map((account) => (
          <AccountBlock
            key={account.subAccountId}
            account={account}
            usage={accountUsage.get(account.subAccountId)}
            now={now}
          />
        ))}
      </div>
    </div>
  )
}
