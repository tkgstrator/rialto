/**
 * One access token, and the two actions that change what it can do.
 *
 * Revoke lives here and nowhere else. As a row action it sat one
 * mis-aimed click from every other row, on a table whose rows are the
 * only thing letting clients into the proxy — and the cost of the
 * mis-click is a CLI that stops working with a 401 the operator then has
 * to trace back to this screen. Reaching a token's own page first makes
 * the destructive action deliberate and gives it the context (what this
 * token has been doing, when it was last used) that the decision
 * actually needs.
 *
 * Rotate is the ordinary answer to a leak. It keeps the row — the id,
 * the name, the scope, the request count and every RequestLog pointing
 * at it — and replaces only the secret, so the client's history stays
 * one story instead of splitting across "CI" and "CI (old)".
 *
 * Scope and profile are editable here, because neither is an issue-time
 * decision: a client picks up a second endpoint, or its traffic should
 * start following a different chain, and neither is a reason to hand the
 * machine a new secret. Edited through a draft with an explicit Save
 * rather than applied on click — a stray chip would otherwise change
 * what a live client can reach, with the failure landing on the client
 * as a 401 nobody can trace from that end.
 */
import { useCallback, useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { useSurfaces } from '@/components/rialto/activity/use-surfaces'
import { Pill, RButton } from '@/components/rialto/primitives'
import { Screen } from '@/components/rialto/Screen'
import { IssuedTokenPanel } from '@/components/rialto/settings/access/IssuedTokenPanel'
import { ANY, Picker, SurfacePicker, sameScope } from '@/components/rialto/settings/access/pickers'
import { SettingsField } from '@/components/rialto/settings/SettingsLayout'
import { useUnsavedGuard } from '@/components/rialto/settings/use-unsaved-guard'
import { type AccessTokenWire, api } from '@/lib/api'
import { fmtAgo, fmtCount } from '@/lib/rialto/format'
import { TOKEN_STATE_PILL, type TokenState, tokenState } from '@/lib/rialto/settings/access-tokens'
import { fmtCost } from '@/lib/sessions/format'

const BACK = '/access-tokens'

/**
 * The server answers a refused rotation with the reason as its error
 * text. Mapped to a sentence that says what to do instead, because
 * "revoked" alone on a toast explains nothing an operator can act on.
 */
const ROTATE_REFUSAL: Readonly<Record<string, string>> = {
  revoked: 'settings.access.rotateRefusedRevoked',
  expired: 'settings.access.rotateRefusedExpired'
}

/** The two fields this page can change. */
interface ScopeDraft {
  surfaces: string[]
  profileKey: string
}

interface Revealed {
  plaintext: string
  scope: string
  profile: string
  expiry: string
}

/**
 * Identity and the destructive actions.
 *
 * Extracted from TokenDetail because it holds three of that component's
 * branches and none of its state — the page was over the complexity
 * ceiling with them inline.
 */
function DetailHeader({
  token,
  state,
  busy,
  onRotate,
  onRevoke,
  onDelete
}: {
  token: AccessTokenWire
  state: TokenState
  busy: boolean
  onRotate: () => void
  onRevoke: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const pill = TOKEN_STATE_PILL[state]
  return (
    <div className='flex items-center gap-3 px-6 pt-6 pb-3'>
      <Link
        to={BACK}
        className='text-muted-foreground hover:text-foreground'
        aria-label={t('settings.access.backToTokens')}
      >
        <i className='ri-arrow-left-line text-base' />
      </Link>
      <div className='min-w-0'>
        <div className='truncate text-sm font-semibold'>{token.name}</div>
        <div className='font-mono text-[12px] text-muted-foreground'>{token.prefix}</div>
      </div>
      <Pill tone={pill.tone}>{t(pill.labelKey)}</Pill>
      <div className='ml-auto flex items-center gap-2'>
        {/* Rotate first and revoke second: rotating is the answer to
            almost every reason for being on this page, and revoking is
            the one that takes a client offline.
            Absent rather than disabled on a dead token: a new secret on
            a revoked or expired row would not authenticate, so the
            server refuses the call outright — there is no state in which
            this control could become live, and a permanently greyed-out
            button is clutter rather than information. */}
        {state === 'active' ? (
          <RButton variant='outline' icon='ri-refresh-line' onClick={onRotate} disabled={busy}>
            {t('settings.access.rotate')}
          </RButton>
        ) : null}
        {state === 'revoked' ? (
          <RButton variant='danger' icon='ri-delete-bin-line' onClick={onDelete} disabled={busy}>
            {t('settings.access.delete')}
          </RButton>
        ) : (
          <RButton variant='danger' icon='ri-forbid-line' onClick={onRevoke} disabled={busy}>
            {t('settings.access.revoke')}
          </RButton>
        )}
      </div>
    </div>
  )
}

export function TokenDetail() {
  const { t } = useTranslation()
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { surfaces, pathOf } = useSurfaces()
  const [token, setToken] = useState<AccessTokenWire | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [revealed, setRevealed] = useState<Revealed | null>(null)
  const [draft, setDraft] = useState<ScopeDraft | null>(null)
  const [profiles, setProfiles] = useState<{ key: string }[]>([])
  // Pinned per load so every relative label measures from one instant.
  const [now, setNow] = useState(Date.now())

  const load = useCallback(() => {
    api
      .getAccessToken(id)
      .then((res) => {
        setToken(res)
        // Reset the draft from the server's answer after every load, so a
        // rotation or a save cannot leave a stale edit on screen.
        setDraft({ surfaces: res.surfaces, profileKey: res.profileKey === null ? ANY : res.profileKey })
        setNow(Date.now())
      })
      .catch((e: Error) => setError(e.message))
  }, [id])

  useEffect(load, [load])

  useEffect(() => {
    api
      .get<{ profiles: { key: string }[] }>('/router-preferences/profiles')
      .then((res) => setProfiles(res.profiles))
      .catch(() => {
        // The picker falls back to "follow the endpoint", which is the
        // server's own default when profileKey is null.
      })
  }, [])

  const rotate = () => {
    if (token === null) return
    if (!window.confirm(t('settings.access.rotateConfirm', { name: token.name }))) return
    setBusy(true)
    api
      .rotateAccessToken(token.id)
      .then((res) => {
        const paths = res.token.surfaces.flatMap((id) => {
          const found = pathOf(id)
          return found === null ? [] : [found]
        })
        setRevealed({
          plaintext: res.plaintext,
          scope: paths.length === 0 ? t('settings.access.allEndpoints') : paths.join(', '),
          profile: res.token.profileKey === null ? t('settings.access.followEndpoint') : res.token.profileKey,
          expiry: res.token.expiresAt === null ? t('settings.access.never') : res.token.expiresAt.slice(0, 10)
        })
        load()
      })
      .catch((e: Error) => {
        const refusal = ROTATE_REFUSAL[e.message]
        toast.error(refusal === undefined ? t('settings.access.rotateFailed', { message: e.message }) : t(refusal))
      })
      .finally(() => setBusy(false))
  }

  const revoke = () => {
    if (token === null) return
    if (!window.confirm(t('settings.access.revokeConfirm', { name: token.name }))) return
    setBusy(true)
    api
      .revokeAccessToken(token.id)
      .then(() => {
        toast.success(t('settings.access.revoked', { name: token.name }))
        load()
      })
      .catch((e: Error) => toast.error(t('settings.access.revokeFailed', { message: e.message })))
      .finally(() => setBusy(false))
  }

  const remove = () => {
    if (token === null) return
    if (!window.confirm(t('settings.access.deleteConfirm', { name: token.name }))) return
    setBusy(true)
    api
      .deleteAccessToken(token.id)
      .then(() => {
        toast.success(t('settings.access.deleted', { name: token.name }))
        // The row is gone, so this page has nothing left to describe.
        navigate(BACK)
      })
      .catch((e: Error) => toast.error(t('settings.access.deleteFailed', { message: e.message })))
      .finally(() => setBusy(false))
  }

  // Computed above the early returns: useUnsavedGuard is a hook, and a
  // return between renders would change the hook order.
  const dirty =
    token !== null &&
    draft !== null &&
    (!sameScope(draft.surfaces, token.surfaces) ||
      draft.profileKey !== (token.profileKey === null ? ANY : token.profileKey))
  useUnsavedGuard(dirty)

  const save = () => {
    if (token === null || draft === null) return
    setBusy(true)
    api
      .updateAccessToken(token.id, {
        // Resolved through the fetched registry rather than asserted, so
        // an id the server does not know cannot reach the wire.
        surfaces: surfaces.filter((s) => draft.surfaces.includes(s.id)).map((s) => s.id),
        profileKey: draft.profileKey === ANY ? null : draft.profileKey
      })
      .then(() => {
        toast.success(t('settings.access.scopeSaved', { name: token.name }))
        load()
      })
      .catch((e: Error) => toast.error(t('settings.common.saveFailed', { message: e.message })))
      .finally(() => setBusy(false))
  }

  const discard = () => {
    if (token === null) return
    setDraft({ surfaces: token.surfaces, profileKey: token.profileKey === null ? ANY : token.profileKey })
  }

  if (error !== null) {
    return (
      <Screen crumbs={[{ label: t('settings.access.tokenNotFound') }]}>
        <div className='px-6 py-8 text-xs text-muted-foreground'>
          {t('settings.access.tokenLoadFailed', { message: error })}
        </div>
      </Screen>
    )
  }
  if (token === null || draft === null) {
    return (
      <Screen>
        <div className='px-6 py-8 text-xs text-muted-foreground'>{t('common.loading')}</div>
      </Screen>
    )
  }

  const state = tokenState(token, now)
  const editable = state === 'active'

  return (
    <Screen crumbs={[{ label: token.name }]} subtitle={t('settings.access.tokenSubtitle')}>
      <div className='min-w-0'>
        <DetailHeader token={token} state={state} busy={busy} onRotate={rotate} onRevoke={revoke} onDelete={remove} />

        {revealed === null ? null : (
          <IssuedTokenPanel
            plaintext={revealed.plaintext}
            name={token.name}
            scope={revealed.scope}
            profile={revealed.profile}
            expiry={revealed.expiry}
            titleKey='settings.access.rotatedTitle'
            bodyKey='settings.access.rotatedBody'
            onDone={() => setRevealed(null)}
          />
        )}

        {/* Editable only while the token can actually be used: changing
            the scope of a revoked or expired row alters nothing about
            what reaches the proxy, so the controls would be theatre. */}
        <SettingsField label={t('settings.access.colEndpoint')} hint={t('settings.access.issueEndpointHint')}>
          <SurfacePicker
            surfaces={surfaces}
            selected={draft.surfaces}
            onChange={(next) => setDraft({ ...draft, surfaces: next })}
            allLabel={t('settings.access.allEndpoints')}
            disabled={!editable || busy}
          />
        </SettingsField>

        <SettingsField label={t('settings.access.colProfile')} hint={t('settings.access.issueProfileHint')}>
          <Picker
            label={t('settings.access.colProfile')}
            value={draft.profileKey}
            onChange={(next) => setDraft({ ...draft, profileKey: next })}
            disabled={!editable || busy}
          >
            <option value={ANY}>{t('settings.access.followEndpoint')}</option>
            {profiles.map((profile) => (
              <option key={profile.key} value={profile.key}>
                {profile.key}
              </option>
            ))}
          </Picker>
        </SettingsField>

        <SettingsField label={t('settings.access.detailUsage')} hint={t('settings.access.detailUsageHint')}>
          <div className='flex items-center gap-4 font-mono text-xs tabular-nums'>
            <span>{t('settings.access.detailRequests', { n: fmtCount(token.requestCount) })}</span>
            <span className='text-muted-foreground'>·</span>
            <span>{fmtCost(token.costUsd)}</span>
            <span className='text-muted-foreground'>·</span>
            <span className='text-muted-foreground'>
              {token.lastUsedAt === null
                ? t('settings.access.never')
                : t('settings.access.lastUsedAgo', { ago: fmtAgo(token.lastUsedAt, now) })}
            </span>
          </div>
        </SettingsField>

        <SettingsField label={t('settings.access.detailLifetime')} hint={t('settings.access.detailLifetimeHint')}>
          <div className='space-y-1 font-mono text-xs'>
            <div>{t('settings.access.detailCreated', { date: token.createdAt.slice(0, 10) })}</div>
            <div>
              {token.expiresAt === null
                ? t('settings.access.detailNoExpiry')
                : t('settings.access.detailExpires', { date: token.expiresAt.slice(0, 10) })}
            </div>
            {/* Absent until the secret has actually been replaced — a
                "never rotated" line on a week-old token is noise, but on
                a two-year-old one the absence is the point, so it is the
                date that appears rather than a reassuring default. */}
            {token.rotatedAt === null ? null : (
              <div>{t('settings.access.detailRotated', { date: token.rotatedAt.slice(0, 10) })}</div>
            )}
            {token.revokedAt === null ? null : (
              <div className='text-destructive'>
                {t('settings.access.detailRevoked', { date: token.revokedAt.slice(0, 10) })}
              </div>
            )}
          </div>
        </SettingsField>

        <div className='px-6 py-4'>
          <div className='rounded-md border border-dashed border-border px-4 py-3 text-[12px] leading-relaxed text-muted-foreground'>
            <i className='ri-information-line mr-1 align-[-1px]' />
            <Trans
              i18nKey='settings.access.rotateNote'
              components={{ strong: <span className='font-medium text-foreground' /> }}
            />
          </div>
        </div>
        {/* Last thing on the page, which is where a form's own actions
            belong. It started in the app title bar, where it sat beside
            the breadcrumbs and said nothing about which of the page's
            controls it applied to; moving it up against the two editable
            fields fixed that and introduced a worse problem — a bar
            across the middle of a page reads as the end of the page, and
            the rows below it looked like a separate screen.
            Always present rather than appearing on the first edit: a bar
            that materialises moves everything around it, and the
            disabled pair states the rule (there is a Save, and nothing
            to save yet) before the operator touches anything. */}
        <div className='flex items-center gap-2 border-t border-border/60 px-6 py-4'>
          {/* Names the token. The page can be reached from a table of
              several, and a bare "Save" in a bar says which controls it
              applies to but not which row — the one thing an operator
              about to change what a live client may reach needs to be
              sure of. */}
          <span className='text-[12px] text-muted-foreground'>
            <Trans
              i18nKey='settings.access.scopeEditNote'
              values={{ name: token.name }}
              components={{ strong: <span className='font-medium text-foreground' /> }}
            />
          </span>
          <div className='ml-auto flex gap-2'>
            <RButton variant='ghost' onClick={discard} disabled={!dirty || busy}>
              {t('common.discard')}
            </RButton>
            <RButton variant='primary' icon='ri-check-line' onClick={save} disabled={!dirty || busy}>
              {t('common.save')}
            </RButton>
          </div>
        </div>
        <div className='h-8' />
      </div>
    </Screen>
  )
}
