/**
 * New / edit plan, as a dialog over the Plans list.
 *
 * Providers first, then that provider's models: an install can have
 * dozens of models across a handful of providers, and one flat list of
 * them is a scroll hunt. Each provider chip counts what is ticked under
 * it out of what it has, so a choice made on another provider is never
 * out of sight. Select all · Clear act on every provider at once, and the
 * header checkbox of the provider on show on that provider alone — kept
 * out of the chips, so a chip only ever navigates.
 *
 * A tick for the allow-list and a radio for the default sit on the same
 * row, so the default can only ever be one of the allowed models. The
 * default is never picked for the operator: a change that removes it
 * clears it and disables Save, and Select all keeps one but never chooses
 * one. It is where every unlisted request goes, so moving it silently
 * could move a plan onto a costlier model.
 */
import { cn } from 'cn'
import { type ReactNode, useId, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { RButton } from '@/components/rialto/primitives'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { PlanWire } from '@/lib/api'
import {
  chooseDefault,
  clearModels,
  groupTargets,
  isSpendField,
  LIMIT_FIELDS,
  type LimitField,
  modelOf,
  type PlanDraft,
  type ProviderGroup,
  type ProviderSelection,
  planInputOf,
  providerOf,
  providerSelection,
  readLimit,
  selectAllModels,
  toggleModel,
  toggleProvider
} from '@/lib/rialto/settings/plans'

const INPUT =
  'h-8 w-full min-w-0 rounded-md border border-border bg-transparent px-3 text-xs outline-none focus:border-foreground/40'

const Label = ({ children }: { children: ReactNode }) => (
  <div className='mb-1 text-[12px] text-muted-foreground'>{children}</div>
)

const Hint = ({ children, id }: { children: ReactNode; id?: string }) => (
  <p id={id} className='mt-1 text-[12px] leading-snug text-muted-foreground'>
    {children}
  </p>
)

/**
 * The mock's checkbox: a filled box with a tick, a dash when mixed. Drawn
 * beside a visually hidden native input, which carries the checked /
 * mixed state, the keyboard and the focus ring (the `peer` before it).
 */
function CheckBox({ state }: { state: ProviderSelection }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex size-4 shrink-0 items-center justify-center rounded border peer-focus-visible:ring-2 peer-focus-visible:ring-ring/50',
        state === 'none' ? 'border-border' : 'border-primary bg-primary text-primary-foreground'
      )}
    >
      {state === 'none' ? null : (
        <i
          aria-hidden
          className={cn(state === 'all' ? 'ri-check-line' : 'ri-subtract-line', 'text-[11px] leading-none')}
        />
      )}
    </span>
  )
}

function ModelOption({
  target,
  radioName,
  allowed,
  isDefault,
  onToggle,
  onDefault
}: {
  target: string
  /** The default radios' shared name, one per dialog. */
  radioName: string
  allowed: boolean
  isDefault: boolean
  onToggle: () => void
  onDefault: () => void
}) {
  const { t } = useTranslation()
  const model = modelOf(target)
  return (
    <div className='flex h-9 items-center gap-2 border-t border-border/60 px-3 first:border-t-0'>
      <label className='inline-flex shrink-0 cursor-pointer'>
        <input
          type='checkbox'
          checked={allowed}
          onChange={onToggle}
          aria-label={t('access.plans.allowModel', { model })}
          className='peer sr-only'
        />
        <CheckBox state={allowed ? 'all' : 'none'} />
      </label>
      <span className={cn('min-w-0 flex-1 truncate font-mono text-xs', allowed ? '' : 'text-muted-foreground')}>
        {model}
      </span>
      {allowed ? (
        <label
          className={cn(
            'inline-flex cursor-pointer items-center gap-1 text-[12px]',
            isDefault ? 'text-foreground' : 'text-muted-foreground/60'
          )}
        >
          <input
            type='radio'
            name={radioName}
            checked={isDefault}
            onChange={onDefault}
            aria-label={t('access.plans.useAsDefault', { model })}
            className='peer sr-only'
          />
          <span
            aria-hidden
            className={cn(
              'inline-flex size-3.5 items-center justify-center rounded-full border peer-focus-visible:ring-2 peer-focus-visible:ring-ring/50',
              isDefault ? 'border-primary' : 'border-border'
            )}
          >
            {isDefault ? <span className='size-1.5 rounded-full bg-primary' /> : null}
          </span>
          {t('access.plans.default')}
        </label>
      ) : null}
    </div>
  )
}

