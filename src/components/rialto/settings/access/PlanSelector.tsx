/**
 * The access-token form's plan field.
 *
 * Not a native <select>: "Create a plan…" is an action, not a value, and
 * `<option>` cannot run one. The trigger opens a listbox popover; its
 * options are "No plan (unrestricted)", every plan with a model count,
 * a divider, then Create a plan… — and picking that reveals the same
 * plan editor the Plans dialog uses, inline under the trigger.
 *
 * When a plan is picked, a read-only summary sits under the trigger: the
 * plan's name, who else is on it, its models, its limits and a hint
 * about 403 / 429. The summary is the point of the field — a select
 * carrying only "Plus" asks the operator to remember what Plus allows,
 * and the answer decides whether the client's next request is served or
 * refused with 403.
 */
import { cn } from 'cn'
import { useId, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { RButton } from '@/components/rialto/primitives'
import { PlanEditorBody } from '@/components/rialto/settings/access/PlanEditorBody'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { api, type PlanWire } from '@/lib/api'
import { emptyPlanDraft, type PlanDraft, planInputOf } from '@/lib/rialto/settings/plans'

const LABEL = 'text-[12px] text-muted-foreground'
const HINT = 'text-[12px] leading-snug text-muted-foreground'

/** The sentinel the parent uses to say "no plan"; the wire sends null. */
export const PLAN_NONE = ''

interface PlanSelectorProps {
  /** '' = no plan, otherwise a plan id. */
  value: string
  plans: readonly PlanWire[]
  /** `provider,model` ids the operator has left routable (for the inline new-plan form). */
  available: readonly string[]
  onChange: (next: string) => void
  /** Called after POST /api/plans succeeds. Parent merges into its list and typically selects it via onChange. */
  onPlanCreated: (plan: PlanWire) => void
  /** True while the inline new-plan form is open — the parent disables its primary action on this. */
  creating: boolean
  onCreatingChange: (next: boolean) => void
  /** Plan name for the "Plan {name} created and selected" one-shot note, or null. Parent clears on next pick. */
  createdNote: string | null
  onDismissCreatedNote: () => void
  disabled?: boolean
  /**
   * The edit page already renders its label and hint through SettingsField's
   * 14rem column, so the selector draws only its trigger + summary there.
   * The dialog uses the stacked layout the mock describes — label, trigger,
   * hint, then the extra (summary / new-plan form / no-plan note).
   */
  showLabel?: boolean
}

function triggerLabelOf(value: string, plans: readonly PlanWire[], creating: boolean, t: (k: string) => string) {
  if (creating) {
    return (
      <span className='inline-flex items-center gap-1.5'>
        <i aria-hidden className='ri-add-line text-sm' />
        {t('access.token.newPlanLabel')}
      </span>
    )
  }
  if (value === PLAN_NONE) return t('access.token.noPlanOption')
  const selected = plans.find((plan) => plan.id === value)
  // A plan referenced on the token but not in the list — keep the id
  // visible rather than drawing a blank trigger.
  return selected === undefined ? value : selected.name
}

function planExtra({
  value,
  selected,
  creating,
  createdNote,
  draft,
  available,
  statusId,
  saving,
  duplicate,
  canCreate,
  onDraftChange,
  onCreate,
  onCancel
}: {
  value: string
  selected: PlanWire | undefined
  creating: boolean
  createdNote: string | null
  draft: PlanDraft
  available: readonly string[]
  statusId: string
  saving: boolean
  duplicate: boolean
  canCreate: boolean
  onDraftChange: (next: PlanDraft) => void
  onCreate: () => void
  onCancel: () => void
}) {
  if (creating) {
    return (
      <InlineNewPlanForm
        draft={draft}
        available={available}
        statusId={statusId}
        saving={saving}
        duplicate={duplicate}
        canCreate={canCreate}
        onChange={onDraftChange}
        onCreate={onCreate}
        onCancel={onCancel}
      />
    )
  }
  if (value === PLAN_NONE) return <NoPlanNote />
  if (selected === undefined) return null
  return <PlanSummary plan={selected} createdNote={createdNote} />
}

export function PlanSelector({
  value,
  plans,
  available,
  onChange,
  onPlanCreated,
  creating,
  onCreatingChange,
  createdNote,
  onDismissCreatedNote,
  disabled,
  showLabel = true
}: PlanSelectorProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<PlanDraft>(emptyPlanDraft())
  const [saving, setSaving] = useState(false)
  const statusId = useId()

  const selected = plans.find((plan) => plan.id === value)

  const pick = (next: string) => {
    onChange(next)
    onDismissCreatedNote()
    onCreatingChange(false)
    setOpen(false)
  }

  const startCreate = () => {
    setOpen(false)
    onCreatingChange(true)
    setDraft(emptyPlanDraft())
    onDismissCreatedNote()
  }

  const cancelCreate = () => {
    onCreatingChange(false)
    setDraft(emptyPlanDraft())
  }

  const createPlan = () => {
    const input = planInputOf(draft)
    if (input === null) return
    setSaving(true)
    api
      .createPlan(input)
      .then((plan) => {
        onPlanCreated(plan)
        onCreatingChange(false)
        setDraft(emptyPlanDraft())
      })
      .catch((e: Error) => toast.error(t('access.token.planCreateFailed', { message: e.message })))
      .finally(() => setSaving(false))
  }

  const duplicate =
    draft.name.trim().length > 0 &&
    plans.some((plan) => plan.name.trim().toLowerCase() === draft.name.trim().toLowerCase())
  const canCreate = !saving && !duplicate && planInputOf(draft) !== null

  // `showLabel` controls the stacking: in the dialog, the field draws its
  // own label and hint around the trigger and the extra; on the edit page
  // the outer SettingsField already carries them.
  return (
    <div>
      {showLabel ? <div className={cn('mb-1', LABEL)}>{t('access.token.plan')}</div> : null}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <div className='relative'>
            <button
              type='button'
              aria-label={t('access.token.plan')}
              aria-haspopup='listbox'
              aria-expanded={open}
              disabled={disabled}
              onClick={() => setOpen(true)}
              className={cn(
                'relative flex h-8 w-full items-center rounded-md border border-border pl-3 pr-8 text-left font-mono text-xs transition-colors hover:bg-muted/60',
                'disabled:pointer-events-none disabled:opacity-50'
              )}
            >
              {triggerLabelOf(value, plans, creating, t)}
            </button>
            <i
              aria-hidden
              className='ri-arrow-down-s-line pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground'
            />
          </div>
        </PopoverAnchor>
        <PopoverContent
          align='start'
          sideOffset={4}
          className='w-(--radix-popover-trigger-width) min-w-[var(--radix-popover-trigger-width)] p-1'
        >
          <PlanListbox value={value} plans={plans} creating={creating} onPick={pick} onStartCreate={startCreate} />
        </PopoverContent>
      </Popover>
      {showLabel ? <p className={cn('mt-1', HINT)}>{t('access.token.planFormHint')}</p> : null}

      {planExtra({
        value,
        selected,
        creating,
        createdNote,
        draft,
        available,
        statusId,
        saving,
        duplicate,
        canCreate,
        onDraftChange: setDraft,
        onCreate: createPlan,
        onCancel: cancelCreate
      })}
    </div>
  )
}

function PlanListbox({
  value,
  plans,
  creating,
  onPick,
  onStartCreate
}: {
  value: string
  plans: readonly PlanWire[]
  creating: boolean
  onPick: (next: string) => void
  onStartCreate: () => void
}) {
  const { t } = useTranslation()
  return (
    <div role='listbox' aria-label={t('access.token.plan')}>
      <MenuItem
        selected={value === PLAN_NONE && !creating}
        onSelect={() => onPick(PLAN_NONE)}
        label={t('access.token.noPlanOption')}
      />
      {plans.map((plan) => (
        <MenuItem
          key={plan.id}
          selected={value === plan.id && !creating}
          onSelect={() => onPick(plan.id)}
          label={<span className='font-mono text-xs'>{plan.name}</span>}
          trailing={
            <span className='ml-auto text-[12px] text-muted-foreground'>
              {t(plan.models.length === 1 ? 'access.token.planModelCountOne' : 'access.token.planModelCount', {
                n: plan.models.length
              })}
            </span>
          }
        />
      ))}
      <div aria-hidden className='pointer-events-none -mx-1 my-1 h-px bg-border' />
      <MenuItem
        selected={creating}
        onSelect={onStartCreate}
        label={
          <>
            <i aria-hidden className='ri-add-line text-sm' />
            {t('access.token.createPlanAction')}
          </>
        }
      />
    </div>
  )
}

function MenuItem({
  selected,
  onSelect,
  label,
  trailing
}: {
  selected: boolean
  onSelect: () => void
  label: React.ReactNode
  trailing?: React.ReactNode
}) {
  return (
    <div
      role='option'
      aria-selected={selected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        'relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm select-none hover:bg-accent hover:text-accent-foreground',
        selected ? 'bg-accent text-accent-foreground' : ''
      )}
    >
      {label}
      {trailing}
      {selected ? (
        <span aria-hidden className='pointer-events-none absolute right-2 flex size-4 items-center justify-center'>
          <i className='ri-check-line' />
        </span>
      ) : null}
    </div>
  )
}

