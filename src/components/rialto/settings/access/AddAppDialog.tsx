/**
 * Authorize an app, as a dialog over the Apps list — the same shape as
 * issuing a token over the Tokens list, and for the same reason: the app
 * being added is decided against the ones already there.
 *
 * The plan is required. An app whose installs got unrestricted tokens
 * would hand anyone with the App Store build the whole proxy.
 */
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { RButton } from '@/components/rialto/primitives'
import { Picker } from '@/components/rialto/settings/access/pickers'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { PlanWire } from '@/lib/api'

export interface AppDraft {
  name: string
  appleAppId: string
  planId: string
  allowDevelopment: boolean
}

export const emptyAppDraft = (plans: readonly PlanWire[]): AppDraft => ({
  name: '',
  appleAppId: '',
  planId: plans.length === 0 ? '' : plans[0].id,
  allowDevelopment: false
})

// The server's own check, so Add stays disabled rather than answering a
// typo with a 400. Team IDs are ten uppercase alphanumerics.
const APPLE_APP_ID = /^[A-Z0-9]{10}\.[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/

export const appDraftReady = (draft: AppDraft): boolean =>
  draft.name.trim().length > 0 && APPLE_APP_ID.test(draft.appleAppId.trim()) && draft.planId.length > 0

const INPUT =
  'flex h-8 w-full items-center rounded-md border border-border bg-transparent px-3 font-mono text-xs outline-none focus:border-foreground/40'

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <div className='mb-1 text-[12px] text-muted-foreground'>{label}</div>
      {children}
      {hint === undefined ? null : <p className='mt-1 text-[12px] leading-snug text-muted-foreground'>{hint}</p>}
    </div>
  )
}

export function AddAppDialog({
  draft,
  plans,
  saving,
  onChange,
  onSubmit,
  onCancel
}: {
  draft: AppDraft
  plans: readonly PlanWire[]
  saving: boolean
  onChange: (next: AppDraft) => void
  onSubmit: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const set = <K extends keyof AppDraft>(key: K, value: AppDraft[K]) => onChange({ ...draft, [key]: value })

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <DialogContent className='max-h-[calc(100vh-4rem)] overflow-y-auto sm:max-w-md'>
        <DialogHeader>
          <DialogTitle className='text-sm'>{t('access.apps.addTitle')}</DialogTitle>
        </DialogHeader>

        <div className='grid gap-4'>
          <Field label={t('access.apps.name')}>
            <input
              autoFocus
              type='text'
              value={draft.name}
              placeholder='Connect'
              onChange={(e) => set('name', e.target.value)}
              className={INPUT}
            />
          </Field>

          <Field label={t('access.apps.appId')} hint={t('access.apps.appIdHint')}>
            <input
              type='text'
              value={draft.appleAppId}
              placeholder='ABCDE12345.com.example.app'
              onChange={(e) => set('appleAppId', e.target.value)}
              className={INPUT}
            />
          </Field>

          <Field
            label={t('access.apps.planForNew')}
            hint={plans.length === 0 ? t('access.apps.noPlans') : t('access.apps.planForNewHint')}
          >
            <Picker label={t('access.apps.planForNew')} value={draft.planId} onChange={(v) => set('planId', v)}>
              {plans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.name}
                </option>
              ))}
            </Picker>
          </Field>

          <label className='flex cursor-pointer items-start gap-2'>
            <input
              type='checkbox'
              checked={draft.allowDevelopment}
              onChange={(e) => set('allowDevelopment', e.target.checked)}
              className='mt-0.5 size-4 shrink-0 accent-primary'
            />
            <span>
              <span className='block text-xs font-medium'>{t('access.apps.acceptDevelopment')}</span>
              <span className='block text-[12px] leading-snug text-muted-foreground'>
                {t('access.apps.acceptDevelopmentHint')}
              </span>
            </span>
          </label>
        </div>

        <div className='flex flex-col-reverse gap-2 sm:flex-row sm:justify-end'>
          <RButton variant='ghost' onClick={onCancel}>
            {t('common.cancel')}
          </RButton>
          <RButton variant='primary' icon='ri-add-line' onClick={onSubmit} disabled={saving || !appDraftReady(draft)}>
            {t('access.apps.add')}
          </RButton>
        </div>
      </DialogContent>
    </Dialog>
  )
}
