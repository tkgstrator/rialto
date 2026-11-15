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
 * Scope and plan are editable here, because neither is an issue-time
 * decision: a client picks up a second endpoint, or moves to another plan,
 * and neither is a reason to hand the machine a new secret. Edited through a draft with an explicit Save
 * rather than applied on click — a stray chip would otherwise change
 * what a live client can reach, with the failure landing on the client
 * as a 401 nobody can trace from that end.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { useConfig } from '@/components/ConfigProvider'
import { scopePaths, useSurfaces } from '@/components/rialto/activity/use-surfaces'
import { useConfirm } from '@/components/rialto/ConfirmDialog'
import { RButton } from '@/components/rialto/primitives'
import { Screen } from '@/components/rialto/Screen'
import { IssuedTokenDialog } from '@/components/rialto/settings/access/IssuedTokenDialog'
import { PlanSelector } from '@/components/rialto/settings/access/PlanSelector'
import { ANY, SurfacePicker, sameScope, scopeForWire } from '@/components/rialto/settings/access/pickers'
import { TokenDetailHeader } from '@/components/rialto/settings/access/TokenDetailHeader'
import { TokenDetailPhone } from '@/components/rialto/settings/access/TokenDetailPhone'
import { TokenReadings } from '@/components/rialto/settings/access/TokenReadings'
import { TokenUsageWindows, useTokenUsageWindows } from '@/components/rialto/settings/access/TokenUsageWindows'
import { SettingsField } from '@/components/rialto/settings/SettingsLayout'
import { useUnsavedGuard } from '@/components/rialto/settings/use-unsaved-guard'
import { usePhone } from '@/hooks/use-phone'
import { type AccessTokenWire, api, type InboundSurfaceWire, type PlanWire } from '@/lib/api'
import { enabledTargets } from '@/lib/models/enabled-targets'
import { splitConfirmMessage } from '@/lib/rialto/confirm-message'
import { tokenState } from '@/lib/rialto/settings/access-tokens'
import { usageBlocked, usageWindowsView } from '@/lib/rialto/settings/usage-windows'

const BACK = '/access-tokens'

/**
 * Locked input: a read-only box carrying a value the operator can see
 * but not change, with a lock suffix. Used for the issue-time fields
 * (name, expiry) on this page.
 */
function LockedField({ value, aria }: { value: string; aria: string }) {
  return (
    <div className='relative w-full max-w-md'>
      <input
        readOnly
        aria-readonly
        aria-label={aria}
        value={value}
        className='h-8 w-full min-w-0 cursor-not-allowed rounded-md border border-border bg-muted/40 px-3 pr-9 font-mono text-xs text-muted-foreground outline-none'
      />
      <i
        aria-hidden
        className='ri-lock-line pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground/60'
      />
    </div>
  )
}

/**
 * The server answers a refused rotation with the reason as its error
 * text. Mapped to a sentence that says what to do instead, because
 * "expired" alone on a toast explains nothing an operator can act on.
 */
const ROTATE_REFUSAL: Readonly<Record<string, string>> = {
  expired: 'settings.access.rotateRefusedExpired'
}

/** The fields this page can change. */
interface ScopeDraft {
  surfaces: string[]
  /** ANY for no plan, which the wire sends as null. */
  planId: string
}

const draftOf = (token: AccessTokenWire): ScopeDraft => ({
  surfaces: token.surfaces,
  planId: token.plan === null ? ANY : token.plan.id
})

const draftChanged = (draft: ScopeDraft, token: AccessTokenWire): boolean => {
  const saved = draftOf(token)
  return !sameScope(draft.surfaces, saved.surfaces) || draft.planId !== saved.planId
}

interface Revealed {
  plaintext: string
  scope: string
  expiry: string
}

/**
 * The editable + locked fields of a token's page. Lifted out of
 * `TokenDetail` so the page function stays readable; the orchestrator
 * owns all state, this one only draws.
 */