function ModelChip({ id, isDefault }: { id: string; isDefault: boolean }) {
  const { t } = useTranslation()
  return (
    <span
      className={cn(
        'inline-flex items-center rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]',
        isDefault ? 'text-foreground' : 'text-muted-foreground'
      )}
    >
      {id}
      {isDefault ? (
        <span className='ml-1.5 font-sans text-[11px] font-medium text-muted-foreground'>
          {t('access.plans.default')}
        </span>
      ) : null}
    </span>
  )
}

function fmtUsd(v: number): string {
  return `$${v.toFixed(2)}`
}

function LimitCell({ value, kind }: { value: number | null; kind: 'requests' | 'spend' }) {
  const { t } = useTranslation()
  if (value === null) {
    return <span className='text-muted-foreground/60'>{t('access.token.noLimit')}</span>
  }
  return <>{kind === 'requests' ? value.toLocaleString('en-US') : fmtUsd(value)}</>
}

/** Read-only summary of the chosen plan. */
export function PlanSummary({ plan, createdNote }: { plan: PlanWire; createdNote: string | null }) {
  const { t } = useTranslation()
  const tokens = plan.tokenCount
  const usedBy =
    tokens === 0
      ? t('access.token.planUnused')
      : tokens === 1
        ? t('access.token.planUsedByOne')
        : t('access.token.planUsedBy', { n: tokens })
  return (
    <div className='mt-3 space-y-3 border-l-2 border-border pl-3'>
      <div className='flex items-center gap-2'>
        <span className='text-xs font-medium'>{plan.name}</span>
        <span className={HINT}>{usedBy}</span>
        <Link
          to={`/access-tokens/plans?plan=${encodeURIComponent(plan.id)}`}
          className={cn('ml-auto inline-flex items-center gap-0.5 hover:text-foreground', HINT)}
        >
          {t('access.token.editPlanLink')}
          <i aria-hidden className='ri-arrow-right-up-line text-xs' />
        </Link>
      </div>
      <div>
        <div className={cn('mb-1', LABEL)}>{t('access.token.modelsHeading', { n: plan.models.length })}</div>
        <div className='flex flex-wrap gap-1.5'>
          {plan.models.map((model) => (
            <ModelChip key={model} id={model} isDefault={model === plan.defaultModel} />
          ))}
        </div>
      </div>
      <div>
        <div className={cn('mb-1', LABEL)}>{t('access.token.limitsHeading')}</div>
        <div className='grid grid-cols-[4.5rem_1fr_1fr] gap-x-3 gap-y-1 text-xs'>
          <span />
          <span className={cn('text-right', LABEL)}>{t('access.plans.limitRequests')}</span>
          <span className={cn('text-right', LABEL)}>{t('access.plans.limitSpend')}</span>
          <span className='text-muted-foreground'>{t('access.plans.window5h')}</span>
          <span className='text-right font-mono tabular-nums'>
            <LimitCell value={plan.fiveHourRequestLimit} kind='requests' />
          </span>
          <span className='text-right font-mono tabular-nums'>
            <LimitCell value={plan.fiveHourSpendLimitUsd} kind='spend' />
          </span>
          <span className='text-muted-foreground'>{t('access.plans.window7d')}</span>
          <span className='text-right font-mono tabular-nums'>
            <LimitCell value={plan.sevenDayRequestLimit} kind='requests' />
          </span>
          <span className='text-right font-mono tabular-nums'>
            <LimitCell value={plan.sevenDaySpendLimitUsd} kind='spend' />
          </span>
        </div>
      </div>
      <p className={HINT}>
        <i aria-hidden className='ri-shield-check-line mr-1 align-[-1px]' />
        <Trans i18nKey='access.token.planNote' components={{ mono: <span className='font-mono' /> }} />
      </p>
      {createdNote !== null ? (
        <p className={cn(HINT, 'text-foreground')}>
          <i aria-hidden className='ri-checkbox-circle-line mr-1 align-[-1px] text-emerald-600 dark:text-emerald-400' />
          <Trans
            i18nKey='access.token.planCreatedNote'
            values={{ name: createdNote }}
            components={{ strong: <span className='font-medium' /> }}
          />
        </p>
      ) : null}
    </div>
  )
}