function ProviderChip({
  group,
  picked,
  on,
  onClick
}: {
  group: ProviderGroup
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
      {group.provider}
      <span className='font-mono text-[12px] tabular-nums text-muted-foreground'>
        {picked}/{group.targets.length}
      </span>
    </button>
  )
}

/** Bulk actions, provider chips, the chosen provider's models, then what is picked. */
function ModelPicker({
  draft,
  available,
  statusId,
  onChange
}: {
  draft: PlanDraft
  available: readonly string[]
  /** The status line's id, which Save points at to say why it is disabled. */
  statusId: string
  onChange: (next: PlanDraft) => void
}) {
  const { t } = useTranslation()
  const groups = groupTargets(available, draft.models)
  // Opens on the default's provider, where the plan's main choice is.
  const [provider, setProvider] = useState(() => {
    if (draft.defaultModel !== '') return providerOf(draft.defaultModel)
    return groups.length === 0 ? '' : groups[0].provider
  })
  const found = groups.find((group) => group.provider === provider)
  const current = found === undefined && groups.length > 0 ? groups[0] : found
  const radioName = useId()
  const selection = current === undefined ? 'none' : providerSelection(draft, current)
  const pickedIn = (group: ProviderGroup) => group.targets.filter((target) => draft.models.includes(target)).length
  return (
    <div>
      <div className='flex items-center justify-between'>
        <Label>{t('access.plans.models')}</Label>
        <div className='flex items-center gap-1 text-[12px] text-muted-foreground'>
          <span>{t('access.plans.allProviders')}</span>
          <RButton onClick={() => onChange(selectAllModels(draft, groups))} disabled={groups.length === 0}>
            {t('access.plans.selectAll')}
          </RButton>
          <span>·</span>
          <RButton onClick={() => onChange(clearModels(draft))} disabled={draft.models.length === 0}>
            {t('access.plans.clear')}
          </RButton>
        </div>
      </div>
      {current === undefined ? (
        <p className='text-[12px] text-muted-foreground'>{t('access.plans.noModels')}</p>
      ) : (
        <>
          <div className='mb-2 flex flex-wrap gap-1.5'>
            {groups.map((group) => (
              <ProviderChip
                key={group.provider}
                group={group}
                picked={pickedIn(group)}
                on={group.provider === current.provider}
                onClick={() => setProvider(group.provider)}
              />
            ))}
          </div>
          <div className='rounded-md border border-border'>
            <label className='flex h-9 w-full cursor-pointer items-center gap-2 border-b border-border/60 px-3 text-xs'>
              <input
                type='checkbox'
                // Mixed is a DOM property, not an attribute: set on every
                // render so the box follows the selection.
                ref={(input) => {
                  if (input !== null) input.indeterminate = selection === 'some'
                }}
                checked={selection === 'all'}
                onChange={() => onChange(toggleProvider(draft, current))}
                className='peer sr-only'
              />
              <CheckBox state={selection} />
              {t('access.plans.allowAll', { provider: current.provider })}
              <span className='text-muted-foreground'>
                {pickedIn(current)}/{current.targets.length}
              </span>
            </label>
            <div className='max-h-44 overflow-y-auto'>
              {current.targets.map((target) => (
                <ModelOption
                  key={target}
                  target={target}
                  radioName={radioName}
                  allowed={draft.models.includes(target)}
                  isDefault={draft.defaultModel === target}
                  onToggle={() => onChange(toggleModel(draft, target))}
                  onDefault={() => onChange(chooseDefault(draft, target))}
                />
              ))}
            </div>
          </div>
        </>
      )}
      <p id={statusId} aria-live='polite' className='mt-1 text-[12px] leading-snug text-muted-foreground'>
        {draft.models.includes(draft.defaultModel) ? (
          <Trans
            i18nKey='access.plans.modelStatus'
            values={{ n: draft.models.length, model: draft.defaultModel }}
            components={{ mono: <span className='font-mono' /> }}
          />
        ) : (
          t('access.plans.modelStatusNoDefault', { n: draft.models.length })
        )}
      </p>
      <Hint>{t('access.plans.selectAllHint')}</Hint>
      <Hint>{t('access.plans.defaultHint')}</Hint>
    </div>
  )
}

