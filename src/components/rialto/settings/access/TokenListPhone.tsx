/**
 * The issued-token list at phone width.
 *
 * Nine columns do not become a narrower table; they become a row per
 * token that answers what a glance from a phone asks — which clients are
 * live, what each has cost and when it last called. Scope, token counts,
 * expiry and sorting stay on the desktop table and on each token's page,
 * one tap away.
 *
 * Issue token stays: handing a new machine a credential is a thing done
 * from wherever the machine is, and the dialog is a single column. The
 * reset-everyone control and the explainer note do not — one is a bulk
 * action that belongs beside the whole table, the other a paragraph that
 * pushed the first token below the fold.
 */

import type { ReactNode } from 'react'
import { useMemo } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { PhoneRow, Pill, RButton } from '@/components/rialto/primitives'
import { WarnNotice } from '@/components/rialto/settings/notice'
import { fmtAgo, fmtCount } from '@/lib/rialto/format'
import { type AccessTokenWire, sortTokens, TOKEN_STATE_PILL, tokenState } from '@/lib/rialto/settings/access-tokens'
import { fmtCost } from '@/lib/sessions/format'

export function TokenListPhone({
  tokens,
  now,
  summary,
  onIssue
}: {
  tokens: AccessTokenWire[]
  now: number
  summary: ReactNode
  onIssue: () => void
}) {
  const { t } = useTranslation()
  // The desktop table's resting order: live credentials first.
  const sorted = useMemo(() => sortTokens(tokens, now), [tokens, now])
  return (
    <>
      <div className='flex items-center gap-3 px-4 pt-4 pb-3'>
        <span className='min-w-0 text-[12px] text-muted-foreground'>{summary}</span>
        <RButton variant='primary' icon='ri-add-line' onClick={onIssue} className='ml-auto shrink-0'>
          {t('settings.access.issueToken')}
        </RButton>
      </div>
      {tokens.length === 0 ? (
        // Same warning as the desktop empty state: with no token the proxy
        // accepts nothing, which is not a neutral empty list.
        <div className='px-4 pb-6'>
          <WarnNotice title={t('settings.access.noTokensTitle')} tag={t('settings.access.noTokensTag')}>
            <Trans i18nKey='settings.access.noTokensBody' components={{ mono: <span className='font-mono' /> }} />
          </WarnNotice>
        </div>
      ) : (
        sorted.map((token) => {
          const state = tokenState(token, now)
          const dead = state !== 'active'
          return (
            <div key={token.id} className={dead ? 'opacity-60' : ''}>
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
            </div>
          )
        })
      )}
    </>
  )
}
