/**
 * New / edit plan, as a dialog over the Plans list.
 *
 * Providers first, then that provider's models: an install can have
 * dozens of models across a handful of providers, and one flat list of
 * them is a scroll hunt. Each provider chip counts what is ticked under
 * it, so a choice made on another provider is never out of sight.
 *
 * A tick for the allow-list and a radio for the default sit on the same
 * row, so the default can only ever be one of the allowed models.
 */
import { cn } from 'cn'
import { type ReactNode, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { RButton } from '@/components/rialto/primitives'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { PlanWire } from '@/lib/api'
import {
  groupTargets,
  modelOf,
  type PlanDraft,
  planInputOf,
  providerOf,
  readCap,
  toggleModel
} from '@/lib/rialto/settings/plans'

const INPUT =
  'flex h-8 w-full items-center rounded-md border border-border bg-transparent px-3 font-mono text-xs outline-none focus:border-foreground/40'

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className='mb-1 text-[12px] text-muted-foreground'>{label}</div>
      {children}
      {hint === undefined ? null : <p className='mt-1 text-[12px] leading-snug text-muted-foreground'>{hint}</p>}
    </div>
  )
}

function ModelOption({
  target,
  allowed,
  isDefault,
  onToggle,
  onDefault
}: {
  target: string
  allowed: boolean
  isDefault: boolean
  onToggle: () => void
  onDefault: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className='flex h-9 items-center gap-2 border-t border-border/60 px-3 first:border-t-0'>
      <label className='flex min-w-0 flex-1 cursor-pointer items-center gap-2'>
        <input type='checkbox' checked={allowed} onChange={onToggle} className='size-4 shrink-0 accent-primary' />
        <span className={cn('min-w-0 flex-1 truncate font-mono text-xs', allowed ? '' : 'text-muted-foreground')}>
          {modelOf(target)}
        </span>
      </label>
      {allowed ? (
        <label
          className={cn(
            'inline-flex cursor-pointer items-center gap-1 text-[12px]',
            isDefault ? 'text-foreground' : 'text-muted-foreground/60'
          )}
        >
          <input
            type='radio'
            name='plan-default'
            checked={isDefault}
            onChange={onDefault}
            className='size-3.5 accent-primary'
          />
          {t('access.plans.default')}
        </label>
      ) : null}
    </div>
  )
}

/** Provider chips, then the chosen provider's models, then what is picked. */
function ModelPicker({
  draft,
  available,
  onChange
}: {
  draft: PlanDraft
  available: readonly string[]
  onChange: (next: PlanDraft) => void
}) {
  const { t } = useTranslation()
  const groups = groupTargets(available, draft.models)
  // Opens on the default's provider, where the plan's main choice is.
  const [provider, setProvider] = useState(() => {
    if (draft.defaultModel !== '') return providerOf(draft.defaultModel)
    return groups.length === 0 ? '' : groups[0].provider
  })
  const current = groups.find((group) => group.provider === provider)
  return (
    <div>
      <div className='mb-1 text-[12px] text-muted-foreground'>{t('access.plans.models')}</div>
      {groups.length === 0 ? (
        <p className='text-[12px] text-muted-foreground'>{t('access.plans.noModels')}</p>
      ) : (
        <>
          <div className='mb-2 flex flex-wrap gap-1.5'>
            {groups.map((group) => (
              <ProviderChip
                key={group.provider}
                provider={group.provider}
                picked={group.targets.filter((target) => draft.models.includes(target)).length}
                on={group.provider === provider}
                onClick={() => setProvider(group.provider)}
              />
            ))}
          </div>
          <div className='max-h-44 overflow-y-auto rounded-md border border-border'>
            {(current === undefined ? [] : current.targets).map((target) => (
              <ModelOption
                key={target}
                target={target}
                allowed={draft.models.includes(target)}
                isDefault={draft.defaultModel === target}
                onToggle={() => onChange(toggleModel(draft, target))}
                onDefault={() => onChange({ ...draft, defaultModel: target })}
              />
            ))}
          </div>
        </>
      )}
      <p className='mt-1 text-[12px] leading-snug text-muted-foreground'>
        {draft.models.length === 0 ? (
          t('access.plans.pickOne')
        ) : (
          <Trans
            i18nKey='access.plans.modelsSummary'
            values={{ n: draft.models.length, model: draft.defaultModel }}
            components={{ mono: <span className='font-mono' /> }}
          />
        )}
      </p>
    </div>
  )
}

