import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
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
import { FolderPicker, TokenPolicyFields } from '@/components/rialto/settings/access/TokenPolicyFields'
import { TokenReadings } from '@/components/rialto/settings/access/TokenReadings'
import { TokenUsageWindows, useTokenUsageWindows } from '@/components/rialto/settings/access/TokenUsageWindows'
import { useUnsavedGuard } from '@/components/rialto/settings/use-unsaved-guard'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { usePhone } from '@/hooks/use-phone'
import { type AccessTokenWire, api, type InboundSurfaceWire, type PlanWire } from '@/lib/api'
import { enabledTargets } from '@/lib/models/enabled-targets'
import { splitConfirmMessage } from '@/lib/rialto/confirm-message'
import { tokenState } from '@/lib/rialto/settings/access-tokens'
import { targetMatchesSurfaces } from '@/lib/rialto/settings/surface-model-compat'
import { usageBlocked, usageWindowsView } from '@/lib/rialto/settings/usage-windows'
import type { Provider } from '@/schemas/domain/provider'
import { DEFAULT_TOKEN_POLICY, type TokenFolder, type TokenPolicy } from '@/shared/access-token-policy'

const BACK = '/access-tokens'

function LockedField({ id, value }: { id: string; value: string }) {
  return (
    <div className='relative w-full max-w-md'>
      <Input
        id={id}
        readOnly
        value={value}
        className='h-8 cursor-not-allowed bg-muted/40 pr-9 text-xs text-muted-foreground md:text-xs'
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
  name: string
  surfaces: string[]
  planId: string
  folderId: string | null
  policy: TokenPolicy
}

const draftOf = (token: AccessTokenWire): ScopeDraft => ({
  name: token.name,
  surfaces: token.surfaces,
  folderId: token.folderId === undefined ? null : token.folderId,
  policy: token.policy === undefined ? DEFAULT_TOKEN_POLICY : token.policy,
  planId: token.plan === null ? ANY : token.plan.id
})

const draftChanged = (draft: ScopeDraft, token: AccessTokenWire): boolean => {
  const saved = draftOf(token)
  return (
    draft.name.trim() !== saved.name ||
    !sameScope(draft.surfaces, saved.surfaces) ||
    draft.planId !== saved.planId ||
    draft.folderId !== saved.folderId ||
    JSON.stringify(draft.policy) !== JSON.stringify(saved.policy)
  )
}

interface Revealed {
  plaintext: string
  scope: string
  expiry: string
}

function TokenSettingsFields({
  nameField,
  folderField,
  policyFields,
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
  nameField: ReactNode
  folderField: ReactNode
  policyFields: ReactNode
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
  const id = useId()
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
    <div className='grid max-w-3xl gap-4 px-4 py-4 md:grid-cols-2 md:gap-6 md:px-6'>
      <FieldGroup className='min-w-0 gap-3'>
        {nameField}
        <Field className='gap-2'>
          <FieldLabel className='text-xs' htmlFor={`${id}-endpoint`}>
            {t('settings.access.colEndpoint')}
          </FieldLabel>
          <SurfacePicker
            id={`${id}-endpoint`}
            surfaces={surfaces}
            selected={draft.surfaces}
            onChange={(next) => onDraftChange({ ...draft, surfaces: next })}
            allLabel={t('settings.access.standardEndpoints')}
            showHint={false}
            disabled={!editable || busy}
          />
        </Field>
        {folderField}
        <Field className='gap-2'>
          <FieldLabel className='text-xs' htmlFor={`${id}-expires`}>
            {t('settings.access.issueExpires')}
          </FieldLabel>
          <LockedField id={`${id}-expires`} value={expiresLabel} />
        </Field>
      </FieldGroup>
      <FieldGroup className='min-w-0 gap-3'>
        <Field className='gap-2'>
          <FieldLabel className='text-xs' htmlFor={`${id}-plan`}>
            {t('access.token.plan')}
          </FieldLabel>
          <PlanSelector
            id={`${id}-plan`}
            showLabel={false}
            showSummary={false}
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
        </Field>
        {policyFields}
      </FieldGroup>
    </div>
  )
}

function SaveBar({
  dirty,
  valid,
  creating,
  busy,
  onDiscard,
  formId
}: {
  dirty: boolean
  valid: boolean
  creating: boolean
  busy: boolean
  onDiscard: () => void
  formId: string
}) {
  const { t } = useTranslation()
  const canDiscard = (dirty || creating) && !busy
  const canSave = valid && dirty && !busy && !creating
  return (
    <div className='flex items-center gap-2 border-t border-border/60 px-6 py-4'>
      {creating ? (
        <span className='text-[12px] text-muted-foreground'>{t('access.token.creatingPlanFirst')}</span>
      ) : null}
      <div className='ml-auto flex gap-2'>
        <RButton variant='outline' onClick={onDiscard} disabled={!canDiscard}>
          {t('common.discard')}
        </RButton>
        <RButton variant='primary' icon='ri-check-line' type='submit' form={formId} disabled={!canSave}>
          {t('common.save')}
        </RButton>
      </div>
    </div>
  )
}

export function TokenDetail() {
  const { t } = useTranslation()
  const { id = '' } = useParams()
  const formId = useId()
  const navigate = useNavigate()
  const { surfaces } = useSurfaces()
  const { config } = useConfig()
  const { confirm, dialog: confirmDialog } = useConfirm()
  const [token, setToken] = useState<AccessTokenWire | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [revealed, setRevealed] = useState<Revealed | null>(null)
  const [draft, setDraft] = useState<ScopeDraft | null>(null)
  const [folders, setFolders] = useState<TokenFolder[]>([])
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

  useEffect(() => {
    api
      .getTokenFolders()
      .then((res) => setFolders(res.folders))
      .catch((error: Error) => toast.error(t('settings.access.listFailed', { message: error.message })))
  }, [t])

  const save = () => {
    if (token === null || draft === null || !draft.name.trim()) return
    setBusy(true)
    api
      .updateAccessToken(token.id, {
        ...(draft.name.trim() === token.name ? {} : { name: draft.name.trim() }),
        surfaces: scopeForWire(surfaces, draft.surfaces),
        folderId: draft.folderId,
        policy: draft.policy,
        planId: draft.planId === ANY ? null : draft.planId
      })
      .then((updated) => {
        toast.success(t('settings.access.scopeSaved', { name: updated.name }))
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

  const nameField = (
    <Field className='gap-2'>
      <FieldLabel className='text-xs' htmlFor={`${formId}-name`}>
        {t('settings.access.issueName')}
      </FieldLabel>
      <Input
        id={`${formId}-name`}
        className='h-8 text-xs md:text-xs'
        maxLength={200}
        value={draft.name}
        disabled={busy}
        onChange={(event) => setDraft({ ...draft, name: event.target.value })}
      />
    </Field>
  )

  const folderField = (
    <Field className='gap-2'>
      <FieldLabel className='text-xs' htmlFor={`${formId}-folder`}>
        {t('settings.access.folder')}
      </FieldLabel>
      <FolderPicker
        id={`${formId}-folder`}
        className='w-full'
        folders={folders}
        disabled={!editable || busy}
        value={draft.folderId}
        onChange={(folderId) => setDraft({ ...draft, folderId })}
      />
    </Field>
  )

  const form = (
    <form
      id={formId}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        if (dirty && !busy && !creating && draft.name.trim()) void save()
      }}
    >
      <TokenSettingsFields
        nameField={nameField}
        folderField={folderField}
        policyFields={
          <TokenPolicyFields
            policy={draft.policy}
            disabled={!editable || busy}
            onChange={(policy) => setDraft({ ...draft, policy })}
            plan={plans.find((plan) => plan.id === draft.planId)}
            available={available}
          />
        }
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
    </form>
  )

  if (phone) {
    return (
      <Screen crumbs={[{ label: token.name }]}>
        {form}
        <TokenDetailPhone
          token={token}
          state={state}
          usageBlocked={usageBlocked(windows)}
          busy={busy}
          onRotate={rotate}
          onRevoke={revoke}
        />
        <TokenUsageWindows token={token} view={windows} now={now} onReset={setUsage} />
        <TokenReadings token={token} now={now} />
        <SaveBar
          dirty={dirty}
          valid={draft.name.trim().length > 0}
          creating={creating}
          busy={busy}
          onDiscard={discard}
          formId={formId}
        />
        {unsavedDialog}
        {rotatedDialog}
        {confirmDialog}
      </Screen>
    )
  }

  return (
    <Screen crumbs={[{ label: token.name }]}>
      <div className='min-w-0'>
        <TokenDetailHeader
          token={token}
          state={state}
          usageBlocked={usageBlocked(windows)}
          busy={busy}
          onRotate={rotate}
          onRevoke={revoke}
        />

        {form}
        <TokenUsageWindows token={token} view={windows} now={now} onReset={setUsage} />

        <TokenReadings token={token} now={now} />

        <SaveBar
          dirty={dirty}
          valid={draft.name.trim().length > 0}
          creating={creating}
          busy={busy}
          onDiscard={discard}
          formId={formId}
        />
        <div className='h-8' />

        {rotatedDialog}
        {confirmDialog}
        {unsavedDialog}
      </div>
    </Screen>
  )
}
