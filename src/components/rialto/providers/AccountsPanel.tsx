/**
 * Subscription accounts for the selected provider.
 *
 * Absorbs SubscriptionAccountsPanel. The percentages and the reset clocks
 * come from the quota collector (GET /api/overview), not from the
 * credentials — an account can authenticate fine and still be out of
 * budget, and that is the distinction the rows have to make legible.
 *
 * Every window the account is under is drawn, not just the weekly one.
 * All of them bind: an account at 0% for the week is still unroutable
 * while its 5-hour window is spent, and the per-model row is the only
 * place a Fable ceiling is visible at all. This panel used to show the
 * weekly alone, labelled "weekly", which made the other two look like
 * they did not exist.
 */
import { useTranslation } from 'react-i18next'
import { Meter, Pill } from '@/components/rialto/primitives'
import { fmtUntil } from '@/lib/rialto/format'
import { cn } from '@/lib/utils'
import { type AccountQuota, accountLabel, formatPlan, type QuotaIndex, quotaForAccount } from './derive'
import type { AuthStatus, SubAccountWire, SubscriptionWire } from './types'

// Same three states the provider rail labels, so an account and its
// provider never describe the same condition in two vocabularies.
const AUTH_STATUS_KEYS: Record<AuthStatus, string> = {
  unknown: 'providers.rail.stateUnknown',
  live: 'providers.rail.stateLive',
  invalid: 'providers.rail.stateInvalid'
}

/**
 * One window: label, bar, percentage, reset clock.
 *
 * The bar keeps the slack and the rest are fixed widths, so three windows
 * line up as a small table rather than three ragged lines. `5h` and `7d`
 * are the collector's own names for the account-wide windows; a scoped
 * row is that model's share of the same week, so it is named after the
 * week and the model together.
 */
function WindowLine({ row, now }: { row: AccountQuota; now: number }) {
  const { t } = useTranslation()
  const label =
    row.scope === null
      ? t(row.window === '7d' ? 'providers.accounts.windowSevenDay' : 'providers.accounts.windowFiveHour')
      : t('providers.accounts.windowScoped', { model: row.scope })
  const until = fmtUntil(row.resetAt, now)
  return (
    <div className='mt-1.5 flex items-center gap-2'>
      <span className='w-24 shrink-0 truncate text-[12px] text-muted-foreground'>{label}</span>
      <div className='min-w-0 flex-1'>
        <Meter pct={row.pct} />
      </div>
      <span className='w-9 shrink-0 text-right font-mono text-[12px] tabular-nums'>{`${row.pct}%`}</span>
      {/* A duration is a number: mono and tabular so the column lines up.
          "4h 06m" and "4d 01h" are different widths otherwise. An account
          the collector has not seen spend yet has no reset time at all. */}
      <span className='w-14 shrink-0 text-right font-mono text-[12px] tabular-nums text-muted-foreground'>
        {until === null ? DASH : until}
      </span>
    </div>
  )
}

const DASH = '—'

function AccountRow({
  account,
  active,
  quota,
  now
}: {
  account: SubAccountWire
  active: boolean
  quota: QuotaIndex
  now: number
}) {
  const { t } = useTranslation()
  const windows = quotaForAccount(quota, account.id)
  const plan = account.plan === null ? null : formatPlan(account.plan)
  return (
    <div
      className={cn(
        'border-l-2 px-4 py-3 transition-colors hover:bg-muted/50',
        active ? 'border-l-foreground' : 'border-l-transparent',
        account.enabled ? '' : 'opacity-45'
      )}
    >
      <div className='flex items-center gap-2'>
        <span className='text-xs font-medium'>{accountLabel(account)}</span>
        {plan === null ? null : <Pill tone='info'>{plan}</Pill>}
        {active ? <Pill tone='ok'>{t('providers.accounts.active')}</Pill> : null}
        {windows.length === 0 ? null : (
          <span className='ml-auto text-[12px] text-muted-foreground/70'>{t('providers.accounts.resetsIn')}</span>
        )}
      </div>
      {windows.map((row) => (
        <WindowLine key={`${row.window}-${row.scope}`} row={row} now={now} />
      ))}
      <div className='mt-2 flex items-center gap-2 text-[12px] text-muted-foreground'>
        {/* The rail translates this same enum; interpolating it raw here
            printed "認証 live" beside the rail's 稼働中. */}
        <span>{t('providers.accounts.auth', { status: t(AUTH_STATUS_KEYS[account.authStatus]) })}</span>
      </div>
      {account.authError === null ? null : (
        <p className='mt-1.5 font-mono text-[12px] leading-relaxed text-destructive'>{account.authError}</p>
      )}
    </div>
  )
}

export function AccountsPanel({
  subscription,
  quota,
  now
}: {
  subscription: SubscriptionWire | undefined
  quota: QuotaIndex
  now: number
}) {
  const { t } = useTranslation()
  const accounts = subscription === undefined ? [] : subscription.accounts
  const active = subscription === undefined ? null : subscription.activeAccount
  const activeId = active === null ? null : active.id
  return (
    <div className='border-r border-border'>
      <div className='px-6 pt-5 pb-2'>
        <h3 className='text-sm font-semibold'>{t('providers.accounts.title')}</h3>
      </div>
      {accounts.length === 0 ? (
        <div className='px-6 pb-5 text-[12px] text-muted-foreground'>{t('providers.accounts.empty')}</div>
      ) : (
        <div className='px-2 pb-4'>
          {accounts.map((a) => (
            <AccountRow
              key={a.id}
              account={a}
              active={activeId !== null && a.id === activeId}
              quota={quota}
              now={now}
            />
          ))}
        </div>
      )}
    </div>
  )
}
