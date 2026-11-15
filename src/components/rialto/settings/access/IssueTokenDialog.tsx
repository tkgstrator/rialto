import { type ReactNode, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useConfig } from '@/components/ConfigProvider'
import { RButton } from '@/components/rialto/primitives'
import { PlanSelector } from '@/components/rialto/settings/access/PlanSelector'
import { ANY, Picker, SurfacePicker } from '@/components/rialto/settings/access/pickers'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { InboundSurfaceWire, PlanWire } from '@/lib/api'
import { EXPIRY_CHOICES } from '@/lib/rialto/settings/access-tokens'
import { targetMatchesSurfaces } from '@/lib/rialto/settings/surface-model-compat'

export interface IssueDraft {
  name: string
  surfaces: string[]
  expiry: string
  planId: string
}

export const emptyDraft = (): IssueDraft => ({ name: '', surfaces: [], expiry: 'never', planId: ANY })

function Field({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div>
      <div className='mb-1 text-[12px] text-muted-foreground'>{label}</div>
      {children}
      <p className='mt-1 text-[12px] leading-snug text-muted-foreground'>{hint}</p>
    </div>
  )
}

export function IssueTokenDialog({
  draft,
  surfaces,
  plans,
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
      <DialogContent className='max-h-[calc(100vh-4rem)] overflow-y-auto sm:max-w-md'>
        <DialogHeader>
          <DialogTitle className='text-sm'>{t('settings.access.issueTitle')}</DialogTitle>
        </DialogHeader>

        <div className='space-y-3'>
          <Field label={t('settings.access.issueName')} hint={t('settings.access.issueNameHint')}>
            <input
              autoFocus
              type='text'
              value={draft.name}
              placeholder={t('settings.access.issueNamePlaceholder')}
              onChange={(e) => set('name', e.target.value)}
              className='flex h-8 w-full items-center rounded-md border border-border bg-transparent px-3 font-mono text-xs outline-none focus:border-foreground/40'
            />
          </Field>

          <Field label={t('settings.access.issueEndpoint')} hint={t('settings.access.issueEndpointHint')}>
            <SurfacePicker
              surfaces={surfaces}
              selected={draft.surfaces}
              onChange={(next) => set('surfaces', next)}
              allLabel={t('settings.access.allEndpoints')}
            />
          </Field>

          <PlanSelector
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

          <Field label={t('settings.access.issueExpires')} hint={t('settings.access.issueExpiresHint')}>
            <Picker label={t('settings.access.issueExpires')} value={draft.expiry} onChange={(v) => set('expiry', v)}>
              {EXPIRY_CHOICES.map((c) => (
                <option key={c.id} value={c.id}>
                  {t(c.labelKey)}
                </option>
              ))}
            </Picker>
          </Field>

          <p className='text-[12px] leading-relaxed text-muted-foreground'>
            <i className='ri-information-line mr-1 align-[-1px]' />
            {t('settings.access.issueOnceNote')}
          </p>
        </div>

        <div className='flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end'>
          {creating ? (
            <span className='mr-auto text-[12px] leading-snug text-muted-foreground'>
              {t('access.token.creatingPlanFirst')}
            </span>
          ) : null}
          <RButton variant='ghost' onClick={onCancel}>
            {t('common.cancel')}
          </RButton>
          <RButton variant='primary' icon='ri-key-2-line' onClick={onSubmit} disabled={issueDisabled}>
            {t('settings.access.issueToken')}
          </RButton>
        </div>
      </DialogContent>
    </Dialog>
  )
}
