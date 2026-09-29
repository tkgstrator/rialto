/**
 * One access token at phone width.
 *
 * What a phone is for here is the check and the emergency: is this client
 * still inside its plan, what has it been doing, and — if the secret has
 * leaked — rotate or revoke it now. Those stay, in that order. The scope,
 * profile and plan editors do not: each is a picker laid out beside a
 * paragraph of explanation, and a scope change reaches a live client as a
 * 401 nobody can trace from that end, which is not a change to make on a
 * 390px screen. They are read out as plain facts instead, and edited on
 * the same page at desktop width.
 */

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { scopePaths } from '@/components/rialto/activity/use-surfaces'
import { Mono, PhoneStats, Pill, RButton, Section, SurfacePill } from '@/components/rialto/primitives'
import { TokenUsageWindowsBody } from '@/components/rialto/settings/access/TokenUsageWindows'
import type { AccessTokenWire, InboundSurfaceWire, TokenUsageWindowsWire } from '@/lib/api'
import { fmtAgo, fmtCount } from '@/lib/rialto/format'
import { fmtTokenCount, TOKEN_STATE_PILL, type TokenState } from '@/lib/rialto/settings/access-tokens'
import type { UsageWindowsView } from '@/lib/rialto/settings/usage-windows'
import { fmtCost } from '@/lib/sessions/format'

/** A label and its value on one line, the value right-aligned so a column of them reads down one edge. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='flex items-baseline gap-3 border-t border-border/60 px-4 py-2.5 text-xs'>
      <span className='shrink-0 text-muted-foreground'>{label}</span>
      <span className='ml-auto flex min-w-0 flex-wrap justify-end gap-1 text-right'>{children}</span>
    </div>
  )
}

export function TokenDetailPhone({
  token,
  state,
  windows,
  usageBlocked,
  surfaces,
  now,
  busy,
  onRotate,
  onRevoke,
  onReset
}: {
  token: AccessTokenWire
  state: TokenState
  windows: UsageWindowsView
  usageBlocked: boolean
  surfaces: readonly InboundSurfaceWire[]
  now: number
  busy: boolean
  onRotate: () => void
  onRevoke: () => void
  onReset: (next: TokenUsageWindowsWire) => void
}) {
  const { t } = useTranslation()
  const pill = TOKEN_STATE_PILL[state]
  const paths = scopePaths(surfaces, token.surfaces)
  return (
    <>
      {/* The page header already names the token and leads back to the
          list, so this row carries only what the header cannot: the
          prefix, the state and the two actions. The pills sit under the
          prefix rather than beside it, which is what leaves room for both
          buttons to keep their labels. */}
      <div className='flex items-center gap-3 px-4 pt-4 pb-3'>
        <div className='min-w-0'>
          <div className='truncate font-mono text-[12px] text-muted-foreground'>{token.prefix}</div>
          <div className='mt-1 flex flex-wrap gap-1.5'>
            <Pill tone={pill.tone}>{t(pill.labelKey)}</Pill>
            {state === 'active' && usageBlocked ? <Pill tone='bad'>{t('access.token.usageBlocked')}</Pill> : null}
          </div>
        </div>
        <div className='ml-auto flex shrink-0 items-center gap-2'>
          {/* Absent on an expired token for the desktop header's reason:
              the server refuses to rotate one. */}
          {state === 'active' ? (
            <RButton variant='outline' icon='ri-refresh-line' onClick={onRotate} disabled={busy}>
              {t('settings.access.rotate')}
            </RButton>
          ) : null}
          <RButton variant='danger' icon='ri-forbid-line' onClick={onRevoke} disabled={busy}>
            {t('settings.access.revoke')}
          </RButton>
        </div>
      </div>

      <Section title={t('access.token.windows')}>
        <div className='px-4 pb-4'>
          <TokenUsageWindowsBody token={token} view={windows} now={now} onReset={onReset} />
        </div>
      </Section>

      <Section title={t('settings.access.detailUsage')}>
        <PhoneStats
          items={[
            {
              label: t('settings.access.colRequests'),
              value: fmtCount(token.requestCount),
              note: t('settings.access.detailTokens', {
                in: fmtTokenCount(token.inputTokens),
                out: fmtTokenCount(token.outputTokens)
              })
            },
            { label: t('settings.access.colCost'), value: fmtCost(token.costUsd) },
            {
              label: t('settings.access.colLastUsed'),
              value:
                token.lastUsedAt === null
                  ? t('settings.access.never')
                  : t('settings.access.lastUsedAgo', { ago: fmtAgo(token.lastUsedAt, now) })
            },
            {
              label: t('settings.access.colExpires'),
              value: token.expiresAt === null ? t('settings.access.never') : token.expiresAt.slice(0, 10)
            }
          ]}
        />
      </Section>

      <div className='pb-6'>
        <Fact label={t('settings.access.colEndpoint')}>
          {paths.length === 0 ? (
            <span className='text-muted-foreground'>{t('settings.access.allEndpoints')}</span>
          ) : (
            paths.map((path) => <SurfacePill key={path} path={path} />)
          )}
        </Fact>
        <Fact label={t('settings.access.colProfile')}>
          {token.profileKey === null ? (
            <span className='text-muted-foreground'>{t('settings.access.followEndpoint')}</span>
          ) : (
            <Mono className='text-foreground'>{token.profileKey}</Mono>
          )}
        </Fact>
        <Fact label={t('access.token.plan')}>
          {token.plan === null ? (
            <span className='text-muted-foreground'>{t('access.token.noPlan')}</span>
          ) : (
            token.plan.name
          )}
        </Fact>
        <Fact label={t('settings.access.detailLifetime')}>
          <span className='font-mono text-[12px] text-muted-foreground'>
            {t('settings.access.detailCreated', { date: token.createdAt.slice(0, 10) })}
            {token.rotatedAt === null
              ? ''
              : ` · ${t('settings.access.detailRotated', { date: token.rotatedAt.slice(0, 10) })}`}
          </span>
        </Fact>
      </div>
    </>
  )
}
