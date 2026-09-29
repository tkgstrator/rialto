/**
 * Access tokens — issue and list.
 *
 * Owns the one-time plaintext: it is held in component state only for as
 * long as the reveal dialog is open, and is never written anywhere it
 * could be read back. The list refreshes after issuing rather than being
 * patched locally, so `lastUsedAt` and `requestCount` cannot drift from
 * what the gate actually recorded.
 *
 * Issuing happens in a dialog over this list, in two steps — the form,
 * then the reveal. The table never moves for either.
 *
 * Rotate and revoke are not here. They live on a token's own page
 * (TokenDetail), reached by clicking its row — a destructive action
 * repeated once per row is an action aimed at the wrong row eventually.
 *
 * A revoked token is not listed at all: revoking deletes it. This table
 * answers "what can reach the proxy right now", and a revoked row never
 * could.
 */
import { useCallback, useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { scopePaths } from '@/components/rialto/activity/use-surfaces'
import { useConfirm } from '@/components/rialto/ConfirmDialog'
import { RButton } from '@/components/rialto/primitives'
import { IssuedTokenDialog } from '@/components/rialto/settings/access/IssuedTokenDialog'
import { emptyDraft, type IssueDraft, IssueTokenDialog } from '@/components/rialto/settings/access/IssueTokenDialog'
import { ANY, scopeForWire } from '@/components/rialto/settings/access/pickers'
import { TokenListPhone } from '@/components/rialto/settings/access/TokenListPhone'
import { TokenTable } from '@/components/rialto/settings/access/TokenTable'
import { SectionHead } from '@/components/rialto/settings/fields'
import { usePhone } from '@/hooks/use-phone'
import { type AccessTokenWire, api, type InboundSurfaceWire, type PlanWire } from '@/lib/api'
import { countTokens, expiryToIso, type TokenCounts } from '@/lib/rialto/settings/access-tokens'

interface Revealed {
  plaintext: string
  name: string
  scope: string
  profile: string
  expiry: string
}

/** "4 active · 1 expired · all /v1/*". */
function Summary({ counts }: { counts: TokenCounts }) {
  const { t } = useTranslation()
  return (
    <>
      {t('settings.access.countActive', { n: counts.active })}
      {counts.expired > 0 ? ` · ${t('settings.access.countExpired', { n: counts.expired })}` : ''}
      {' · '}
      <Trans i18nKey='settings.access.tokensScope' components={{ mono: <span className='font-mono' /> }} />
    </>
  )
}

export function AccessTokensSection({ surfaces }: { surfaces: InboundSurfaceWire[] }) {
  const { t } = useTranslation()
  const [tokens, setTokens] = useState<AccessTokenWire[]>([])
  const [profiles, setProfiles] = useState<{ key: string }[]>([])
  const [plans, setPlans] = useState<PlanWire[]>([])
  const [draft, setDraft] = useState<IssueDraft | null>(null)
  const [revealed, setRevealed] = useState<Revealed | null>(null)
  const [issuing, setIssuing] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [allReset, setAllReset] = useState(false)
  const { confirm, dialog: confirmDialog } = useConfirm()
  // Pinned per load so every relative label on the page measures from
  // the same instant, and so an expiry cannot flip mid-render.
  const [now, setNow] = useState(Date.now())
  const phone = usePhone()

  const load = useCallback(() => {
    api
      .getAccessTokens()
      .then((res) => {
        setTokens(res.tokens)
        setNow(Date.now())
      })
      .catch((e: Error) => toast.error(t('settings.access.listFailed', { message: e.message })))
  }, [t])

  useEffect(() => {
    load()
    api
      .getTierProfiles()
      .then(setProfiles)
      .catch(() => {
        // The picker falls back to "follow the endpoint", which is the
        // server's own default when profileKey is null.
      })
    api
      .getPlans()
      .then((res) => setPlans(res.plans))
      .catch(() => {
        // The plan picker then offers only "no plan", the old behaviour.
      })
  }, [load])

  const issue = () => {
    if (draft === null) return
    setIssuing(true)
    api
      .issueAccessToken({
        name: draft.name.trim(),
        surfaces: scopeForWire(surfaces, draft.surfaces),
        profileKey: draft.profileKey === ANY ? null : draft.profileKey,
        expiresAt: expiryToIso(draft.expiry, Date.now()),
        planId: draft.planId === ANY ? null : draft.planId
      })
      .then((res) => {
        const paths = scopePaths(surfaces, res.token.surfaces)
        setRevealed({
          plaintext: res.plaintext,
          name: res.token.name,
          scope: paths.length === 0 ? t('settings.access.allEndpoints') : paths.join(', '),
          profile: res.token.profileKey === null ? t('settings.access.followEndpoint') : res.token.profileKey,
          // The resolved date the server actually stored, not the form's
          // relative choice — the same reading rotate's reveal gives, so
          // the two summaries agree on what "Expires" means.
          expiry: res.token.expiresAt === null ? t('settings.access.never') : res.token.expiresAt.slice(0, 10)
        })
        setDraft(null)
        load()
      })
      .catch((e: Error) => toast.error(t('settings.access.issueFailed', { message: e.message })))
      .finally(() => setIssuing(false))
  }

  // Every token's usage windows at once. Asked first, because it hands
  // every limited client its full allowance back in one click. The answer
  // stays on the page as the line under the table rather than a toast:
  // nothing in the table changes (its totals are history), so the line is
  // the only place the reset shows at all.
  const resetAll = async () => {
    const confirmed = await confirm({
      title: t('access.token.resetAllTitle'),
      description: [
        { text: t('access.token.resetAllBody') },
        { text: t('access.token.resetAllWarning'), tone: 'destructive' },
        { text: t('access.token.resetAllKeeps') }
      ],
      confirmLabel: t('access.token.resetAll'),
      icon: 'ri-restart-line'
    })
    if (!confirmed) return
    setResetting(true)
    api
      .resetAllUsageWindows()
      .then(() => setAllReset(true))
      .catch((e: Error) => toast.error(t('access.token.resetFailed', { message: e.message })))
      .finally(() => setResetting(false))
  }

  const counts = countTokens(tokens, now)

  // The dialogs are shared by both layouts: issuing is one of the things
  // the phone list keeps.
  const dialogs = (
    <>
      {/* Both steps of issuing are modals over that table, and nothing
          above moves to make room for them. Naming a token is decided
          against the ones that already exist, and after issuing, the new
          row is the answer to "where did it go" — a panel that replaced
          the list took both away, and one that pushed it down asked the
          question with the answer scrolled off the page. */}
      {revealed !== null ? (
        <IssuedTokenDialog {...revealed} onDone={() => setRevealed(null)} />
      ) : draft !== null ? (
        <IssueTokenDialog
          draft={draft}
          surfaces={surfaces}
          profiles={profiles}
          plans={plans}
          issuing={issuing}
          onChange={setDraft}
          onSubmit={issue}
          onCancel={() => setDraft(null)}
        />
      ) : null}
      {confirmDialog}
    </>
  )

  if (phone) {
    return (
      <>
        <TokenListPhone
          tokens={tokens}
          now={now}
          summary={<Summary counts={counts} />}
          onIssue={() => setDraft(emptyDraft())}
        />
        {dialogs}
      </>
    )
  }

  return (
    <>
      {/* No title: the breadcrumb and the sidebar both say "Access
          tokens" already, and this is the whole screen rather than a
          section of one. */}
      <SectionHead
        meta={<Summary counts={counts} />}
        actions={
          <RButton variant='primary' icon='ri-add-line' onClick={() => setDraft(emptyDraft())}>
            {t('settings.access.issueToken')}
          </RButton>
        }
      />

      <div className='px-6 pb-4'>
        <div className='rounded-md border border-dashed border-border px-4 py-3 text-[12px] leading-relaxed text-muted-foreground'>
          <i className='ri-information-line mr-1 align-[-1px]' />
          <Trans
            i18nKey='settings.access.tokensNote'
            components={{ strong: <span className='font-medium text-foreground' /> }}
          />
        </div>
      </div>

      <TokenTable tokens={tokens} surfaces={surfaces} now={now} />

      {/* Quiet and below the table, away from Issue token: it acts on every
          token and plan at once, and the page's primary action should not
          sit beside it. The table keeps its
          historical columns; the current windows are on each token's page. */}
      <div className='flex items-center gap-3 border-t border-border/60 px-6 py-4'>
        <span className='text-[12px] text-muted-foreground'>
          {t(allReset ? 'access.token.allResetNote' : 'access.token.listWindowsNote')}
        </span>
        <div className='ml-auto shrink-0'>
          <RButton variant='ghost' icon='ri-restart-line' onClick={resetAll} disabled={resetting}>
            {t('access.token.resetAll')}
          </RButton>
        </div>
      </div>

      {dialogs}
    </>
  )
}
