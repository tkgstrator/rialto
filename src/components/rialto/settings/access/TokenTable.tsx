/**
 * The issued-token list.
 *
 * Revoke and delete are deliberately not the same control. Revoking
 * keeps the row, so RequestLog entries that reference this token still
 * resolve to a name and Activity can still say whose traffic a request
 * was. Deleting drops the row and that attribution goes with it — so
 * revoke is the plain action, and delete appears only once a row is
 * already revoked — by which point it changes nothing about access and
 * only trades away the audit trail.
 */
import { useMemo } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Pill, SurfacePill } from '@/components/rialto/primitives'
import { WarnNotice } from '@/components/rialto/settings/notice'
import { SortTh, type SortValue, useTableSort } from '@/components/rialto/table-sort'
import type { InboundSurfaceWire } from '@/lib/api'
import { fmtAgo, fmtCount } from '@/lib/rialto/format'
import { type AccessTokenWire, sortTokens, type TokenState, tokenState } from '@/lib/rialto/settings/access-tokens'
import { fmtCost } from '@/lib/sessions/format'

const STATE_PILL: Record<TokenState, { tone: 'ok' | 'warn' | 'bad'; labelKey: string }> = {
  active: { tone: 'ok', labelKey: 'settings.access.tokenActive' },
  expired: { tone: 'warn', labelKey: 'settings.access.tokenExpired' },
  revoked: { tone: 'bad', labelKey: 'settings.access.tokenRevoked' }
}

/**
 * A row with everything the cells print already resolved. The surface
 * path in particular is looked up once here rather than at sort time, so
 * the Endpoint column cannot order by one string and render another.
 */
interface TokenRow {
  token: AccessTokenWire
  state: TokenState
  /** Undefined when the token is scoped to every surface, not just one. */
  surfacePath: string | undefined
}

/**
 * Row actions are buttons, not bare text.
 *
 * They used to be an 11px link with no box, which read as a caption
 * rather than a control and sat on its own text baseline — a different
 * height from every other cell in the row. A fixed 28px box inside a
 * flex cell takes the height off the line box entirely, so the control
 * lines up with the row whatever the cell beside it renders.
 *
 * Destructive styling is on hover only: both actions are destructive, and
 * painting two of them red in every row makes the table look like an
 * error state rather than a list of working credentials.
 */
const ROW_ACTION =
  'inline-flex h-7 items-center rounded-md border border-border px-2.5 text-[12px] font-medium text-muted-foreground transition-colors hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive disabled:pointer-events-none disabled:opacity-50'

type TokenSortKey = 'name' | 'surface' | 'profile' | 'requests' | 'cost' | 'lastUsed' | 'expires'

/**
 * Each column sorts on the value behind its own cell. The two date
 * columns compare the parsed instant rather than the "3h ago" / date
 * text, which orders identically without depending on the wording.
 *
 * Nulls are passed through instead of being filled in: "never used" and
 * "no expiry" are absent values, not zero and not a date, and the table
 * puts absent values last in both directions.
 */
const tokenSortValue = (row: TokenRow, key: TokenSortKey): SortValue => {
  if (key === 'name') return row.token.name
  if (key === 'surface') return row.surfacePath
  if (key === 'profile') return row.token.profileKey
  if (key === 'requests') return row.token.requestCount
  // Unpriced traffic is a null, not a zero — it sorts last in both
  // directions rather than claiming the token was free.
  if (key === 'cost') return row.token.costUsd
  if (key === 'lastUsed') return row.token.lastUsedAt === null ? null : Date.parse(row.token.lastUsedAt)
  // A null expiry is "never", which is not a missing value — it is the
  // furthest-out one there is. Passing null would park the permanent
  // tokens at the bottom of a descending sort, where the operator asked
  // for exactly them. A null `lastUsedAt` above really is absent (the
  // token has not been used), so that one stays null and sorts last.
  return row.token.expiresAt === null ? Number.POSITIVE_INFINITY : Date.parse(row.token.expiresAt)
}

