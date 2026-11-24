import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RButton } from '@/components/rialto/primitives'
import { SelectPicker } from '@/components/rialto/SelectPicker'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import type { PlanWire } from '@/lib/api'
import { modelOf, providerOf } from '@/lib/rialto/settings/plans'
import type { ModelProviderRule } from '@/schemas/domain/access-token'
import {
  allowsTokenModel,
  type ProviderAuthMode,
  TOKEN_PROVIDER_MODES,
  type TokenPolicy,
  type TokenProviderMode
} from '@/shared/access-token-policy'

// Subscription before API key wherever the two are listed together.
const METHOD_ORDER: readonly ProviderAuthMode[] = ['subscription', 'api_key']

/**
 * Which billing methods can serve each model for this token: the enabled
 * targets, narrowed to the plan's models and the token's own model limit,
 * grouped by bare model name. A rule is keyed by that name, so this is the
 * set it chooses between.
 */
export function servingMethods(
  available: readonly string[],
  providers: readonly { name: string; auth_mode: ProviderAuthMode }[],
  plan: PlanWire | undefined,
  policy: TokenPolicy
): Map<string, ProviderAuthMode[]> {
  const found = new Map<string, Set<ProviderAuthMode>>()
  for (const target of available) {
    if (plan !== undefined && !plan.models.includes(target)) continue
    const provider = providers.find((entry) => entry.name === providerOf(target))
    if (provider === undefined) continue
    const model = modelOf(target)
    if (!allowsTokenModel(policy, model, { provider: provider.name, authMode: provider.auth_mode })) continue
    const methods = found.get(model)
    if (methods === undefined) found.set(model, new Set([provider.auth_mode]))
    else methods.add(provider.auth_mode)
  }
  return new Map(
    [...found]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([model, methods]) => [model, METHOD_ORDER.filter((method) => methods.has(method))])
  )
}

/** The billing method a mode insists on, when it insists on one. */
function onlyMethod(mode: TokenProviderMode): ProviderAuthMode | undefined {
  if (mode === 'subscription_only') return 'subscription'
  if (mode === 'api_key_only') return 'api_key'
  return undefined
}

/**
 * Models that pick their own billing method instead of following the token's
 * Provider setting. Token-only: the folder dialog draws ProviderModeFields
 * without this, because folders carry no rules.
 */
