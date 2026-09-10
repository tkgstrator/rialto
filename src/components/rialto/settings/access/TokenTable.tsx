/**
 * The issued-token list.
 *
 * A directory, not a control panel: every row leads to the token's own
 * page and nothing here changes what a token can do. Revoke used to be a
 * button in each row, which put an irreversible action — one that takes
 * a client offline with a 401 nobody can trace from the client end — one
 * mis-aimed click from every row on the screen. It lives on the detail
 * page now, next to the usage figures that inform the decision.
 */
import { useMemo } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Pill, SurfaceScope } from '@/components/rialto/primitives'
import { WarnNotice } from '@/components/rialto/settings/notice'
import { SortTh, type SortValue, useTableSort } from '@/components/rialto/table-sort'
import type { InboundSurfaceWire } from '@/lib/api'
import { fmtAgo, fmtCount } from '@/lib/rialto/format'
import {
  type AccessTokenWire,
  fmtTokenCount,
  sortTokens,
  TOKEN_STATE_PILL,
  type TokenState,
  tokenState
} from '@/lib/rialto/settings/access-tokens'
import { fmtCost } from '@/lib/sessions/format'

/**
 * A row with everything the cells print already resolved. The surface
 * path in particular is looked up once here rather than at sort time, so
 * the Endpoint column cannot order by one string and render another.
 */
interface TokenRow {
  token: AccessTokenWire
  state: TokenState
  /** Resolved display paths. Empty when the token may call every surface. */
  surfacePaths: string[]
}

type TokenSortKey = 'name' | 'surface' | 'requests' | 'cost' | 'inputTokens' | 'outputTokens' | 'lastUsed' | 'expires'

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
  // Ordered by the joined paths so the column sorts on what it draws:
  // the first pill decides, and a longer scope tie-breaks after it.
  if (key === 'surface') return row.surfacePaths.length === 0 ? null : row.surfacePaths.join(' ')
  if (key === 'requests') return row.token.requestCount
  // Unpriced traffic is a null, not a zero — it sorts last in both
  // directions rather than claiming the token was free.
  if (key === 'cost') return row.token.costUsd
  // Same null-is-absent rule as cost, for a different reason: a token
  // with no rows left in the window has no count to compare, and zero
  // would rank it below a token that genuinely moved nothing.
  if (key === 'inputTokens') return row.token.inputTokens
  if (key === 'outputTokens') return row.token.outputTokens
  if (key === 'lastUsed') return row.token.lastUsedAt === null ? null : Date.parse(row.token.lastUsedAt)
  // A null expiry is "never", which is not a missing value — it is the
  // furthest-out one there is. Passing null would park the permanent
  // tokens at the bottom of a descending sort, where the operator asked
  // for exactly them. A null `lastUsedAt` above really is absent (the
  // token has not been used), so that one stays null and sorts last.
  return row.token.expiresAt === null ? Number.POSITIVE_INFINITY : Date.parse(row.token.expiresAt)
}

function Row({ row, now, onOpen }: { row: TokenRow; now: number; onOpen: () => void }) {
  const { t } = useTranslation()
  const { token, state, surfacePaths } = row
  const dead = state !== 'active'
  return (
    <tr
      className={`cursor-pointer border-t border-border/60 transition-colors hover:bg-muted/50 ${dead ? 'opacity-60' : ''}`}
      onClick={onOpen}
    >
      <td className='py-2.5 pl-6 pr-3'>
        <div className='flex items-center gap-2'>
          <span className='text-xs font-medium'>{token.name}</span>
          {dead ? <Pill tone={TOKEN_STATE_PILL[state].tone}>{t(TOKEN_STATE_PILL[state].labelKey)}</Pill> : null}
        </div>
        <div className='font-mono text-[12px] text-muted-foreground'>{token.prefix}</div>
      </td>
      <td className='px-3'>
        <SurfaceScope paths={surfacePaths} allLabel={t('settings.access.scopeAll')} />
      </td>
      <td className='px-3 text-right font-mono text-xs tabular-nums'>{fmtCount(token.requestCount)}</td>
      <td className='px-3 text-right font-mono text-xs tabular-nums'>{fmtCost(token.costUsd)}</td>
      <td className='px-3 text-right font-mono text-xs tabular-nums'>{fmtTokenCount(token.inputTokens)}</td>
      <td className='px-3 text-right font-mono text-xs tabular-nums'>{fmtTokenCount(token.outputTokens)}</td>
      {/* Dates and durations are numbers: mono and tabular so the column
          lines up. In the proportional face "3h ago" and "41d ago" are
          different widths and cannot be compared down the column. */}
      <td className='px-3 text-right font-mono text-[12px] tabular-nums text-muted-foreground'>
        {token.lastUsedAt === null
          ? t('settings.access.never')
          : t('settings.access.lastUsedAgo', { ago: fmtAgo(token.lastUsedAt, now) })}
      </td>
      <td className='px-3 text-right font-mono text-[12px] tabular-nums text-muted-foreground'>
        {token.expiresAt === null ? t('settings.access.never') : token.expiresAt.slice(0, 10)}
      </td>
      {/* Where revoke used to sit. A chevron says the row leads
          somewhere without offering an action the operator can trigger
          by aiming badly. */}
      <td className='py-2.5 pl-3 pr-6'>
        <div className='flex justify-end text-muted-foreground/50'>
          <i className='ri-arrow-right-s-line text-base' />
        </div>
      </td>
    </tr>
  )
}