function Row({
  row,
  now,
  onRevoke,
  onDelete,
  busy
}: {
  row: TokenRow
  now: number
  onRevoke: () => void
  onDelete: () => void
  busy: boolean
}) {
  const { t } = useTranslation()
  const { token, state, surfacePath } = row
  const dead = state !== 'active'
  return (
    <tr className={`border-t border-border/60 transition-colors hover:bg-muted/50 ${dead ? 'opacity-60' : ''}`}>
      <td className='py-2.5 pl-6 pr-3'>
        <div className='flex items-center gap-2'>
          <span className='text-xs font-medium'>{token.name}</span>
          {dead ? <Pill tone={STATE_PILL[state].tone}>{t(STATE_PILL[state].labelKey)}</Pill> : null}
        </div>
        <div className='font-mono text-[12px] text-muted-foreground'>{token.prefix}</div>
      </td>
      <td className='px-3'>
        {surfacePath === undefined ? (
          <span className='text-[12px] text-muted-foreground/50'>{t('settings.access.scopeAll')}</span>
        ) : (
          <SurfacePill path={surfacePath} />
        )}
      </td>
      <td className='px-3 font-mono text-[12px] text-muted-foreground'>
        {token.profileKey === null ? '—' : token.profileKey}
      </td>
      <td className='px-3 text-right font-mono text-xs tabular-nums'>{fmtCount(token.requestCount)}</td>
      <td className='px-3 text-right font-mono text-xs tabular-nums'>{fmtCost(token.costUsd)}</td>
      <td className='px-3 text-right text-[12px] text-muted-foreground'>
        {token.lastUsedAt === null
          ? t('settings.access.never')
          : t('settings.access.lastUsedAgo', { ago: fmtAgo(token.lastUsedAt, now) })}
      </td>
      <td className='px-3 text-right text-[12px] text-muted-foreground'>
        {token.expiresAt === null ? t('settings.access.never') : token.expiresAt.slice(0, 10)}
      </td>
      <td className='py-2.5 pl-3 pr-6'>
        <div className='flex justify-end'>
          {state === 'revoked' ? (
            <button type='button' onClick={onDelete} disabled={busy} className={ROW_ACTION}>
              {t('settings.access.delete')}
            </button>
          ) : (
            <button type='button' onClick={onRevoke} disabled={busy} className={ROW_ACTION}>
              {t('settings.access.revoke')}
            </button>
          )}
        </div>
      </td>
    </tr>
  )
}

export function TokenTable({
  tokens,
  surfaces,
  now,
  busyId,
  onRevoke,
  onDelete
}: {
  tokens: AccessTokenWire[]
  surfaces: InboundSurfaceWire[]
  now: number
  busyId: string | null
  onRevoke: (token: AccessTokenWire) => void
  onDelete: (token: AccessTokenWire) => void
}) {
  const { t } = useTranslation()
  // Hooks run before the empty-state return: an early return above a hook
  // changes the hook order between renders.
  //
  // `sortTokens` stays the incoming order, which makes it the order the
  // table falls back to when a column is cycled off — live credentials
  // first is a better resting state than whatever the API returned.
  const rows = useMemo(
    () =>
      sortTokens(tokens, now).map((token) => ({
        token,
        state: tokenState(token, now),
        surfacePath: surfaces.find((s) => s.id === token.surface)?.path
      })),
    [tokens, surfaces, now]
  )
  const sort = useTableSort<TokenRow, TokenSortKey>(rows, tokenSortValue)
  if (tokens.length === 0) {
    // Not a neutral empty list: with no token issued the proxy accepts
    // nothing, so this is the difference between a working gateway and
    // a dead one and has to read that way.
    return (
      <div className='px-6 pb-6'>
        <WarnNotice title={t('settings.access.noTokensTitle')} tag={t('settings.access.noTokensTag')}>
          <Trans i18nKey='settings.access.noTokensBody' components={{ mono: <span className='font-mono' /> }} />
        </WarnNotice>
      </div>
    )
  }
  return (
    <table className='w-full table-fixed'>
      <colgroup>
        <col />
        <col className='w-40' />
        <col className='w-24' />
        <col className='w-20' />
        {/* Wide enough that "Cost 30d" stays on one line — a header that
            wraps makes the whole row two lines tall next to tables whose
            headers are one. */}
        <col className='w-28' />
        <col className='w-28' />
        <col className='w-24' />
        {/* Wide enough for the action button's box rather than its text. */}
        <col className='w-28' />
      </colgroup>
      <thead>
        <tr className='text-[12px] uppercase tracking-wider text-muted-foreground/70 [&>th]:h-9 [&>th]:whitespace-nowrap [&>th]:align-bottom [&>th]:pb-2'>
          <SortTh sortKey='name' sort={sort} className='pl-6 pr-3 text-left'>
            {t('settings.access.colToken')}
          </SortTh>
          <SortTh sortKey='surface' sort={sort} className='px-3 text-left'>
            {t('settings.access.colEndpoint')}
          </SortTh>
          <SortTh sortKey='profile' sort={sort} className='px-3 text-left'>
            {t('settings.access.colProfile')}
          </SortTh>
          <SortTh sortKey='requests' sort={sort} className='px-3 text-right' align='right'>
            {t('settings.access.colRequests')}
          </SortTh>
          <SortTh sortKey='cost' sort={sort} className='whitespace-nowrap px-3 text-right' align='right'>
            {t('settings.access.colCost')}
          </SortTh>
          <SortTh sortKey='lastUsed' sort={sort} className='whitespace-nowrap px-3 text-right' align='right'>
            {t('settings.access.colLastUsed')}
          </SortTh>
          <SortTh sortKey='expires' sort={sort} className='px-3 text-right' align='right'>
            {t('settings.access.colExpires')}
          </SortTh>
          {/* Revoke / delete: a control, not a value to order by. */}
          <th className='pl-3 pr-6' />
        </tr>
      </thead>
      <tbody>
        {sort.sorted.map((row) => (
          <Row
            key={row.token.id}
            row={row}
            now={now}
            busy={busyId === row.token.id}
            onRevoke={() => onRevoke(row.token)}
            onDelete={() => onDelete(row.token)}
          />
        ))}
      </tbody>
    </table>
  )
}
