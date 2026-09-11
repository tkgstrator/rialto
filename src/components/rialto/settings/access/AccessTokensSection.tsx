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
 * Rotate, revoke and delete are not here. They live on a token's own
 * page (TokenDetail), reached by clicking its row — a destructive action
 * repeated once per row is an action aimed at the wrong row eventually.
 *
 * Revoked rows are folded away rather than dropped. They are the only
 * thing keeping past RequestLog entries attributable to a client, so they
 * have to exist; but this table answers "what can reach the proxy right
 * now", and a dead row is never that. The count in the heading opens
 * them, because without a way back the Delete on a revoked token's page
 * would be reachable only by remembering its URL.
 */
import { useCallback, useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { RButton } from '@/components/rialto/primitives'
import { IssuedTokenDialog } from '@/components/rialto/settings/access/IssuedTokenDialog'
import { emptyDraft, type IssueDraft, IssueTokenDialog } from '@/components/rialto/settings/access/IssueTokenDialog'
import { ANY } from '@/components/rialto/settings/access/pickers'
import { TokenTable } from '@/components/rialto/settings/access/TokenTable'
import { SectionHead } from '@/components/rialto/settings/fields'
import { type AccessTokenWire, api, type InboundSurfaceWire } from '@/lib/api'
import { countTokens, expiryToIso, type TokenCounts, tokenState } from '@/lib/rialto/settings/access-tokens'

interface Revealed {
  plaintext: string
  name: string
  scope: string
  profile: string
  expiry: string
}

/**
 * "4 active · 1 revoked · all /v1/*", where the revoked count is the
 * control that unfolds those rows. A plain label there would leave them
 * unreachable, and a separate toggle would spend a control on a state
 * most installs never look at.
 */
function Summary({
  counts,
  showRevoked,
  onToggleRevoked
}: {
  counts: TokenCounts
  showRevoked: boolean
  onToggleRevoked: () => void
}) {
  const { t } = useTranslation()
  return (
    <>
      {t('settings.access.countActive', { n: counts.active })}
      {counts.expired > 0 ? ` · ${t('settings.access.countExpired', { n: counts.expired })}` : ''}
      {counts.revoked > 0 ? (
        <>
          {' · '}
          <button
            type='button'
            onClick={onToggleRevoked}
            className='underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground'
          >
            {t(showRevoked ? 'settings.access.hideRevoked' : 'settings.access.countRevoked', { n: counts.revoked })}
          </button>
        </>
      ) : null}
      {' · '}
      <Trans i18nKey='settings.access.tokensScope' components={{ mono: <span className='font-mono' /> }} />
    </>
  )
}

export function AccessTokensSection({ surfaces }: { surfaces: InboundSurfaceWire[] }) {
  const { t } = useTranslation()
  const [tokens, setTokens] = useState<AccessTokenWire[]>([])
  const [profiles, setProfiles] = useState<{ key: string }[]>([])
  const [draft, setDraft] = useState<IssueDraft | null>(null)
  const [revealed, setRevealed] = useState<Revealed | null>(null)
  const [issuing, setIssuing] = useState(false)
  const [showRevoked, setShowRevoked] = useState(false)
  // Pinned per load so every relative label on the page measures from
  // the same instant, and so an expiry cannot flip mid-render.
  const [now, setNow] = useState(Date.now())

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
      .get<{ profiles: { key: string }[] }>('/router-preferences/profiles')
      .then((res) => setProfiles(res.profiles))
      .catch(() => {
        // The picker falls back to "follow the endpoint", which is the
        // server's own default when profileKey is null.
      })
  }, [load])

  const issue = () => {
    if (draft === null) return
    setIssuing(true)
    // Resolve the picker's strings back through the fetched list rather
    // than asserting them into SurfaceIds: every id is then one the
    // server itself reported, so an unknown value cannot reach the wire.
    const picked = surfaces.filter((s) => draft.surfaces.includes(s.id)).map((s) => s.id)
    api
      .issueAccessToken({
        name: draft.name.trim(),
        surfaces: picked,
        profileKey: draft.profileKey === ANY ? null : draft.profileKey,
        expiresAt: expiryToIso(draft.expiry, Date.now())
      })
      .then((res) => {
        const paths = res.token.surfaces.flatMap((id) => {
          const found = surfaces.find((s) => s.id === id)
          return found === undefined ? [] : [found.path]
        })
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

  const counts = countTokens(tokens, now)
  const listed = showRevoked ? tokens : tokens.filter((token) => tokenState(token, now) !== 'revoked')

  return (
    <>
      {/* No title: the breadcrumb and the sidebar both say "Access
          tokens" already, and this is the whole screen rather than a
          section of one. */}
      <SectionHead
        meta={
          <Summary counts={counts} showRevoked={showRevoked} onToggleRevoked={() => setShowRevoked(!showRevoked)} />
        }
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

      <TokenTable tokens={listed} surfaces={surfaces} now={now} />

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
          issuing={issuing}
          onChange={setDraft}
          onSubmit={issue}
          onCancel={() => setDraft(null)}
        />
      ) : null}
    </>
  )
}
