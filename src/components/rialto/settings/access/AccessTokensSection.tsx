/**
 * Access tokens — issue and list.
 *
 * Owns the one-time plaintext: it is held in component state only for as
 * long as the reveal panel is open, and is never written anywhere it
 * could be read back. The list refreshes after issuing rather than being
 * patched locally, so `lastUsedAt` and `requestCount` cannot drift from
 * what the gate actually recorded.
 *
 * Rotate, revoke and delete are not here. They live on a token's own
 * page (TokenDetail), reached by clicking its row — a destructive action
 * repeated once per row is an action aimed at the wrong row eventually.
 */
import { useCallback, useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { RButton } from '@/components/rialto/primitives'
import { IssuedTokenPanel } from '@/components/rialto/settings/access/IssuedTokenPanel'
import { emptyDraft, type IssueDraft, IssueTokenForm } from '@/components/rialto/settings/access/IssueTokenForm'
import { ANY } from '@/components/rialto/settings/access/pickers'
import { TokenTable } from '@/components/rialto/settings/access/TokenTable'
import { SectionHead } from '@/components/rialto/settings/fields'
import { type AccessTokenWire, api, type InboundSurfaceWire } from '@/lib/api'
import { countTokens, EXPIRY_CHOICES, expiryToIso } from '@/lib/rialto/settings/access-tokens'

// react-i18next's t(), trimmed to what these two helpers call.
type Translate = (key: string, options?: Record<string, unknown>) => string

interface Revealed {
  plaintext: string
  name: string
  scope: string
  profile: string
  expiry: string
}

const expiryLabel = (choiceId: string, t: Translate): string => {
  const choice = EXPIRY_CHOICES.find((c) => c.id === choiceId)
  return choice === undefined ? t('settings.access.noExpiry') : t(choice.labelKey)
}

const summary = (counts: { active: number; expired: number; revoked: number }, t: Translate): string => {
  const parts = [t('settings.access.countActive', { n: counts.active })]
  if (counts.expired > 0) parts.push(t('settings.access.countExpired', { n: counts.expired }))
  if (counts.revoked > 0) parts.push(t('settings.access.countRevoked', { n: counts.revoked }))
  return parts.join(' · ')
}

export function AccessTokensSection({ surfaces }: { surfaces: InboundSurfaceWire[] }) {
  const { t } = useTranslation()
  const [tokens, setTokens] = useState<AccessTokenWire[]>([])
  const [profiles, setProfiles] = useState<{ key: string }[]>([])
  const [draft, setDraft] = useState<IssueDraft | null>(null)
  const [revealed, setRevealed] = useState<Revealed | null>(null)
  const [issuing, setIssuing] = useState(false)
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
          expiry: expiryLabel(draft.expiry, t)
        })
        setDraft(null)
        load()
      })
      .catch((e: Error) => toast.error(t('settings.access.issueFailed', { message: e.message })))
      .finally(() => setIssuing(false))
  }

  const counts = countTokens(tokens, now)

  return (
    <>
      <SectionHead
        title={t('settings.access.tokensTitle')}
        meta={
          <Trans
            i18nKey='settings.access.tokensMeta'
            values={{ summary: summary(counts, t) }}
            components={{ mono: <span className='font-mono' /> }}
          />
        }
        actions={
          draft === null && revealed === null ? (
            <RButton variant='primary' icon='ri-add-line' onClick={() => setDraft(emptyDraft())}>
              {t('settings.access.issueToken')}
            </RButton>
          ) : null
        }
      />

      {revealed !== null ? (
        <IssuedTokenPanel {...revealed} onDone={() => setRevealed(null)} />
      ) : draft !== null ? (
        <IssueTokenForm
          draft={draft}
          surfaces={surfaces}
          profiles={profiles}
          issuing={issuing}
          onChange={setDraft}
          onSubmit={issue}
          onCancel={() => setDraft(null)}
        />
      ) : (
        <>
          <div className='px-6 pb-4'>
            <div className='rounded-md border border-dashed border-border px-4 py-3 text-[12px] leading-relaxed text-muted-foreground'>
              <i className='ri-information-line mr-1 align-[-1px]' />
              <Trans
                i18nKey='settings.access.tokensNote'
                components={{
                  mono: <span className='font-mono' />,
                  strong: <span className='font-medium text-foreground' />
                }}
              />
              {/* Second paragraph rather than a second banner: the Cost
                  column reads as broken on a subscription-only install
                  (every row a dash) unless something says why, and one
                  more box above the table would cost more attention than
                  the answer is worth. */}
              <p className='mt-2'>
                <Trans
                  i18nKey='settings.access.costNote'
                  components={{ strong: <span className='font-medium text-foreground' /> }}
                />
              </p>
            </div>
          </div>
          <TokenTable tokens={tokens} surfaces={surfaces} now={now} />
        </>
      )}
    </>
  )
}
