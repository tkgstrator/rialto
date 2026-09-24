/**
 * The dialog that adds a provider · tier to one cell, or changes one line
 * of it.
 *
 * A combination is a decision in two steps — which provider, then which
 * of its tiers — so it is picked here rather than in place. An earlier
 * draft of the design put a provider select and a tier select side by
 * side on every line: two controls for one decision, the second's options
 * depending on the first.
 *
 * A provider reads as its name; a tier reads as the same badge it wears in
 * the table, so the two steps pick visibly different kinds of thing. A
 * tier the provider has no model for, or one the cell already holds, stays
 * in the list, disabled and saying why, rather than vanishing: a missing
 * row reads as "that provider has no such tier", which is not always the
 * reason.
 */
import { cn } from 'cn'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pill, RButton } from '@/components/rialto/primitives'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { TierAliasWire } from '@/lib/api'
import { type TierAvailability, type TierOption, tierOptions } from './derive'
import { LANE_LABEL_KEYS, SCENARIO_LABEL_KEYS } from './labels'
import type { CellAddress, Combination, ModelTier } from './types'

/** Which cell the dialog edits, and which of its lines when changing one. */
export interface CombinationTarget {
  at: CellAddress
  /** Null to add a line; the line's index to change it. */
  index: number | null
}

// The chosen line is ringed rather than filled: a muted fill would
// swallow the muted tier badge inside it.
function optionTone(disabled: boolean, on: boolean): string {
  if (disabled) return 'cursor-not-allowed text-muted-foreground/50'
  return on ? 'ring-1 ring-foreground/20' : 'hover:bg-muted/60'
}

function Option({
  on = false,
  disabled = false,
  arrow = false,
  detail,
  onClick,
  children
}: {
  on?: boolean
  disabled?: boolean
  /** A step that leads on to another, rather than choosing. */
  arrow?: boolean
  detail?: ReactNode
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type='button'
      disabled={disabled}
      aria-pressed={arrow ? undefined : on}
      onClick={onClick}
      className={cn('flex h-10 w-full items-center gap-3 rounded-md px-3 text-left', optionTone(disabled, on))}
    >
      <span className='w-4'>{on ? <i aria-hidden className='ri-check-line text-sm' /> : null}</span>
      {children}
      <span className={cn('ml-auto text-[12px]', disabled ? '' : 'font-mono text-muted-foreground')}>{detail}</span>
      {arrow ? <i aria-hidden className='ri-arrow-right-s-line text-sm text-muted-foreground' /> : null}
    </button>
  )
}

const REASON_KEYS: Record<Exclude<TierAvailability, 'available'>, string> = {
  unset: 'routing.scenarios.tierNotSet',
  taken: 'routing.scenarios.tierTaken'
}

function ProviderStep({
  providers,
  chosen,
  onPick
}: {
  providers: readonly string[]
  chosen: string | null
  onPick: (provider: string) => void
}) {
  const { t } = useTranslation()
  return (
    <div className='grid gap-1'>
      <div className='text-[12px] text-muted-foreground'>{t('routing.scenarios.chooseProvider')}</div>
      {providers.length === 0 ? (
        <div className='px-3 py-2 text-[12px] text-muted-foreground'>{t('routing.scenarios.noProviders')}</div>
      ) : (
        providers.map((provider) => (
          <Option key={provider} arrow on={provider === chosen} onClick={() => onPick(provider)}>
            <span className='font-mono text-xs'>{provider}</span>
          </Option>
        ))
      )}
    </div>
  )
}

function TierStep({
  provider,
  options,
  chosen,
  onBack,
  onPick
}: {
  provider: string
  options: readonly TierOption[]
  chosen: ModelTier | null
  onBack: () => void
  onPick: (tier: ModelTier) => void
}) {
  const { t } = useTranslation()
  return (
    <div className='grid gap-1'>
      <div className='flex items-center gap-2 text-[12px] text-muted-foreground'>
        <button
          type='button'
          title={t('common.back')}
          onClick={onBack}
          className='inline-flex items-center gap-1 hover:text-foreground'
        >
          <i aria-hidden className='ri-arrow-left-s-line text-sm' />
          {provider}
        </button>
        <span>·</span>
        <span>{t('routing.scenarios.chooseTier')}</span>
      </div>
      {options.map((option) => {
        const disabled = option.availability !== 'available'
        return (
          <Option
            key={option.tier}
            on={!disabled && option.tier === chosen}
            disabled={disabled}
            detail={option.availability === 'available' ? null : t(REASON_KEYS[option.availability])}
            onClick={() => onPick(option.tier)}
          >
            <span className={disabled ? 'opacity-50' : ''}>
              <Pill tone='mute'>{option.tier}</Pill>
            </span>
          </Option>
        )
      })}
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
 * starts at the line it was opened on — step 2 for a change, step 1 for
 * an add.
 */
function Picker({ target, current, routes, providers, aliases, onConfirm, onCancel }: PickerProps) {
  const { t } = useTranslation()
  const [step, setStep] = useState<'provider' | 'tier'>(current === null ? 'provider' : 'tier')
  const [provider, setProvider] = useState<string | null>(current === null ? null : current.provider)
  const [tier, setTier] = useState<ModelTier | null>(current === null ? null : current.targetTier)

  const options = useMemo(
    () => (provider === null ? [] : tierOptions(provider, aliases, routes, target.index)),
    [provider, aliases, routes, target.index]
  )
  const chosen = options.find((option) => option.tier === tier && option.availability === 'available')

  const pickProvider = (name: string) => {
    // Another provider's tiers are another set, so the pick starts over —
    // except on the line's own provider, where its tier is what to return to.
    if (name !== provider) setTier(current !== null && current.provider === name ? current.targetTier : null)
    setProvider(name)
    setStep('tier')
  }

  const vars = { scenario: t(SCENARIO_LABEL_KEYS[target.at.scenario]), lane: t(LANE_LABEL_KEYS[target.at.lane]) }
  const adding = target.index === null

  return (
    <>
      <DialogHeader>
        {/* leading-none restated after text-sm: `cn` drops the title's own
            leading-none once a font size is passed, and the 20px line box
            text-sm brings would push the steps below it off the mock. */}
        <DialogTitle className='text-sm leading-none'>
          {adding ? t('routing.scenarios.addTitle', vars) : t('routing.scenarios.changeTitle', vars)}
        </DialogTitle>
      </DialogHeader>
      {step === 'tier' && provider !== null ? (
        <TierStep
          provider={provider}
          options={options}
          chosen={tier}
          onBack={() => setStep('provider')}
          onPick={setTier}
        />
      ) : (
        <ProviderStep providers={providers} chosen={provider} onPick={pickProvider} />
      )}
      <DialogFooter>
        <RButton variant='ghost' onClick={onCancel}>
          {t('common.cancel')}
        </RButton>
        {/* Nothing to confirm until a provider is picked: step 1 moves on
            by itself, so a confirm button there would only be disabled. */}
        {step === 'tier' ? (
          <RButton
            variant='primary'
            icon={adding ? 'ri-add-line' : 'ri-check-line'}
            disabled={chosen === undefined}
            onClick={() => {
              if (provider !== null && chosen !== undefined) onConfirm(provider, chosen.tier)
            }}
          >
            {adding ? t('routing.scenarios.addConfirm') : t('common.save')}
          </RButton>
        ) : null}
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
        // No description: the title names the cell, and the steps say
        // what to pick. `undefined` tells Radix the omission is deliberate.
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
