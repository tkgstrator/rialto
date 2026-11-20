/**
 * The issued-token list at phone width.
 *
 * Nine columns do not become a narrower table; they become a row per
 * token that answers what a glance from a phone asks — which clients are
 * live, what each has cost and when it last called. Scope, token counts,
 * expiry and sorting stay on the desktop table and on each token's page,
 * one tap away.
 */

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { PhoneRow, Pill } from '@/components/rialto/primitives'
import { MoveTokenPicker } from '@/components/rialto/settings/access/MoveTokenPicker'
import type { MoveToken } from '@/components/rialto/settings/access/TokenFolderBrowser'
import { fmtAgo, fmtCount } from '@/lib/rialto/format'
import { type AccessTokenWire, sortTokens, TOKEN_STATE_PILL, tokenState } from '@/lib/rialto/settings/access-tokens'
import { fmtCost } from '@/lib/sessions/format'
import type { TokenFolder } from '@/shared/access-token-policy'

export function TokenListPhone({
  tokens,
  now,
  depth,
  folders,
  onMove
}: {
  tokens: AccessTokenWire[]
  now: number
  depth: number
  folders: readonly TokenFolder[]
  onMove?: MoveToken
}) {
  const { t } = useTranslation()
  // The desktop table's resting order: live credentials first.
  const sorted = useMemo(() => sortTokens(tokens, now), [tokens, now])
  return (
    <>
      {sorted.map((token) => {
        const state = tokenState(token, now)
        const dead = state !== 'active'
        return (
          <div
            key={token.id}
            className={dead ? 'opacity-60' : ''}
            style={{ paddingInlineStart: `${Math.min(depth, 5) * 0.75}rem` }}
          >
            <PhoneRow
              href={`/access-tokens/${encodeURIComponent(token.id)}`}
              primary={
                <span className='flex min-w-0 items-center gap-2'>
                  <span className='truncate font-medium'>{token.name}</span>
                  {dead ? (
                    <Pill tone={TOKEN_STATE_PILL[state].tone} className='shrink-0'>
                      {t(TOKEN_STATE_PILL[state].labelKey)}
                    </Pill>
                  ) : null}
                </span>
              }
              trailing={fmtCost(token.costUsd)}
              secondary={
                <>
                  <span className='truncate font-mono'>{token.prefix}</span>
                  <span className='shrink-0 font-mono tabular-nums'>
                    {t('settings.access.detailRequests', { n: fmtCount(token.requestCount) })}
                  </span>
                  <span className='ml-auto shrink-0 font-mono tabular-nums'>
                    {token.lastUsedAt === null
                      ? t('settings.access.never')
                      : t('settings.access.lastUsedAgo', { ago: fmtAgo(token.lastUsedAt, now) })}
                  </span>
                </>
              }
            />
            {onMove === undefined ? null : (
              <div className='px-4 pb-2'>
                <MoveTokenPicker token={token} folders={folders} onMove={onMove} />
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}