export function TokenTable({
  tokens,
  surfaces,
  now
}: {
  tokens: AccessTokenWire[]
  surfaces: InboundSurfaceWire[]
  now: number
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
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
        surfacePaths: token.surfaces.flatMap((id) => {
          const found = surfaces.find((s) => s.id === id)
          return found === undefined ? [] : [found.path]
        })
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
        {/* Wider now that it may hold a pill plus an overflow count. */}
        <col className='w-48' />
        <col className='w-20' />
        {/* Wide enough that "Cost 30d" stays on one line — a header that
            wraps makes the whole row two lines tall next to tables whose
            headers are one. */}
        <col className='w-28' />
        {/* In / Out: same width as Requests. `fmtTokens` caps at "18.4M",
            so these never need the room "Cost 30d" does. */}
        <col className='w-20' />
        <col className='w-20' />
        <col className='w-28' />
        <col className='w-24' />
        {/* Just the chevron now that the row actions have moved to the
            token's own page. */}
        <col className='w-10' />
      </colgroup>
      <thead>
        <tr className='text-[12px] uppercase tracking-wider text-muted-foreground/70 [&>th]:h-9 [&>th]:whitespace-nowrap [&>th]:align-bottom [&>th]:pb-2'>
          <SortTh sortKey='name' sort={sort} className='pl-6 pr-3 text-left'>
            {t('settings.access.colToken')}
          </SortTh>
          <SortTh sortKey='surface' sort={sort} className='px-3 text-left'>
            {t('settings.access.colEndpoint')}
          </SortTh>
          <SortTh sortKey='requests' sort={sort} className='px-3 text-right' align='right'>
            {t('settings.access.colRequests')}
          </SortTh>
          <SortTh sortKey='cost' sort={sort} className='whitespace-nowrap px-3 text-right' align='right'>
            {t('settings.access.colCost')}
          </SortTh>
          <SortTh sortKey='inputTokens' sort={sort} className='whitespace-nowrap px-3 text-right' align='right'>
            {t('settings.access.colInputTokens')}
          </SortTh>
          <SortTh sortKey='outputTokens' sort={sort} className='whitespace-nowrap px-3 text-right' align='right'>
            {t('settings.access.colOutputTokens')}
          </SortTh>
          <SortTh sortKey='lastUsed' sort={sort} className='whitespace-nowrap px-3 text-right' align='right'>
            {t('settings.access.colLastUsed')}
          </SortTh>
          <SortTh sortKey='expires' sort={sort} className='px-3 text-right' align='right'>
            {t('settings.access.colExpires')}
          </SortTh>
          {/* The chevron: an affordance, not a value to order by. */}
          <th className='pl-3 pr-6' />
        </tr>
      </thead>
      <tbody>
        {sort.sorted.map((row) => (
          <Row
            key={row.token.id}
            row={row}
            now={now}
            onOpen={() => navigate(`/access-tokens/${encodeURIComponent(row.token.id)}`)}
          />
        ))}
      </tbody>
    </table>
  )
}
