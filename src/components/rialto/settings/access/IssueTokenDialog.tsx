import { useId, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useConfig } from '@/components/ConfigProvider'
import { RButton } from '@/components/rialto/primitives'
import { SelectPicker } from '@/components/rialto/SelectPicker'
import { PlanSelector } from '@/components/rialto/settings/access/PlanSelector'
import { ANY, SurfacePicker } from '@/components/rialto/settings/access/pickers'
import { FolderPicker, TokenPolicyFields } from '@/components/rialto/settings/access/TokenPolicyFields'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
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
    <AlertDialog
      open
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <AlertDialogContent className='max-h-[calc(100vh-4rem)] overflow-y-auto data-[size=default]:max-w-[calc(100%-2rem)] data-[size=default]:sm:max-w-2xl'>
        <AlertDialogHeader className='justify-items-start text-left'>
          <AlertDialogTitle className='text-sm'>{t('settings.access.issueTitle')}</AlertDialogTitle>
          <AlertDialogDescription className='sr-only'>
            {t('settings.access.issueDialogDescription')}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <form
          className='grid gap-6'
          onSubmit={(event) => {
            event.preventDefault()
            if (!issueDisabled) onSubmit()
          }}
        >
          <div className='grid gap-4 sm:grid-cols-2 sm:gap-6'>
            <FieldGroup className='min-w-0 gap-3'>
              <Field className='gap-2'>
                <FieldLabel className='text-xs' htmlFor={`${formId}-name`}>
                  {t('settings.access.issueName')}
                </FieldLabel>
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

              <Field className='gap-2'>
                <FieldLabel className='text-xs' htmlFor={`${formId}-endpoint`}>
                  {t('settings.access.issueEndpoint')}
                </FieldLabel>
                <SurfacePicker
                  id={`${formId}-endpoint`}
                  surfaces={surfaces}
                  selected={draft.surfaces}
                  onChange={(next) => set('surfaces', next)}
                  allLabel={t('settings.access.standardEndpoints')}
                  showHint={false}
                />
              </Field>

              <Field className='gap-2'>
                <FieldLabel className='text-xs' htmlFor={`${formId}-folder`}>
                  {t('settings.access.folder')}
                </FieldLabel>
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
                        restrictModels: draft.policy.restrictModels,
                        // Folders carry no per-model rules, so a folder change keeps the ones set here.
                        modelProviderRules: draft.policy.modelProviderRules
                      }
                    })
                  }}
                />
              </Field>
              <Field className='gap-2'>
                <FieldLabel className='text-xs' htmlFor={`${formId}-expires`}>
                  {t('settings.access.issueExpires')}
                </FieldLabel>
                <SelectPicker
                  id={`${formId}-expires`}
                  label={t('settings.access.issueExpires')}
                  value={draft.expiry}
                  className='w-full'
                  onChange={(value) => set('expiry', value)}
                  options={EXPIRY_CHOICES.map((choice) => ({ value: choice.id, label: t(choice.labelKey) }))}
                />
              </Field>
            </FieldGroup>
            <FieldGroup className='min-w-0 gap-3'>
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
              />
            </FieldGroup>
          </div>
          <AlertDialogFooter className='sm:items-center'>
            {creating ? (
              <span className='mr-auto text-[12px] leading-snug text-muted-foreground'>
                {t('access.token.creatingPlanFirst')}
              </span>
            ) : null}
            <AlertDialogCancel type='button' size='sm' className='px-3 text-xs'>
              {t('common.cancel')}
            </AlertDialogCancel>
            <RButton variant='primary' icon='ri-key-2-line' type='submit' disabled={issueDisabled}>
              {t('settings.access.issueToken')}
            </RButton>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  )
}