function TokenScopeForm({
  token,
  draft,
  plans,
  surfaces,
  available,
  editable,
  busy,
  creating,
  createdNote,
  onDraftChange,
  onPlanCreated,
  onCreatingChange,
  onDismissCreatedNote
}: {
  token: AccessTokenWire
  draft: ScopeDraft
  plans: readonly PlanWire[]
  surfaces: readonly InboundSurfaceWire[]
  available: readonly string[]
  editable: boolean
  busy: boolean
  creating: boolean
  createdNote: string | null
  onDraftChange: (next: ScopeDraft) => void
  onPlanCreated: (plan: PlanWire) => void
  onCreatingChange: (next: boolean) => void
  onDismissCreatedNote: () => void
}) {
  const { t } = useTranslation()
  const expiresLabel = token.expiresAt === null ? t('settings.access.never') : token.expiresAt.slice(0, 10)
  const planValue = draft.planId === ANY ? '' : draft.planId
  const onPlanChange = (next: string) => {
    if (next !== draft.planId) onDismissCreatedNote()
    onDraftChange({ ...draft, planId: next === '' ? ANY : next })
  }
  return (
    <>
      {/* Name is fixed at issue — the list labels this credential, and
          re-labelling it without a new secret would drift what every
          audit entry says from what this screen says. Drawn locked so
          the operator can see what the row is and read the hint. */}
      <SettingsField label={t('settings.access.issueName')} hint={t('access.token.nameLockedHint')}>
        <LockedField value={token.name} aria={t('settings.access.issueName')} />
      </SettingsField>

      {/* Editable only while the token can actually be used: changing
          the scope of an expired row alters nothing about
          what reaches the proxy, so the controls would be theatre. */}
      <SettingsField label={t('settings.access.colEndpoint')} hint={t('settings.access.issueEndpointHint')}>
        <SurfacePicker
          surfaces={surfaces}
          selected={draft.surfaces}
          onChange={(next) => onDraftChange({ ...draft, surfaces: next })}
          allLabel={t('settings.access.allEndpoints')}
          disabled={!editable || busy}
        />
      </SettingsField>

      {/* A plan limits the models and the usage windows; no plan leaves
          the token unrestricted, as hand-issued ones always were. */}
      <SettingsField label={t('access.token.plan')} hint={t('access.token.planFormHint')}>
        <PlanSelector
          showLabel={false}
          value={planValue}
          plans={plans}
          available={available}
          onChange={onPlanChange}
          onPlanCreated={onPlanCreated}
          creating={creating}
          onCreatingChange={onCreatingChange}
          createdNote={createdNote}
          onDismissCreatedNote={onDismissCreatedNote}
          disabled={!editable || busy}
        />
      </SettingsField>

      {/* Expiry is set at issue and only shrinks on its own after that —
          a token whose stop date can be pushed out has no stop date. */}
      <SettingsField label={t('settings.access.issueExpires')} hint={t('access.token.expiresLockedHint')}>
        <LockedField value={expiresLabel} aria={t('settings.access.issueExpires')} />
      </SettingsField>
    </>
  )
}

/** The hint-and-buttons footer. Lifted out so the page keeps a flat shape. */
function SaveBar({
  tokenName,
  dirty,
  creating,
  busy,
  onDiscard,
  onSave
}: {
  tokenName: string
  dirty: boolean
  creating: boolean
  busy: boolean
  onDiscard: () => void
  onSave: () => void
}) {
  const { t } = useTranslation()
  const canDiscard = (dirty || creating) && !busy
  const canSave = dirty && !busy && !creating
  return (
    <div className='flex items-center gap-2 border-t border-border/60 px-6 py-4'>
      {/* Names the token. The page can be reached from a table of
          several, and a bare "Save" in a bar says which controls it
          applies to but not which row — the one thing an operator
          about to change what a live client may reach needs to be
          sure of. */}
      <span className='text-[12px] text-muted-foreground'>
        {creating ? (
          t('access.token.creatingPlanFirst')
        ) : (
          <Trans
            i18nKey='settings.access.scopeEditNote'
            values={{ name: tokenName }}
            components={{ strong: <span className='font-medium text-foreground' /> }}
          />
        )}
      </span>
      <div className='ml-auto flex gap-2'>
        <RButton variant='ghost' onClick={onDiscard} disabled={!canDiscard}>
          {t('common.discard')}
        </RButton>
        <RButton variant='primary' icon='ri-check-line' onClick={onSave} disabled={!canSave}>
          {t('common.save')}
        </RButton>
      </div>
    </div>
  )
}

