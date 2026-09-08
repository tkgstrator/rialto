/**
 * The preset's own input schema, rendered inline.
 *
 * Absorbs `DynamicConfigForm`. It used to be a form inside the detail
 * dialog inside the install dialog; here the fields sit in the detail
 * pane, so the operator can read what the preset will change while
 * filling in what it needs.
 *
 * Secrets are never echoed back: a password field that already has a
 * stored value renders empty with a "stored" note rather than replaying
 * the value into the DOM.
 */
import { useTranslation } from 'react-i18next'
import { Pill } from '@/components/rialto/primitives'
import { getOptions, shouldShowField } from '@/lib/presets/form-logic'
import type { PresetConfigSection, RequiredInput } from '@/lib/presets/types'

const FIELD_CLASS =
  'flex h-8 max-w-md flex-1 items-center rounded-md border border-border bg-transparent px-3 font-mono text-xs outline-none focus:border-foreground/40 placeholder:text-muted-foreground/50'

const asText = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return ''
}

function FieldControl({
  field,
  presetConfig,
  value,
  values,
  onChange
}: {
  field: RequiredInput
  presetConfig: PresetConfigSection
  value: unknown
  values: Record<string, unknown>
  onChange: (value: unknown) => void
}) {
  const { t } = useTranslation()
  const id = `preset-field-${field.id}`
  if (field.type === 'confirm') {
    return (
      <input
        id={id}
        type='checkbox'
        checked={value === true}
        onChange={(e) => onChange(e.target.checked)}
        className='size-4 accent-foreground'
      />
    )
  }
  if (field.type === 'select') {
    return (
      <select id={id} value={asText(value)} onChange={(e) => onChange(e.target.value)} className={FIELD_CLASS}>
        <option value=''>{field.placeholder === undefined ? t('settings.presets.required') : field.placeholder}</option>
        {getOptions(field, presetConfig, values).map((option) => (
          <option key={String(option.value)} value={String(option.value)} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    )
  }
  const inputType = field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'
  return (
    <input
      id={id}
      type={inputType}
      value={asText(value)}
      placeholder={field.placeholder === undefined ? t('settings.presets.required') : field.placeholder}
      onChange={(e) => onChange(field.type === 'number' ? Number(e.target.value) : e.target.value)}
      className={FIELD_CLASS}
    />
  )
}

function FieldRow({
  field,
  presetConfig,
  values,
  stored,
  onChange
}: {
  field: RequiredInput
  presetConfig: PresetConfigSection
  values: Record<string, unknown>
  stored: boolean
  onChange: (value: unknown) => void
}) {
  const { t } = useTranslation()
  const secret = field.type === 'password'
  const hint = field.prompt === undefined ? '' : field.prompt
  return (
    <div className='grid grid-cols-[12rem_1fr] items-start gap-4 border-t border-border/60 px-6 py-3'>
      <div>
        <label htmlFor={`preset-field-${field.id}`} className='flex items-center gap-1.5 text-xs font-medium'>
          {field.label === undefined ? field.id : field.label}
          {field.required === false ? null : <span className='text-destructive'>*</span>}
        </label>
        <div className='mt-0.5 text-[12px] leading-snug text-muted-foreground'>
          {secret && hint === '' ? t('settings.presets.secretHint') : hint}
        </div>
      </div>
      <div className='flex items-center gap-2'>
        <FieldControl
          field={field}
          presetConfig={presetConfig}
          value={values[field.id]}
          values={values}
          onChange={onChange}
        />
        {secret ? <i className='ri-lock-line text-sm text-muted-foreground' /> : null}
        {stored ? <span className='text-[12px] text-muted-foreground'>{t('settings.presets.stored')}</span> : null}
      </div>
    </div>
  )
}

export function RequiredInputs({
  schema,
  presetConfig,
  values,
  storedIds,
  missingCount,
  onChange
}: {
  schema: RequiredInput[]
  presetConfig: PresetConfigSection
  values: Record<string, unknown>
  storedIds: string[]
  missingCount: number
  onChange: (id: string, value: unknown) => void
}) {
  const { t } = useTranslation()
  if (schema.length === 0) return null
  return (
    <>
      <div className='flex items-center gap-2 border-t border-border px-6 pt-5 pb-2'>
        <h3 className='text-sm font-semibold'>{t('settings.presets.requiredInputs')}</h3>
        {missingCount === 0 ? (
          <Pill tone='ok'>{t('settings.presets.complete')}</Pill>
        ) : (
          <Pill tone='warn'>{t('settings.presets.missingCount', { n: missingCount })}</Pill>
        )}
      </div>
      {schema
        .filter((field) => shouldShowField(field, values))
        .map((field) => (
          <FieldRow
            key={field.id}
            field={field}
            presetConfig={presetConfig}
            values={values}
            stored={storedIds.includes(field.id)}
            onChange={(value) => onChange(field.id, value)}
          />
        ))}
    </>
  )
}
