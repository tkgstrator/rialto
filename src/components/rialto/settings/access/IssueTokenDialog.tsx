import { type ReactNode, useId, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useConfig } from '@/components/ConfigProvider'
import { RButton } from '@/components/rialto/primitives'
import { SelectPicker } from '@/components/rialto/SelectPicker'
import { PlanSelector } from '@/components/rialto/settings/access/PlanSelector'
import { ANY, SurfacePicker } from '@/components/rialto/settings/access/pickers'
import { FolderPicker, TokenPolicyFields } from '@/components/rialto/settings/access/TokenPolicyFields'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { InboundSurfaceWire, PlanWire } from '@/lib/api'
import { EXPIRY_CHOICES } from '@/lib/rialto/settings/access-tokens'
import { targetMatchesSurfaces } from '@/lib/rialto/settings/surface-model-compat'
import {
  DEFAULT_TOKEN_POLICY,
  folderTokenDefaults,
  type TokenFolder,
  type TokenPolicy
} from '@/shared/access-token-policy'

export interface IssueDraft {
  name: string
  surfaces: string[]
  expiry: string
  planId: string
  folderId: string | null
  policy: TokenPolicy
}

export const emptyDraft = (): IssueDraft => ({
  name: '',
  surfaces: [],
  expiry: 'never',
  planId: ANY,
  folderId: null,
  policy: DEFAULT_TOKEN_POLICY
})

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className='grid gap-1'>
      <Label htmlFor={id} className='text-xs'>
        {label}
      </Label>
      {children}
    </div>
  )
}

export function IssueTokenDialog({
  draft,
  surfaces,
  plans,
  folders,
  available,
  creating,
  createdNote,
  issuing,
  onChange,
  onSubmit,
  onCancel,
  onCreatingChange,
  onDismissCreatedNote,
  onPlanCreated
}: {
  draft: IssueDraft
  surfaces: InboundSurfaceWire[]
  plans: readonly PlanWire[]
  folders: readonly TokenFolder[]
  available: readonly string[]
  creating: boolean
  createdNote: string | null
  issuing: boolean
  onChange: (next: IssueDraft) => void
  onSubmit: () => void
  onCancel: () => void
  onCreatingChange: (next: boolean) => void
  onDismissCreatedNote: () => void
  onPlanCreated: (plan: PlanWire) => void
}) {
  const { t } = useTranslation()
  const { config } = useConfig()
  const formId = useId()
  const set = <K extends keyof IssueDraft>(key: K, value: IssueDraft[K]) => onChange({ ...draft, [key]: value })

  const providers = config === null ? [] : config.Providers
  const disabledTargets = useMemo(() => {
    const out = new Set<string>()
    for (const target of available) {
      if (!targetMatchesSurfaces(target, providers, surfaces, draft.surfaces)) out.add(target)
    }
    return out
  }, [available, providers, surfaces, draft.surfaces])
  const disabledHint = t('settings.access.incompatibleWithEndpoint')

  const issueDisabled = issuing || draft.name.trim().length === 0 || creating

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <DialogContent className='max-h-[calc(100vh-4rem)] overflow-y-auto sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle className='text-sm'>{t('settings.access.issueTitle')}</DialogTitle>
        </DialogHeader>

        <form
          className='grid gap-6'
          onSubmit={(event) => {
            event.preventDefault()
            if (!issueDisabled) onSubmit()
          }}
        >
          <div className='grid gap-4 sm:grid-cols-2 sm:gap-6'>
            <div className='min-w-0 space-y-3'>
              <Field id={`${formId}-name`} label={t('settings.access.issueName')}>
                <Input
                  id={`${formId}-name`}
                  required
                  autoFocus
                  type='text'
                  value={draft.name}
                  placeholder={t('settings.access.issueNamePlaceholder')}
                  onChange={(e) => set('name', e.target.value)}
                  className='h-8 text-xs md:text-xs'
                />
              </Field>

              <Field id={`${formId}-endpoint`} label={t('settings.access.issueEndpoint')}>
                <SurfacePicker
                  id={`${formId}-endpoint`}
                  surfaces={surfaces}
                  selected={draft.surfaces}
                  onChange={(next) => set('surfaces', next)}
                  allLabel={t('settings.access.standardEndpoints')}
                  showHint={false}
                />
              </Field>

              <Field id={`${formId}-folder`} label={t('settings.access.folder')}>
                <FolderPicker
                  id={`${formId}-folder`}
                  className='w-full'
                  folders={folders}
                  value={draft.folderId}
                  onChange={(folderId) => {
                    const folder = folders.find((entry) => entry.id === folderId)
                    const defaults = folderTokenDefaults(folder)
                    onChange({
                      ...draft,
                      folderId,
                      planId: defaults.planId === null ? ANY : defaults.planId,
                      policy: {
                        ...defaults.policy,
                        allowedModels: draft.policy.allowedModels,
                        restrictModels: draft.policy.restrictModels
                      }
                    })
                  }}
                />
              </Field>
              <Field id={`${formId}-expires`} label={t('settings.access.issueExpires')}>
                <SelectPicker
                  id={`${formId}-expires`}
                  label={t('settings.access.issueExpires')}
                  value={draft.expiry}
                  className='w-full'
                  onChange={(value) => set('expiry', value)}
                  options={EXPIRY_CHOICES.map((choice) => ({ value: choice.id, label: t(choice.labelKey) }))}
                />
              </Field>
            </div>
            <div className='min-w-0 space-y-3'>
              <PlanSelector
                id={`${formId}-plan`}
                showSummary={false}
                value={draft.planId === ANY ? '' : draft.planId}
                plans={plans}
                available={available}
                onChange={(next) => set('planId', next === '' ? ANY : next)}
                onPlanCreated={onPlanCreated}
                creating={creating}
                onCreatingChange={onCreatingChange}
                createdNote={createdNote}
                onDismissCreatedNote={onDismissCreatedNote}
                disabledTargets={disabledTargets}
                disabledHint={disabledHint}
              />

              <TokenPolicyFields
                policy={draft.policy}
                onChange={(policy) => set('policy', policy)}
                plan={plans.find((plan) => plan.id === draft.planId)}
                available={available}
                scopes={draft.surfaces}
              />
            </div>
          </div>
          <div className='flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end'>
            {creating ? (
              <span className='mr-auto text-[12px] leading-snug text-muted-foreground'>
                {t('access.token.creatingPlanFirst')}
              </span>
            ) : null}
            <RButton variant='outline' onClick={onCancel}>
              {t('common.cancel')}
            </RButton>
            <RButton variant='primary' icon='ri-key-2-line' type='submit' disabled={issueDisabled}>
              {t('settings.access.issueToken')}
            </RButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
