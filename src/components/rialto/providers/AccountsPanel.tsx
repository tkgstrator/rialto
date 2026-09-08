/**
 * Subscription accounts for the selected provider.
 *
 * Absorbs SubscriptionAccountsPanel. The percentage and the reset clock
 * come from the quota collector (GET /api/overview), not from the
 * credentials — an account can authenticate fine and still be out of
 * budget, and that is the distinction the row has to make legible.
 */
import { useTranslation } from 'react-i18next'
import { Meter, Pill } from '@/components/rialto/primitives'
import { fmtUntil } from '@/lib/rialto/format'
import { cn } from '@/lib/utils'
import { accountLabel, formatPlan, type QuotaIndex, quotaForAccount } from './derive'
import type { AuthStatus, SubAccountWire, SubscriptionWire } from './types'

// Same three states the provider rail labels, so an account and its
// provider never describe the same condition in two vocabularies.
const AUTH_STATUS_KEYS: Record<AuthStatus, string> = {
  unknown: 'providers.rail.stateUnknown',
  live: 'providers.rail.stateLive',
  invalid: 'providers.rail.stateInvalid'
}

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
  const used = quotaForAccount(quota, account.id)
  const plan = account.plan === null ? null : formatPlan(account.plan)
  // '7d' is the weekly ceiling; '5h' and friends are rolling burst windows
  // whose own label is already the clearest name for them.
  const window = used === null ? '' : used.window === '7d' ? t('providers.accounts.weekly') : used.window
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
        {used === null ? null : <span className='ml-auto font-mono text-[12px] tabular-nums'>{used.pct}%</span>}
      </div>
      {used === null ? null : (
        <div className='mt-2'>
          <Meter pct={used.pct} />
        </div>
      )}
      <div className='mt-1.5 flex items-center gap-2 text-[12px] text-muted-foreground'>
        {/* The rail translates this same enum; interpolating it raw here
            printed "認証 live" beside the rail's 稼働中. */}
        <span>{t('providers.accounts.auth', { status: t(AUTH_STATUS_KEYS[account.authStatus]) })}</span>
        {used === null ? null : (
          <>
            <span className='opacity-40'>·</span>
            <span>
              {fmtUntil(used.resetAt, now) === null
                ? t('providers.accounts.resetsDue', { window })
                : t('providers.accounts.resetsIn', { window, until: fmtUntil(used.resetAt, now) })}
            </span>
          </>
        )}
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
