import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { scopePaths } from '@/components/rialto/activity/use-surfaces'
import { Pill, SurfaceScope } from '@/components/rialto/primitives'
import { SortTh, type SortValue, useTableSort } from '@/components/rialto/table-sort'
import { Button } from '@/components/ui/button'
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

interface TokenRow {
  token: AccessTokenWire
  state: TokenState
  surfacePaths: string[]
}

type TokenSortKey = 'name' | 'surface' | 'requests' | 'cost' | 'inputTokens' | 'outputTokens' | 'lastUsed' | 'expires'

const tokenSortValue = (row: TokenRow, key: TokenSortKey): SortValue => {
  if (key === 'name') return row.token.name
  if (key === 'surface') return row.surfacePaths.length === 0 ? null : row.surfacePaths.join(' ')
  if (key === 'requests') return row.token.requestCount
  if (key === 'cost') return row.token.costUsd
  if (key === 'inputTokens') return row.token.inputTokens
  if (key === 'outputTokens') return row.token.outputTokens
  if (key === 'lastUsed') return row.token.lastUsedAt === null ? null : Date.parse(row.token.lastUsedAt)
  // null expiry means "never" — the furthest-out value, not an absent one.
  return row.token.expiresAt === null ? Number.POSITIVE_INFINITY : Date.parse(row.token.expiresAt)
}

function Row({ row, now, onOpen }: { row: TokenRow; now: number; onOpen: () => void }) {
  const { t } = useTranslation()
  const { token, state, surfacePaths } = row
  const dead = state !== 'active'
  return (
    <tr className={`border-t border-border/60 ${dead ? 'opacity-60' : ''}`}>
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
      <td className='px-3 text-right font-mono text-[12px] tabular-nums text-muted-foreground'>
        {token.lastUsedAt === null
          ? t('settings.access.never')
          : t('settings.access.lastUsedAgo', { ago: fmtAgo(token.lastUsedAt, now) })}
      </td>
      <td className='px-3 text-right font-mono text-[12px] tabular-nums text-muted-foreground'>
        {token.expiresAt === null ? t('settings.access.never') : token.expiresAt.slice(0, 10)}
      </td>
      <td className='py-2.5 pr-6 text-right'>
        <Button
          type='button'
          variant='outline'
          size='icon-sm'
          aria-label={t('settings.access.openToken', { name: token.name })}
          onClick={onOpen}
        >
          <i aria-hidden className='ri-arrow-right-s-line text-base' />
        </Button>
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
  const rows = useMemo(
    () =>
      sortTokens(tokens, now).map((token) => ({
        token,
        state: tokenState(token, now),
        surfacePaths: scopePaths(surfaces, token.surfaces)
      })),
    [tokens, surfaces, now]
  )
  const sort = useTableSort<TokenRow, TokenSortKey>(rows, tokenSortValue)
  if (tokens.length === 0) return null
  return (
    <table className='w-full table-fixed'>
      <colgroup>
        <col />
        <col className='w-48' />
        <col className='w-20' />
        <col className='w-28' />
        <col className='w-20' />
        <col className='w-20' />
        <col className='w-28' />
        <col className='w-24' />
        <col className='w-14' />
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