export function TokenDetail() {
  const { t } = useTranslation()
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { surfaces } = useSurfaces()
  const { config } = useConfig()
  const { confirm, dialog: confirmDialog } = useConfirm()
  const [token, setToken] = useState<AccessTokenWire | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [revealed, setRevealed] = useState<Revealed | null>(null)
  const [draft, setDraft] = useState<ScopeDraft | null>(null)
  const [plans, setPlans] = useState<PlanWire[]>([])
  // Inline new-plan form state for the plan field.
  const [creating, setCreating] = useState(false)
  const [createdNote, setCreatedNote] = useState<string | null>(null)
  // Every relative label measures from the same instant.
  const [now, setNow] = useState(Date.now())
  const phone = usePhone()

  // What the operator has left switched on: the models an inline new plan may name.
  const available = useMemo(
    () => (config === null ? [] : enabledTargets(config.Providers).map((target) => target.target)),
    [config]
  )

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(interval)
  }, [])

  const load = useCallback(() => {
    api
      .getAccessToken(id)
      .then((res) => {
        setToken(res)
        // Reset the draft from the server's answer after every load, so a
        // rotation or a save cannot leave a stale edit on screen.
        setDraft(draftOf(res))
        setCreating(false)
        setCreatedNote(null)
        setNow(Date.now())
      })
      .catch((e: Error) => setError(e.message))
  }, [id])

  useEffect(load, [load])

  useEffect(() => {
    api
      .getPlans()
      .then((res) => setPlans(res.plans))
      .catch(() => {
        // The plan picker then offers only "no plan" and the token's own.
      })
  }, [])

  // Every action on this page that cannot be undone asks through the same
  // dialog: its title is the question the confirm copy leads with, and its
  // red button carries the words and icon of the button that opened it.
  const ask = (message: string, confirmLabel: string, icon: string): Promise<boolean> => {
    const { title, description } = splitConfirmMessage(message)
    return confirm({ title, description, confirmLabel, icon })
  }

  const rotate = async () => {
    if (token === null) return
    const confirmed = await ask(
      t('settings.access.rotateConfirm', { name: token.name }),
      t('settings.access.rotate'),
      'ri-refresh-line'
    )
    if (!confirmed) return
    setBusy(true)
    api
      .rotateAccessToken(token.id)
      .then((res) => {
        const paths = scopePaths(surfaces, res.token.surfaces)
        setRevealed({
          plaintext: res.plaintext,
          scope: paths.length === 0 ? t('settings.access.allEndpoints') : paths.join(', '),
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

  const revoke = async () => {
    if (token === null) return
    const confirmed = await ask(
      t('settings.access.revokeConfirm', { name: token.name }),
      t('settings.access.revoke'),
      'ri-forbid-line'
    )
    if (!confirmed) return
    setBusy(true)
    api
      .revokeAccessToken(token.id)
      .then(() => {
        toast.success(t('settings.access.revoked', { name: token.name }))
        // Revoking deletes the token, so this page has nothing left to describe.
        navigate(BACK)
      })
      .catch((e: Error) => toast.error(t('settings.access.revokeFailed', { message: e.message })))
      .finally(() => setBusy(false))
  }

  // Computed above the early returns: useUnsavedGuard is a hook, and a
  // return between renders would change the hook order.
  const dirty = token !== null && draft !== null && draftChanged(draft, token)
  const unsavedDialog = useUnsavedGuard(dirty)
  const { usage, setUsage } = useTokenUsageWindows(token)

  const save = () => {
    if (token === null || draft === null) return
    setBusy(true)
    api
      .updateAccessToken(token.id, {
        surfaces: scopeForWire(surfaces, draft.surfaces),
        planId: draft.planId === ANY ? null : draft.planId
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
    setDraft(draftOf(token))
    setCreating(false)
    setCreatedNote(null)
  }

  const onPlanCreated = (plan: PlanWire) => {
    setPlans((prev) => [...prev, plan])
    setDraft((prev) => (prev === null ? prev : { ...prev, planId: plan.id }))
    setCreatedNote(plan.name)
    api
      .getPlans()
      .then((res) => setPlans(res.plans))
      .catch(() => {
        // The local merge above already kept the field usable.
      })
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
  // Read from the saved plan, not the draft: the windows are what the
  // gate applies now, and an unsaved plan choice applies nothing yet.
  const windows = usageWindowsView(token.plan === null ? null : token.plan.name, usage)
  const editable = state === 'active'

  // A modal over this page, not a panel inserted into it: the rotated
  // secret is shown once, and a panel that pushes the page down can be
  // scrolled past. It is the same dialog the issue flow ends on — the
  // rules are identical, only the copy says "rotated" rather than
  // "issued". Both layouts rotate, so both carry it.
  const rotatedDialog =
    revealed === null ? null : (
      <IssuedTokenDialog
        plaintext={revealed.plaintext}
        name={token.name}
        scope={revealed.scope}
        expiry={revealed.expiry}
        titleKey='settings.access.rotatedTitle'
        bodyKey='settings.access.rotatedBody'
        onDone={() => setRevealed(null)}
      />
    )

  if (phone) {
    return (
      <Screen crumbs={[{ label: token.name }]} subtitle={t('settings.access.tokenSubtitle')}>
        <TokenDetailPhone
          token={token}
          state={state}
          windows={windows}
          usageBlocked={usageBlocked(windows)}
          surfaces={surfaces}
          now={now}
          busy={busy}
          onRotate={rotate}
          onRevoke={revoke}
          onReset={setUsage}
        />
        {rotatedDialog}
        {confirmDialog}
      </Screen>
    )
  }

  return (
    <Screen crumbs={[{ label: token.name }]} subtitle={t('settings.access.tokenSubtitle')}>
      <div className='min-w-0'>
        <TokenDetailHeader
          token={token}
          state={state}
          usageBlocked={usageBlocked(windows)}
          busy={busy}
          onRotate={rotate}
          onRevoke={revoke}
        />

        <TokenScopeForm
          token={token}
          draft={draft}
          plans={plans}
          surfaces={surfaces}
          available={available}
          editable={editable}
          busy={busy}
          creating={creating}
          createdNote={createdNote}
          onDraftChange={setDraft}
          onPlanCreated={onPlanCreated}
          onCreatingChange={setCreating}
          onDismissCreatedNote={() => setCreatedNote(null)}
        />

        <TokenUsageWindows token={token} view={windows} now={now} onReset={setUsage} />

        <TokenReadings token={token} now={now} />

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
        <SaveBar
          tokenName={token.name}
          dirty={dirty}
          creating={creating}
          busy={busy}
          onDiscard={discard}
          onSave={save}
        />
        <div className='h-8' />

        {rotatedDialog}
        {confirmDialog}
        {unsavedDialog}
      </div>
    </Screen>
  )
}
