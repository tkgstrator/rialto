/**
 * Activity › Usage at phone width.
 *
 * The windows keep every account and every window — how close each one
 * is to its limit is the question this screen is opened for on a phone —
 * but a window line loses its separate scope column and the
 * API-equivalent block under each account. The desktop line spends 360px
 * on fixed columns, which left a 390px screen a meter 30px long.
 *
 * The per-token table becomes a list: who spent it and how much, with
 * the prefix, request count, share and last use beneath.
 */
import { useTranslation } from 'react-i18next'
import type {
  AccountWindows,
  ProviderWindows,
  TokenUsageRow,
  WindowRow
} from '@/components/rialto/activity/usage-derive'
import { Meter, PhoneRow, Pill } from '@/components/rialto/primitives'
import { fmtAgo, fmtCount, fmtUntil } from '@/lib/rialto/format'
import { fmtCost } from '@/lib/sessions/format'

function PhoneWindowLine({ row, now }: { row: WindowRow; now: number }) {
  const { t } = useTranslation()
  const until = fmtUntil(row.resetsAt, now)
  return (
    <div className='flex items-center gap-3 px-4 py-1.5'>
      {/* Scope in place of the scoped label's "model": at 6rem the label
          ate the column and "7-day · model …" hid which model it was.
          Every scoped window is a weekly one (see usage-windows). */}
      <span className='w-24 shrink-0 truncate text-[12px]'>
        {row.scope === null ? row.label : `${t('activity.usage.windowSevenDay')} · ${row.scope}`}
      </span>
      <div className='min-w-0 flex-1'>
        <Meter pct={row.pct} />
      </div>
      <span className='w-9 shrink-0 text-right font-mono text-[12px] tabular-nums'>{`${Math.round(row.pct)}%`}</span>
      {/* "due" rather than the full sentence the desktop line has room
          for: the column is 3.5rem, and the sentence wrapped to four lines. */}
      <span className='w-14 shrink-0 truncate text-right font-mono text-[12px] tabular-nums text-muted-foreground'>
        {until === null ? t('overview.resetsDueShort') : until}
      </span>
    </div>
  )
}

function PhoneAccountBlock({ account, now }: { account: AccountWindows; now: number }) {
  return (
    <div className='border-t border-border/60 py-2'>
      <div className='flex items-baseline gap-2 px-4 pb-1'>
        <span className='min-w-0 truncate text-xs font-medium'>{account.account}</span>
        {account.plan === null ? null : <Pill tone='info'>{account.plan}</Pill>}
      </div>
      {account.windows.map((row) => (
        <PhoneWindowLine key={`${row.label}-${row.scope}`} row={row} now={now} />
      ))}
    </div>
  )
}

/** One provider's accounts, under its name, one account per row. */
export function ProviderGroupPhone({ group, now }: { group: ProviderWindows; now: number }) {
  const { t } = useTranslation()
  return (
    <div className='pt-3 first:pt-0'>
      <div className='flex items-center gap-2 px-4 pb-2'>
        <span className='truncate text-[12px] font-semibold uppercase tracking-wider text-muted-foreground'>
          {group.label}
        </span>
        <span className='shrink-0 text-[12px] text-muted-foreground/70'>
          {t('activity.usage.accountCount', { count: group.accounts.length })}
        </span>
      </div>
      {group.accounts.map((account) => (
        <PhoneAccountBlock key={account.subAccountId} account={account} now={now} />
      ))}
    </div>
  )
}

export function TokenRowsPhone({ rows, now }: { rows: TokenUsageRow[]; now: number }) {
  const { t } = useTranslation()
  return (
    <div>
      {rows.map((row) => {
        const revoked = row.kind === 'revoked'
        return (
          <PhoneRow
            key={row.id}
            href={revoked ? undefined : `/access-tokens/${encodeURIComponent(row.id)}`}
            primary={
              revoked ? (
                <span className='font-medium text-muted-foreground'>{t('activity.usage.revokedTokens')}</span>
              ) : (
                <span className='font-medium'>{row.name}</span>
              )
            }
            trailing={fmtCost(row.costUsd)}
            secondary={
              <>
                {revoked ? null : <span className='shrink-0 font-mono'>{row.prefix}</span>}
                <span className='shrink-0 font-mono tabular-nums'>
                  {t('settings.access.detailRequests', { n: fmtCount(row.requestCount) })}
                </span>
                <span className='shrink-0 font-mono tabular-nums'>
                  {row.sharePct === null ? '–' : `${row.sharePct}%`}
                </span>
                <span className='ml-auto shrink-0 font-mono tabular-nums'>
                  {revoked ? '–' : row.lastUsedAt === null ? t('settings.access.never') : fmtAgo(row.lastUsedAt, now)}
                </span>
              </>
            }
          />
        )
      })}
    </div>
  )
}