/** The dashed-border note drawn in place of a plan summary when "No plan" is selected. */
export function NoPlanNote() {
  return (
    <div className={cn('mt-3 rounded-md border border-dashed border-border px-3 py-2', HINT)}>
      <Trans
        i18nKey='access.token.noPlanBody'
        components={{ strong: <span className='font-medium text-foreground' />, mono: <span className='font-mono' /> }}
      />
    </div>
  )
}

function InlineNewPlanForm({
  draft,
  available,
  statusId,
  saving,
  duplicate,
  canCreate,
  onChange,
  onCreate,
  onCancel
}: {
  draft: PlanDraft
  available: readonly string[]
  statusId: string
  saving: boolean
  duplicate: boolean
  canCreate: boolean
  onChange: (next: PlanDraft) => void
  onCreate: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className='mt-3 space-y-3 border-l-2 border-foreground/40 pl-3'>
      <div className='flex items-baseline gap-2'>
        <span className='text-xs font-medium'>{t('access.token.newPlanLabel')}</span>
        <span className={HINT}>{t('access.token.newPlanSharedNote')}</span>
      </div>

      <PlanEditorBody draft={draft} available={available} statusId={statusId} autoFocusName onChange={onChange} />

      <p className={cn('mt-1', HINT)}>{t('access.token.newPlanLimitsHint')}</p>

      <div className='flex items-center gap-2'>
        <span className={cn('min-w-0 flex-1 text-destructive', HINT)} aria-live='polite'>
          {duplicate ? t('access.token.newPlanDuplicate', { name: draft.name.trim() }) : ''}
        </span>
        <RButton variant='ghost' onClick={onCancel} disabled={saving}>
          {t('common.cancel')}
        </RButton>
        <RButton variant='outline' icon='ri-check-line' onClick={onCreate} disabled={!canCreate}>
          {t('access.plans.create')}
        </RButton>
      </div>
    </div>
  )
}
