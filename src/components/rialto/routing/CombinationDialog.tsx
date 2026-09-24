/**
 * The dialog that adds a provider · tier to one cell, or changes one line
 * of it.
 *
 * Two selects, one under the other: the provider, then the tier. The tier
 * select stays disabled until a provider is chosen, because which tiers
 * it offers depends on that provider. An earlier draft put both selects
 * side by side on every line of the table, which crowded every row with
 * controls for a decision made once; another walked through the two in
 * separate steps, which hid the provider once it was picked.
 *
 * A tier the provider has no model for, or one the cell already holds,
 * stays in the list, disabled and saying why, rather than vanishing: a
 * missing option reads as "that provider has no such tier", which is not
 * always the reason.
 */
import { cn } from 'cn'
import { type ReactNode, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RButton } from '@/components/rialto/primitives'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { TierAliasWire } from '@/lib/api'
import { type TierAvailability, tierOptions } from './derive'
import { LANE_LABEL_KEYS, SCENARIO_LABEL_KEYS } from './labels'
import type { CellAddress, Combination, ModelTier } from './types'

/** Which cell the dialog edits, and which of its lines when changing one. */
export interface CombinationTarget {
  at: CellAddress
  /** Null to add a line; the line's index to change it. */
  index: number | null
}

const REASON_KEYS: Record<Exclude<TierAvailability, 'available'>, string> = {
  unset: 'routing.scenarios.tierNotSet',
  taken: 'routing.scenarios.tierTaken'
}

/**
 * A labelled native select in the house box — bordered, with a trailing
 * chevron, as `SelectField` in Settings draws it. `value` '' shows the
 * placeholder option, greyed like an input's placeholder.
 */
function Field({
  label,
  value,
  placeholder,
  disabled = false,
  onChange,
  children
}: {
  label: string
  value: string
  placeholder: string
  disabled?: boolean
  onChange: (next: string) => void
  children: ReactNode
}) {
  const id = useId()
  return (
    <div className='grid gap-1.5'>
      <label htmlFor={id} className={cn('text-xs', disabled ? 'text-muted-foreground' : '')}>
        {label}
      </label>
      <div className='relative'>
        <select
          id={id}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            'flex h-8 w-full appearance-none items-center rounded-md border border-border bg-transparent pl-3 pr-8 font-mono text-xs transition-colors',
            'hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
            value === '' ? 'text-muted-foreground' : ''
          )}
        >
          {/* Disabled so the placeholder cannot be chosen back once a real
              option is; still what an empty value shows. */}
          <option value='' disabled>
            {placeholder}
          </option>
          {children}
        </select>
        <i
          aria-hidden
          className='ri-arrow-down-s-line pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground'
        />
      </div>
    </div>
  )
}

interface PickerProps {
  target: CombinationTarget
  /** The line being changed; null when adding. */
  current: Combination | null
  /** The cell's lines, for refusing a duplicate. */
  routes: readonly Combination[]
  providers: readonly string[]
  aliases: readonly TierAliasWire[] | null
  onConfirm: (provider: string, tier: ModelTier) => void
  onCancel: () => void
}

/**
 * The dialog's content. Its state starts from the props on mount, and the
 * content mounts afresh every time the dialog opens, so each opening
 * starts at the line it was opened on — both selects filled for a change,
 * both empty for an add.
 */
function Picker({ target, current, routes, providers, aliases, onConfirm, onCancel }: PickerProps) {
  const { t } = useTranslation()
  const [provider, setProvider] = useState<string | null>(current === null ? null : current.provider)
  const [tier, setTier] = useState<ModelTier | null>(current === null ? null : current.targetTier)

  const options = useMemo(
    () => (provider === null ? [] : tierOptions(provider, aliases, routes, target.index)),
    [provider, aliases, routes, target.index]
  )
  const chosen = options.find((option) => option.tier === tier && option.availability === 'available')

  const pickProvider = (name: string) => {
    // Another provider's tiers are another set, so the tier starts over —
    // except on the line's own provider, where its tier is what to return to.
    if (name !== provider) setTier(current !== null && current.provider === name ? current.targetTier : null)
    setProvider(name)
  }
  const pickTier = (value: string) => {
    const option = options.find((o) => o.tier === value)
    if (option !== undefined) setTier(option.tier)
  }

  const vars = { scenario: t(SCENARIO_LABEL_KEYS[target.at.scenario]), lane: t(LANE_LABEL_KEYS[target.at.lane]) }
  const adding = target.index === null
  const noProviders = providers.length === 0

  return (
    <>
      <DialogHeader>
        {/* leading-none restated after text-sm: `cn` drops the title's own
            leading-none once a font size is passed, and the 20px line box
            text-sm brings would push the fields below it off the mock. */}
        <DialogTitle className='text-sm leading-none'>
          {adding ? t('routing.scenarios.addTitle', vars) : t('routing.scenarios.changeTitle', vars)}
        </DialogTitle>
      </DialogHeader>
      <div className='grid gap-4'>
        <Field
          label={t('routing.scenarios.providerLabel')}
          value={provider === null ? '' : provider}
          placeholder={noProviders ? t('routing.scenarios.noProviders') : t('routing.scenarios.chooseProvider')}
          disabled={noProviders}
          onChange={pickProvider}
        >
          {providers.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </Field>
        <Field
          label={t('routing.scenarios.tierLabel')}
          value={tier === null ? '' : tier}
          placeholder={provider === null ? t('routing.scenarios.tierWaiting') : t('routing.scenarios.chooseTier')}
          disabled={provider === null}
          onChange={pickTier}
        >
          {options.map((option) => (
            <option key={option.tier} value={option.tier} disabled={option.availability !== 'available'}>
              {option.availability === 'available'
                ? option.tier
                : `${option.tier} — ${t(REASON_KEYS[option.availability])}`}
            </option>
          ))}
        </Field>
      </div>
      <DialogFooter>
        <RButton variant='ghost' onClick={onCancel}>
          {t('common.cancel')}
        </RButton>
        <RButton
          variant='primary'
          icon={adding ? 'ri-add-line' : 'ri-check-line'}
          disabled={provider === null || chosen === undefined}
          onClick={() => {
            if (provider !== null && chosen !== undefined) onConfirm(provider, chosen.tier)
          }}
        >
          {adding ? t('routing.scenarios.addConfirm') : t('common.save')}
        </RButton>
      </DialogFooter>
    </>
  )
}

export function CombinationDialog({
  target,
  open,
  routes,
  providers,
  aliases,
  onConfirm,
  onClose
}: {
  /** Kept after closing so the content can fade out; null before the first opening. */
  target: CombinationTarget | null
  open: boolean
  routes: readonly Combination[]
  providers: readonly string[]
  aliases: readonly TierAliasWire[] | null
  onConfirm: (provider: string, tier: ModelTier) => void
  onClose: () => void
}) {
  const current = target === null || target.index === null ? undefined : routes.at(target.index)
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      {target === null ? null : (
        // No description: the title names the cell, and the field labels
        // say what to pick. `undefined` tells Radix the omission is deliberate.
        <DialogContent className='sm:max-w-md' aria-describedby={undefined}>
          <Picker
            key={`${target.at.scenario}:${target.at.lane}:${target.index === null ? 'add' : target.index}`}
            target={target}
            current={current === undefined ? null : current}
            routes={routes}
            providers={providers}
            aliases={aliases}
            onConfirm={onConfirm}
            onCancel={onClose}
          />
        </DialogContent>
      )}
    </Dialog>
  )
}
