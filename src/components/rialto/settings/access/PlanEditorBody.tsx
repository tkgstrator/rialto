import { cn } from 'cn'
import { type ReactNode, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { SelectPicker } from '@/components/rialto/SelectPicker'
import { MultiPicker } from '@/components/rialto/settings/access/pickers'
import {
  chooseDefault,
  isSpendField,
  LIMIT_FIELDS,
  type LimitField,
  modelOf,
  type PlanDraft,
  readLimit
} from '@/lib/rialto/settings/plans'

const INPUT =
  'h-8 w-full min-w-0 rounded-md border border-border bg-transparent px-3 text-xs outline-none focus:border-foreground/40'

function Label({ children }: { children: ReactNode }) {
  return <div className='mb-1 text-[12px] text-muted-foreground'>{children}</div>
}

export function ModelPicker({
  draft,
  available,
  disabledTargets,
  disabledHint,
  onChange
}: {
  draft: PlanDraft
  available: readonly string[]
  /** Targets that cannot be picked here — greyed out with `disabledHint` as tooltip. */
  disabledTargets?: ReadonlySet<string>
  disabledHint?: string
  onChange: (next: PlanDraft) => void
}) {
  const { t } = useTranslation()
  const isDisabled = (target: string): boolean => disabledTargets?.has(target) === true
  const options = available.map((target) => ({
    label: modelOf(target),
    value: target,
    disabled: isDisabled(target),
    disabledHint: isDisabled(target) ? disabledHint : undefined
  }))
  const defaultOptions = draft.models.map((target) => ({ label: modelOf(target), value: target }))
  const onModels = (next: string[]) => {
    const keepDefault = next.includes(draft.defaultModel) ? draft.defaultModel : ''
    onChange({ ...draft, models: next, defaultModel: keepDefault })
  }
  return (
    <div>
      <Label>{t('access.plans.models')}</Label>
      <MultiPicker
        options={options}
        selected={draft.models}
        onChange={onModels}
        placeholder={t('access.plans.modelsPlaceholder')}
        searchPlaceholder={t('access.plans.modelsSearchPlaceholder')}
        emptyPlaceholder={t('access.plans.noModels')}
      />
      <div className='mt-2'>
        <Label>{t('access.plans.defaultModel')}</Label>
        <SelectPicker
          label={t('access.plans.defaultModel')}
          value={draft.defaultModel}
          className='w-full'
          disabled={draft.models.length === 0}
          onChange={(v) => onChange(chooseDefault({ ...draft, defaultModel: v }, v))}
          options={[{ value: '', label: t('access.plans.defaultModelPlaceholder') }, ...defaultOptions]}
        />
      </div>
    </div>
  )
}

export function LimitFields({ draft, onChange }: { draft: PlanDraft; onChange: (next: PlanDraft) => void }) {
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
      {!allOk ? (
        <p className='mt-1 text-[12px] leading-snug text-destructive'>{t('access.plans.limitsInvalid')}</p>
      ) : null}
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

export function PlanEditorBody({
  draft,
  available,
  autoFocusName,
  disabledTargets,
  disabledHint,
  onChange
}: {
  draft: PlanDraft
  available: readonly string[]
  autoFocusName?: boolean
  disabledTargets?: ReadonlySet<string>
  disabledHint?: string
  onChange: (next: PlanDraft) => void
}) {
  const { t } = useTranslation()
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (autoFocusName === true) nameRef.current?.focus()
  }, [autoFocusName])
  return (
    <>
      <div>
        <Label>{t('access.plans.name')}</Label>
        <input
          ref={nameRef}
          type='text'
          aria-label={t('access.plans.nameAria')}
          value={draft.name}
          placeholder={t('access.plans.namePlaceholder')}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
          className={INPUT}
        />
      </div>

      <ModelPicker
        draft={draft}
        available={available}
        disabledTargets={disabledTargets}
        disabledHint={disabledHint}
        onChange={onChange}
      />

      <LimitFields draft={draft} onChange={onChange} />
    </>
  )
}
