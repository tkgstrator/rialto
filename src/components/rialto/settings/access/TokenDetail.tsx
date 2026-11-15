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
import { targetMatchesSurfaces } from '@/lib/rialto/settings/surface-model-compat'
import { usageBlocked, usageWindowsView } from '@/lib/rialto/settings/usage-windows'
import type { Provider } from '@/schemas/domain/provider'

const BACK = '/access-tokens'

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

const ROTATE_REFUSAL: Readonly<Record<string, string>> = {
  expired: 'settings.access.rotateRefusedExpired'
}

interface ScopeDraft {
  surfaces: string[]
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

function TokenScopeForm({
  token,
  draft,
  plans,
  surfaces,
  available,
  providers,
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
  providers: readonly Provider[]
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
  const disabledTargets = new Set(
    available.filter((target) => !targetMatchesSurfaces(target, providers, surfaces, draft.surfaces))
  )
  const disabledHint = t('settings.access.incompatibleWithEndpoint')
  return (
    <>
      <SettingsField label={t('settings.access.issueName')} hint={t('access.token.nameLockedHint')}>
        <LockedField value={token.name} aria={t('settings.access.issueName')} />
      </SettingsField>

      <SettingsField label={t('settings.access.colEndpoint')} hint={t('settings.access.issueEndpointHint')}>
        <SurfacePicker
          surfaces={surfaces}
          selected={draft.surfaces}
          onChange={(next) => onDraftChange({ ...draft, surfaces: next })}
          allLabel={t('settings.access.allEndpoints')}
          disabled={!editable || busy}
        />
      </SettingsField>

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
          disabledTargets={disabledTargets}
          disabledHint={disabledHint}
        />
      </SettingsField>

      <SettingsField label={t('settings.access.issueExpires')} hint={t('access.token.expiresLockedHint')}>
        <LockedField value={expiresLabel} aria={t('settings.access.issueExpires')} />
      </SettingsField>
    </>
  )
}

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
  const [creating, setCreating] = useState(false)
  const [createdNote, setCreatedNote] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const phone = usePhone()

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
      .catch(() => {})
  }, [])

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
        navigate(BACK)
      })
      .catch((e: Error) => toast.error(t('settings.access.revokeFailed', { message: e.message })))
      .finally(() => setBusy(false))
  }

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
      .catch(() => {})
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
  const windows = usageWindowsView(token.plan === null ? null : token.plan.name, usage)
  const editable = state === 'active'

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
          providers={config === null ? [] : config.Providers}
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
