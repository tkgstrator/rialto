import { cn } from 'cn'
import { type ReactNode, useEffect, useRef } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { MultiPicker, Picker } from '@/components/rialto/settings/access/pickers'
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

function Hint({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <p id={id} className='mt-1 text-[12px] leading-snug text-muted-foreground'>
      {children}
    </p>
  )
}

export function ModelPicker({
  draft,
  available,
  statusId,
  disabledTargets,
  disabledHint,
  onChange
}: {
  draft: PlanDraft
  available: readonly string[]
  statusId: string
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
        <Picker
          label={t('access.plans.defaultModel')}
          value={draft.defaultModel}
          disabled={draft.models.length === 0}
          onChange={(v) => onChange(chooseDefault({ ...draft, defaultModel: v }, v))}
        >
          <option value=''>{t('access.plans.defaultModelPlaceholder')}</option>
          {defaultOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Picker>
      </div>
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
      <Hint>{t('access.plans.defaultHint')}</Hint>
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

export function PlanEditorBody({
  draft,
  available,
  statusId,
  autoFocusName,
  disabledTargets,
  disabledHint,
  onChange
}: {
  draft: PlanDraft
  available: readonly string[]
  statusId: string
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
        statusId={statusId}
        disabledTargets={disabledTargets}
        disabledHint={disabledHint}
        onChange={onChange}
      />

      <LimitFields draft={draft} onChange={onChange} />
    </>
  )
}