export function ModelProviderRules({
  policy,
  onChange,
  available,
  providers,
  plan,
  disabled
}: {
  policy: TokenPolicy
  onChange: (rules: ModelProviderRule[]) => void
  available: readonly string[]
  providers: readonly { name: string; auth_mode: ProviderAuthMode }[]
  plan: PlanWire | undefined
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const labelId = useId()
  const served = servingMethods(available, providers, plan, policy)
  const rules = policy.modelProviderRules
  const methodLabel = (method: ProviderAuthMode) =>
    t(method === 'subscription' ? 'settings.access.billingSubscription' : 'settings.access.billingApiKey')
  const methodsOf = (model: string) => {
    const methods = served.get(model)
    return methods === undefined ? [] : methods
  }
  const unruled = [...served.keys()].filter((model) => !rules.some((rule) => rule.model === model))
  const choices = unruled.filter((model) => methodsOf(model).length > 1)
  const single = unruled.filter((model) => methodsOf(model).length === 1)

  const update = (model: string, mode: TokenProviderMode) =>
    onChange(rules.map((rule) => (rule.model === model ? { ...rule, mode } : rule)))
  // A new rule starts on the other preference from the token's: a rule that
  // repeats the setting above would change nothing.
  const add = (model: string) => {
    const mode = policy.providerMode.startsWith('subscription') ? 'api_key_first' : 'subscription_first'
    onChange([...rules, { model, mode }])
    setOpen(false)
  }

  // Said under a rule only when it does not do what it reads as.
  const noteOf = (rule: ModelProviderRule) => {
    const methods = methodsOf(rule.model)
    if (methods.length === 0)
      return (
        <p className='text-[12px] leading-snug text-muted-foreground'>
          {t('settings.access.modelProviderRuleUnreachable')}
        </p>
      )
    const only = onlyMethod(rule.mode)
    if (only !== undefined && !methods.includes(only))
      return (
        <p className='text-[12px] leading-snug text-destructive'>
          {t('settings.access.modelProviderRuleRefused', { method: methodLabel(only) })}
        </p>
      )
    return null
  }

  return (
    <div className='grid gap-1'>
      {/* A field of its own, headed like Provider above it. No count: the rules are listed right under it. */}
      <div id={labelId} className='text-xs leading-none font-medium'>
        {t('settings.access.modelProviderRules')}
      </div>
      {rules.length > 0 ? (
        // Flat rows with a left rule, the house pattern (primitives.tsx), not a boxed card.
        <ul aria-labelledby={labelId} className='mb-1 grid gap-3'>
          {rules.map((rule) => (
            <li key={rule.model} className='grid gap-2 border-l-2 border-border pl-3'>
              <div className='flex min-w-0 items-center gap-2'>
                <span className='min-w-0 truncate font-mono text-xs'>{rule.model}</span>
                <Button
                  type='button'
                  variant='ghost'
                  size='icon-xs'
                  className='ml-auto shrink-0 text-muted-foreground'
                  disabled={disabled}
                  aria-label={t('settings.access.modelProviderRuleRemove', { model: rule.model })}
                  onClick={() => onChange(rules.filter((entry) => entry.model !== rule.model))}
                >
                  <i aria-hidden className='ri-close-line text-sm leading-none' />
                </Button>
              </div>
              <SelectPicker
                className='w-56 max-w-full'
                label={t('settings.access.modelProviderRuleMode', { model: rule.model })}
                value={rule.mode}
                disabled={disabled}
                onChange={(next) => {
                  const mode = TOKEN_PROVIDER_MODES.find((item) => item === next)
                  if (mode !== undefined) update(rule.model, mode)
                }}
                options={TOKEN_PROVIDER_MODES.map((mode) => ({
                  value: mode,
                  label: t(`settings.access.providerModes.${mode}`)
                }))}
              />
              {noteOf(rule)}
            </li>
          ))}
        </ul>
      ) : null}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <div className='w-fit'>
            <RButton
              variant='outline'
              icon='ri-add-line'
              aria-haspopup='listbox'
              aria-expanded={open}
              disabled={disabled || choices.length === 0}
              onClick={() => setOpen(true)}
            >
              {t('settings.access.modelProviderRuleAdd')}
            </RButton>
          </div>
        </PopoverAnchor>
        <PopoverContent align='start' sideOffset={4} className='w-80 max-w-[calc(100vw-2rem)] p-0'>
          <div
            role='listbox'
            aria-label={t('settings.access.modelProviderRuleAdd')}
            className='max-h-72 overflow-y-auto p-1'
          >
            {/* Every model here is served both ways, which is why it can be picked, so its methods go unsaid. */}
            {choices.map((model) => (
              <div
                key={model}
                role='option'
                aria-selected={false}
                tabIndex={0}
                onClick={() => add(model)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    add(model)
                  }
                }}
                className='flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm select-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-none'
              >
                <span className='whitespace-nowrap font-mono text-xs'>{model}</span>
              </div>
            ))}
            {single.length > 0 ? (
              // A model only one method serves is listed but cannot be picked:
              // a rule for it could only refuse it, and refusing a model is the
              // plan's job.
              <>
                {choices.length > 0 ? (
                  <div aria-hidden className='pointer-events-none -mx-1 my-1 h-px bg-border' />
                ) : null}
                <div className='px-2 pt-1 pb-0.5 text-[12px] font-medium text-muted-foreground'>
                  {t('settings.access.modelProviderRuleSingle')}
                </div>
                {single.map((model) => (
                  <div
                    key={model}
                    role='option'
                    aria-selected={false}
                    aria-disabled
                    tabIndex={-1}
                    className='flex w-full items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm opacity-50 select-none'
                  >
                    <span className='whitespace-nowrap font-mono text-xs'>{model}</span>
                    <span className='ml-auto whitespace-nowrap text-[12px] text-muted-foreground'>
                      {t('settings.access.modelProviderRuleOnly', { method: methodLabel(methodsOf(model)[0]) })}
                    </span>
                  </div>
                ))}
              </>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
      <p className='text-[12px] leading-snug text-muted-foreground'>{t('settings.access.modelProviderRulesHint')}</p>
    </div>
  )
}
