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

import { cn } from 'cn'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Meter, Pill, RButton, Toggle } from '@/components/rialto/primitives'
import { fmtUntil } from '@/lib/rialto/format'
import type { SeatKind } from '@/shared/plan-capacity'
import { planLabel } from '@/shared/plan-label'
import {
  type AccountExtras,
  type AccountExtrasIndex,
  type AccountQuota,
  accountLabel,
  type QuotaIndex,
  quotaForAccount
} from './derive'
import { ReauthenticateAccount } from './ReauthenticateAccount'
import { SwitchReading } from './SwitchReading'
import type { AuthStatus, SubAccountWire, SubscriptionWire } from './types'

// A probe not yet completed must not look like a valid credential.
const AUTH_STATUS_KEYS: Record<AuthStatus, string> = {
  unknown: 'providers.accounts.authUnknown',
  live: 'providers.accounts.authValid',
  invalid: 'providers.accounts.authInvalid'
}
const AUTH_STATUS_TONES = { unknown: 'mute', live: 'ok', invalid: 'bad' } as const

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
      <span className='w-14 shrink-0 truncate whitespace-nowrap text-right font-mono text-[12px] tabular-nums text-muted-foreground'>
        {until === null ? DASH : until}
      </span>
    </div>
  )
}

const DASH = '—'
const NO_RELOAD = async (): Promise<void> => {}

/**
 * Banked Codex resets: how many, and the one action on this page that acts
 * on a single account. Only offered while the vendor would accept one — it
 * reports 0 applicable while no window is spent — and never spent without
 * the confirmation the screen shows first.
 */
function ResetLine({
  credits,
  locked,
  onUse
}: {
  credits: NonNullable<AccountExtras['resetCredits']>
  locked: boolean
  onUse: () => void
}) {
  const { t } = useTranslation()
  const applies = credits.applicable === null || credits.applicable > 0
  return (
    <div className='mt-2.5 flex items-center gap-2 border-t border-border/60 pt-2.5'>
      <span className='w-24 shrink-0 text-[12px] text-muted-foreground'>{t('providers.accounts.resetCredits')}</span>
      <span className='font-mono text-[12px] tabular-nums'>{credits.available}</span>
      <span className='ml-auto'>
        {credits.available === 0 ? (
          <span className='text-[12px] text-muted-foreground/60'>{t('providers.accounts.resetNone')}</span>
        ) : (
          <RButton
            variant='outline'
            icon='ri-restart-line'
            disabled={locked || !applies}
            title={applies ? undefined : t('providers.accounts.resetNotApplicable')}
            onClick={onUse}
          >
            {t('providers.accounts.resetUse')}
          </RButton>
        )}
      </span>
    </div>
  )
}