/** The four usage-window limits: a row per window, a column per measure. */
function LimitFields({ draft, onChange }: { draft: PlanDraft; onChange: (next: PlanDraft) => void }) {
  const { t } = useTranslation()
  const allOk = LIMIT_FIELDS.every((field) => readLimit(field, draft.limits[field]).ok)
  const rows: readonly { label: string; fields: readonly [LimitField, LimitField] }[] = [
    { label: t('access.plans.window5h'), fields: ['fiveHourRequestLimit', 'fiveHourSpendLimitUsd'] },
    { label: t('access.plans.window7d'), fields: ['sevenDayRequestLimit', 'sevenDaySpendLimitUsd'] }
  ]
  return (
    <div>
      <Label>{t('access.plans.limits')}</Label>
      <div className='grid grid-cols-[5rem_1fr_1fr] items-center gap-2 text-xs'>
        <span />
        <span className='text-muted-foreground'>{t('access.plans.limitRequests')}</span>
        <span className='text-muted-foreground'>{t('access.plans.limitSpend')}</span>
        {rows.map((row) => (
          <LimitRow key={row.label} label={row.label} fields={row.fields} draft={draft} onChange={onChange} />
        ))}
      </div>
      {allOk ? (
        <Hint>{t('access.plans.limitsHint')}</Hint>
      ) : (
        <p className='mt-1 text-[12px] leading-snug text-destructive'>{t('access.plans.limitsInvalid')}</p>
      )}
      <Hint>{t('access.plans.limitsWindowHint')}</Hint>
    </div>
  )
}

function LimitRow({
  label,
  fields,
  draft,
  onChange
}: {
  label: string
  fields: readonly [LimitField, LimitField]
  draft: PlanDraft
  onChange: (next: PlanDraft) => void
}) {
  const { t } = useTranslation()
  return (
    <>
      <span>{label}</span>
      {fields.map((field) => (
        <input
          key={field}
          type='number'
          min={0}
          step={isSpendField(field) ? '0.01' : '1'}
          aria-label={t(isSpendField(field) ? 'access.plans.limitSpendAria' : 'access.plans.limitRequestsAria', {
            window: label
          })}
          value={draft.limits[field]}
          placeholder={t('access.plans.noLimit')}
          onChange={(e) => onChange({ ...draft, limits: { ...draft.limits, [field]: e.target.value } })}
          className={cn(INPUT, 'font-mono', readLimit(field, draft.limits[field]).ok ? '' : 'border-destructive/60')}
        />
      ))}
    </>
  )
}

/** Who an edit reaches, or that a new plan has nobody on it yet. */
function AppliesTo({ plan }: { plan: PlanWire | null }) {
  const { t } = useTranslation()
  return (
    <div className='rounded-md border border-dashed border-border px-3 py-2 text-[12px] leading-snug text-muted-foreground'>
      {plan === null ? (
        t('access.plans.createNote')
      ) : (
        <Trans
          i18nKey={plan.tokenCount === 1 ? 'access.plans.appliesToOne' : 'access.plans.appliesTo'}
          values={{ n: plan.tokenCount, name: plan.name }}
          components={{ strong: <span className='font-medium text-foreground' /> }}
        />
      )}
    </div>
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
  const statusId = useId()
  const inUse = plan !== null && plan.tokenCount > 0

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
          <div>
            <Label>{t('access.plans.name')}</Label>
            <input
              autoFocus={plan === null}
              type='text'
              aria-label={t('access.plans.nameAria')}
              value={draft.name}
              placeholder={t('access.plans.namePlaceholder')}
              onChange={(e) => onChange({ ...draft, name: e.target.value })}
              className={INPUT}
            />
          </div>

          <ModelPicker draft={draft} available={available} statusId={statusId} onChange={onChange} />

          <LimitFields draft={draft} onChange={onChange} />

          <AppliesTo plan={plan} />
        </div>

        <div className='flex flex-col-reverse gap-2 sm:flex-row sm:items-center'>
          {/* Not in the mock, kept so a plan can still be removed: offered
              only while nothing is on the plan, since the server refuses
              the rest — removing a plan would lift its tokens' limits. */}
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
              icon='ri-check-line'
              aria-describedby={statusId}
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
