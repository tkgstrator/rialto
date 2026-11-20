import { type ReactNode, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { scopePaths } from '@/components/rialto/activity/use-surfaces'
import { Pill, SurfaceScope } from '@/components/rialto/primitives'
import { MoveTokenPicker } from '@/components/rialto/settings/access/MoveTokenPicker'
import { type MoveToken, TOKEN_DRAG_TYPE } from '@/components/rialto/settings/access/TokenFolderBrowser'
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
import type { TokenFolder } from '@/shared/access-token-policy'

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

function Row({
  row,
  now,
  onOpen,
  depth,
  folders,
  onMove
}: {
  row: TokenRow
  now: number
  onOpen: () => void
  depth: number
  folders: readonly TokenFolder[]
  onMove?: MoveToken
}) {
  const { t } = useTranslation()
  const { token, state, surfacePaths } = row
  const dead = state !== 'active'
  return (
    <tr
      className={`border-t border-border/60 transition-colors ${dead ? 'opacity-60' : ''} ${onMove === undefined ? 'cursor-pointer hover:bg-muted/50' : 'cursor-grab'}`}
      tabIndex={onMove === undefined ? 0 : undefined}
      onClick={(event) => {
        if (onMove !== undefined || (event.target instanceof Element && event.target.closest('button, a'))) return
        onOpen()
      }}
      onKeyDown={(event) => {
        if (onMove === undefined && event.target === event.currentTarget && event.key === 'Enter') onOpen()
      }}
      draggable={onMove !== undefined}
      onDragStart={(event) => {
        if (onMove === undefined) return
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData(TOKEN_DRAG_TYPE, token.id)
      }}
    >
      <td className='py-2.5 pr-3' style={{ paddingInlineStart: `${1.5 + Math.min(depth, 5) * 0.75}rem` }}>
        <div className='flex items-center gap-2'>
          <span className='min-w-0 break-words text-xs font-medium'>{token.name}</span>
          {dead ? <Pill tone={TOKEN_STATE_PILL[state].tone}>{t(TOKEN_STATE_PILL[state].labelKey)}</Pill> : null}
        </div>
        <div className='break-all font-mono text-[12px] text-muted-foreground'>{token.prefix}</div>
        {onMove === undefined ? null : <MoveTokenPicker token={token} folders={folders} onMove={onMove} />}
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
      <td className='pl-3 pr-6 text-right font-mono text-[12px] tabular-nums text-muted-foreground'>
        {token.expiresAt === null ? t('settings.access.never') : token.expiresAt.slice(0, 10)}
      </td>
    </tr>
  )
}

export function TokenTable({
  tokens,
  surfaces,
  now,
  folders,
  onMove,
  renderTree
}: {
  tokens: AccessTokenWire[]
  surfaces: InboundSurfaceWire[]
  now: number
  folders: readonly TokenFolder[]
  onMove?: MoveToken
  renderTree: (renderTokens: (folderId: string | null, depth: number) => ReactNode) => ReactNode
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
  if (tokens.length === 0 && folders.length === 0) return null
  return (
    <table className='w-full min-w-[62rem] table-fixed'>
      <colgroup>
        <col />
        <col className='w-48' />
        <col className='w-20' />
        <col className='w-28' />
        <col className='w-20' />
        <col className='w-20' />
        <col className='w-28' />
        <col className='w-24' />
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
          <SortTh sortKey='expires' sort={sort} className='pl-3 pr-6 text-right' align='right'>
            {t('settings.access.colExpires')}
          </SortTh>
        </tr>
      </thead>
      <tbody>
        {renderTree((folderId, depth) =>
          sort.sorted
            .filter(({ token }) => (token.folderId === undefined ? null : token.folderId) === folderId)
            .map((row) => (
              <Row
                key={row.token.id}
                row={row}
                now={now}
                depth={depth}
                folders={folders}
                onMove={onMove}
                onOpen={() => navigate(`/access-tokens/${encodeURIComponent(row.token.id)}`)}
              />
            ))
        )}
      </tbody>
    </table>
  )
}