function ProviderChip({
  provider,
  picked,
  on,
  onClick
}: {
  provider: string
  /** Models ticked under this provider, so a choice made here stays visible from the others. */
  picked: number
  on: boolean
  onClick: () => void
}) {
  return (
    <button
      type='button'
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors',
        on ? 'border-foreground/60 bg-muted font-medium' : 'border-border text-muted-foreground hover:bg-muted/60'
      )}
    >
      {provider}
      {picked > 0 ? <span className='font-mono text-[12px] tabular-nums text-muted-foreground'>{picked}</span> : null}
    </button>
  )
}

export function PlanDialog({
  plan,
  draft,
  available,
  saving,
  onChange,
  onSubmit,
  onDelete,
  onCancel
}: {
  /** The plan being edited; null for a new one. */
  plan: PlanWire | null
  draft: PlanDraft
  /** Every `provider,model` the operator has left routable. */
  available: readonly string[]
  saving: boolean
  onChange: (next: PlanDraft) => void
  onSubmit: () => void
  onDelete: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const capOk = readCap(draft.cap).ok
  const inUse = plan !== null && (plan.tokenCount > 0 || plan.apps.length > 0)

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <DialogContent className='max-h-[calc(100vh-4rem)] overflow-y-auto sm:max-w-md'>
        <DialogHeader>
          <DialogTitle className='text-sm'>
            {t(plan === null ? 'access.plans.newTitle' : 'access.plans.editTitle')}
          </DialogTitle>
        </DialogHeader>

        <div className='grid gap-4'>
          <Field label={t('access.plans.name')}>
            <input
              autoFocus={plan === null}
              type='text'
              value={draft.name}
              placeholder='Free'
              onChange={(e) => onChange({ ...draft, name: e.target.value })}
              className={INPUT}
            />
          </Field>

          <ModelPicker draft={draft} available={available} onChange={onChange} />

          <Field
            label={t('access.plans.dailyCap')}
            hint={capOk ? t('access.plans.dailyCapHint') : t('access.plans.dailyCapInvalid')}
          >
            <input
              type='text'
              inputMode='numeric'
              value={draft.cap}
              placeholder={t('access.plans.noCap')}
              onChange={(e) => onChange({ ...draft, cap: e.target.value })}
              className={cn(INPUT, capOk ? '' : 'border-destructive/60')}
            />
          </Field>

          {plan === null ? null : (
            <div className='rounded-md border border-dashed border-border px-3 py-2 text-[12px] leading-snug text-muted-foreground'>
              <Trans
                i18nKey='access.plans.appliesTo'
                values={{ n: plan.tokenCount, name: plan.name }}
                components={{ strong: <span className='font-medium text-foreground' /> }}
              />
            </div>
          )}
        </div>

        <div className='flex flex-col-reverse gap-2 sm:flex-row sm:items-center'>
          {/* Offered only while nothing is on the plan: the server refuses
              the rest, because removing a plan would lift its tokens' caps. */}
          {plan === null ? null : (
            <RButton
              variant='danger'
              icon='ri-delete-bin-line'
              onClick={onDelete}
              disabled={saving || inUse}
              title={inUse ? t('access.plans.deleteInUse') : undefined}
            >
              {t('settings.access.delete')}
            </RButton>
          )}
          <div className='flex flex-col-reverse gap-2 sm:ml-auto sm:flex-row'>
            <RButton variant='ghost' onClick={onCancel}>
              {t('common.cancel')}
            </RButton>
            <RButton
              variant='primary'
              icon={plan === null ? 'ri-add-line' : 'ri-check-line'}
              onClick={onSubmit}
              disabled={saving || planInputOf(draft) === null}
            >
              {t(plan === null ? 'access.plans.create' : 'common.save')}
            </RButton>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
