/**
 * The `when` half of a rule.
 *
 * A predicate is a fixed set of optional fields that AND together, so the
 * editor is a list of set fields plus a picker for the unset ones — the
 * same shape the runtime evaluates, rather than a free-form expression
 * builder that would have to be validated back down to it.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { EFFORT_LEVELS, REQUESTED_MODEL_TIERS, type RouteRule } from '@/schemas/domain/router'

type Predicate = RouteRule['when']
type Field = 'requestedTier' | 'requestedModel' | 'thinking' | 'minTokens' | 'maxTokens' | 'hasTool' | 'effort'

const FIELDS: readonly Field[] = [
  'requestedTier',
  'requestedModel',
  'thinking',
  'minTokens',
  'maxTokens',
  'hasTool',
  'effort'
]

const OPS: Record<Field, string> = {
  requestedTier: 'in',
  requestedModel: 'matches',
  thinking: 'is',
  minTokens: '>=',
  maxTokens: '<=',
  hasTool: 'matches',
  effort: 'in'
}

// Zod types the multi-selects as non-empty tuples, so a toggle that
// empties the list has to clear the field rather than write `[]`.
const toNonEmpty = <T,>(values: readonly T[]): [T, ...T[]] | undefined => {
  const [head, ...rest] = values
  return head === undefined ? undefined : [head, ...rest]
}

const DEFAULTS: Record<Field, Partial<Predicate>> = {
  requestedTier: { requestedTier: ['opus'] },
  requestedModel: { requestedModel: '*' },
  thinking: { thinking: true },
  minTokens: { minTokens: 60000 },
  maxTokens: { maxTokens: 60000 },
  hasTool: { hasTool: 'web_search*' },
  effort: { effort: ['high'] }
}

const isSet = (when: Predicate, field: Field): boolean => when[field] !== undefined

const clear = (when: Predicate, field: Field): Predicate => ({ ...when, [field]: undefined })

const BOX = 'flex h-8 flex-1 items-center gap-1.5 rounded-md border border-border px-3 font-mono text-xs'
const CHIP = 'rounded px-1.5 py-0.5 text-[12px] transition-colors'

function MultiChips<T extends string>({
  options,
  selected,
  onToggle
}: {
  options: readonly T[]
  selected: readonly T[]
  onToggle: (value: T) => void
}) {
  return (
    <div className={BOX}>
      {options.map((option) => (
        <button
          key={option}
          type='button'
          onClick={() => onToggle(option)}
          className={cn(
            CHIP,
            selected.includes(option) ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted/60'
          )}
        >
          {option}
        </button>
      ))}
    </div>
  )
}

function ValueEditor({
  field,
  when,
  onChange
}: {
  field: Field
  when: Predicate
  onChange: (next: Predicate) => void
}) {
  if (field === 'requestedTier') {
    const selected = when.requestedTier === undefined ? [] : when.requestedTier
    return (
      <MultiChips
        options={REQUESTED_MODEL_TIERS}
        selected={selected}
        onToggle={(value) => {
          const next = selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]
          onChange({ ...when, requestedTier: toNonEmpty(REQUESTED_MODEL_TIERS.filter((t) => next.includes(t))) })
        }}
      />
    )
  }
  if (field === 'effort') {
    const selected = when.effort === undefined ? [] : when.effort
    return (
      <MultiChips
        options={EFFORT_LEVELS}
        selected={selected}
        onToggle={(value) => {
          const next = selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]
          onChange({ ...when, effort: toNonEmpty(EFFORT_LEVELS.filter((e) => next.includes(e))) })
        }}
      />
    )
  }
  if (field === 'thinking') {
    return (
      <MultiChips
        options={['true', 'false'] as const}
        selected={when.thinking === true ? ['true'] : ['false']}
        onToggle={(value) => onChange({ ...when, thinking: value === 'true' })}
      />
    )
  }
  if (field === 'minTokens' || field === 'maxTokens') {
    const raw = when[field]
    return (
      <input
        type='number'
        min={0}
        step={1000}
        className={cn(BOX, 'bg-transparent tabular-nums outline-none')}
        value={raw === undefined ? '' : raw}
        onChange={(event) => {
          const parsed = event.target.valueAsNumber
          onChange({ ...when, [field]: Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined })
        }}
      />
    )
  }
  const text = when[field]
  return (
    <input
      className={cn(BOX, 'bg-transparent outline-none')}
      value={typeof text === 'string' ? text : ''}
      onChange={(event) => onChange({ ...when, [field]: event.target.value })}
    />
  )
}

function FieldPicker({
  field,
  disabled,
  onPick
}: {
  field: Field
  disabled: readonly Field[]
  onPick: (next: Field) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className='inline-flex h-8 min-w-44 items-center gap-2 rounded-md border border-border px-3 text-xs transition-colors hover:bg-muted/60'
        >
          <span className='font-mono'>{field}</span>
          <i className='ri-arrow-down-s-line ml-auto text-sm text-muted-foreground' />
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-52 p-1'>
        {FIELDS.map((option) => (
          <button
            key={option}
            type='button'
            disabled={option !== field && disabled.includes(option)}
            onClick={() => {
              onPick(option)
              setOpen(false)
            }}
            className='block w-full rounded px-2 py-1.5 text-left font-mono text-xs transition-colors hover:bg-muted/60 disabled:opacity-40'
          >
            {option}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

function AddCondition({ available, onAdd }: { available: readonly Field[]; onAdd: (field: Field) => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  if (available.length === 0) return null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className='flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-muted/50'
        >
          <i className='ri-add-line' /> {t('routing.rules.predicate.addCondition')}{' '}
          <span className='opacity-60'>{t('routing.rules.predicate.allMustMatch')}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-52 p-1'>
        {available.map((field) => (
          <button
            key={field}
            type='button'
            onClick={() => {
              onAdd(field)
              setOpen(false)
            }}
            className='block w-full rounded px-2 py-1.5 text-left font-mono text-xs transition-colors hover:bg-muted/60'
          >
            {field}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

export function PredicateEditor({ when, onChange }: { when: Predicate; onChange: (next: Predicate) => void }) {
  const { t } = useTranslation()
  const active = FIELDS.filter((field) => isSet(when, field))
  const available = FIELDS.filter((field) => !isSet(when, field))

  return (
    <div className='space-y-2 px-6'>
      {active.length === 0 ? (
        <p className='text-[12px] text-muted-foreground'>{t('routing.rules.predicate.noConditions')}</p>
      ) : null}
      {active.map((field) => (
        <div key={field} className='flex items-center gap-2'>
          <FieldPicker
            field={field}
            disabled={active}
            onPick={(next) => onChange({ ...clear(when, field), ...DEFAULTS[next] })}
          />
          <div className='inline-flex h-8 min-w-28 items-center rounded-md border border-border px-3 text-xs'>
            <span className='font-mono'>{OPS[field]}</span>
          </div>
          <ValueEditor field={field} when={when} onChange={onChange} />
          <button
            type='button'
            aria-label={t('routing.rules.predicate.removeField', { field })}
            className='text-muted-foreground/60 hover:text-destructive'
            onClick={() => onChange(clear(when, field))}
          >
            <i className='ri-close-line text-sm' />
          </button>
        </div>
      ))}
      <AddCondition available={available} onAdd={(field) => onChange({ ...when, ...DEFAULTS[field] })} />
    </div>
  )
}