function AccountRow({
  account,
  kind,
  quota,
  extras,
  now,
  busy,
  editing,
  onToggle,
  onUseReset,
  onReauthenticate
}: {
  account: SubAccountWire
  kind: SeatKind
  quota: QuotaIndex
  extras: AccountExtras | undefined
  now: number
  busy: boolean
  editing: boolean
  onToggle: (id: string, next: boolean) => void
  onUseReset: (account: SubAccountWire) => void
  onReauthenticate?: (account: SubAccountWire) => void
}) {
  const { t } = useTranslation()
  const windows = quotaForAccount(quota, account.id)
  // "Max 20x", not "max": the stored plan cannot say which of two plans
  // the seat is on, and the meters below are a share of that plan.
  const plan = planLabel(kind, account.plan, account.rateLimitTier)
  const switchLabel = t('providers.accounts.toggleAccount', { account: accountLabel(account) })
  return (
    <div className={cn('px-4 py-3 transition-colors hover:bg-muted/50', account.enabled ? '' : 'opacity-45')}>
      <div className='flex items-center gap-2'>
        <span className='min-w-0 truncate text-xs font-medium' title={accountLabel(account)}>
          {accountLabel(account)}
        </span>
        {plan === null ? null : (
          <Pill tone='info' className='shrink-0 whitespace-nowrap'>
            {plan}
          </Pill>
        )}
        {windows.length === 0 ? null : (
          <span className='ml-auto shrink-0 whitespace-nowrap text-[12px] text-muted-foreground/70'>
            {t('providers.accounts.resetsIn')}
          </span>
        )}
      </div>
      {windows.map((row) => (
        <WindowLine key={`${row.window}-${row.scope}`} row={row} now={now} />
      ))}
      {extras === undefined || extras.resetCredits === null ? null : (
        <ResetLine credits={extras.resetCredits} locked={busy || editing} onUse={() => onUseReset(account)} />
      )}
      <div className='mt-2 flex items-center gap-2 text-[12px] text-muted-foreground'>
        <Pill tone={AUTH_STATUS_TONES[account.authStatus]} className='shrink-0 whitespace-nowrap'>
          {t(AUTH_STATUS_KEYS[account.authStatus])}
        </Pill>
        {account.authStatus !== 'invalid' || onReauthenticate === undefined ? null : (
          <RButton
            variant='outline'
            icon='ri-login-circle-line'
            disabled={busy || editing}
            onClick={() => onReauthenticate(account)}
          >
            {t('providers.accounts.reauthenticate')}
          </RButton>
        )}
        {/* Selection is independent of auth health and quota: an account
            stays signed in while excluded from routing. */}
        <span className='ml-auto flex items-center gap-1.5'>
          {t('providers.detail.routable')}
          {editing ? (
            <Toggle
              on={account.enabled}
              disabled={busy}
              label={switchLabel}
              onClick={() => onToggle(account.id, !account.enabled)}
            />
          ) : (
            <SwitchReading on={account.enabled} label={switchLabel} />
          )}
        </span>
      </div>
    </div>
  )
}

export function AccountsPanel({
  subscription,
  quota,
  accounts: extrasIndex,
  now,
  busy,
  editing,
  onToggle,
  onUseReset,
  onReauthenticated
}: {
  subscription: SubscriptionWire | undefined
  quota: QuotaIndex
  accounts: AccountExtrasIndex
  now: number
  /** A save or another action is out: all controls wait. */
  busy: boolean
  editing: boolean
  onToggle: (id: string, next: boolean) => void
  onUseReset: (account: SubAccountWire) => void
  onReauthenticated?: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [reauthenticating, setReauthenticating] = useState<SubAccountWire | null>(null)
  const closeReauthentication = useCallback(() => setReauthenticating(null), [])
  const accounts = subscription === undefined ? [] : subscription.accounts
  // A hand-added provider's plan strings follow no vendor convention, so
  // they are read without one.
  const kind: SeatKind = subscription === undefined || subscription.kind === 'other' ? null : subscription.kind
  return (
    // The divider and the 24px indent are the desktop two-column grid's;
    // on a phone the panel is the full width and lines up with the rest
    // of the page at 16px.
    <div className='border-border md:border-r'>
      <div className='px-4 pt-5 pb-2 md:px-6'>
        <h3 className='text-sm font-semibold'>{t('providers.accounts.title')}</h3>
      </div>
      {reauthenticating !== null && subscription !== undefined && (kind === 'claude' || kind === 'codex') ? (
        <ReauthenticateAccount
          key={reauthenticating.id}
          account={reauthenticating}
          kind={kind}
          providerName={subscription.providerName}
          now={now}
          onClose={closeReauthentication}
          onDone={onReauthenticated === undefined ? NO_RELOAD : onReauthenticated}
        />
      ) : null}
      {accounts.length === 0 ? (
        <div className='px-4 pb-5 text-[12px] text-muted-foreground md:px-6'>{t('providers.accounts.empty')}</div>
      ) : (
        <div className='pb-4 md:px-2'>
          {accounts.map((a) => (
            <AccountRow
              key={a.id}
              account={a}
              kind={kind}
              quota={quota}
              extras={extrasIndex.get(a.id)}
              now={now}
              busy={busy || reauthenticating !== null}
              editing={editing}
              onToggle={onToggle}
              onUseReset={onUseReset}
              onReauthenticate={kind === 'claude' || kind === 'codex' ? setReauthenticating : undefined}
            />
          ))}
        </div>
      )}
    </div>
  )
}
