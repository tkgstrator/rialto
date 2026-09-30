import { useTranslation } from 'react-i18next'
import type { ModelTier } from '@/lib/api'
import { REQUESTED_MODEL_TIERS } from '@/schemas/domain/router'

export function EscalationRestrictions({
  selected,
  onChange,
  editing,
  decisionEnabled,
  onDecisionEnabled,
  decisionApiBaseUrl,
  onDecisionApiBaseUrl,
  decisionApiKeyEnv,
  onDecisionApiKeyEnv,
  decisionModel,
  onDecisionModel,
  decisionMinConfidence,
  onDecisionMinConfidence,
  decisionTimeoutMs,
  onDecisionTimeoutMs
}: {
  selected: readonly ModelTier[]
  onChange: (tiers: ModelTier[]) => void
  editing: boolean
  /** Omitted by legacy readers that only render escalation restrictions. */
  decisionEnabled?: boolean
  onDecisionEnabled?: (enabled: boolean) => void
  decisionApiBaseUrl?: string
  onDecisionApiBaseUrl?: (value: string) => void
  decisionApiKeyEnv?: string
  onDecisionApiKeyEnv?: (value: string) => void
  decisionModel?: string
  onDecisionModel?: (value: string) => void
  decisionMinConfidence?: number
  onDecisionMinConfidence?: (value: number) => void
  decisionTimeoutMs?: number
  onDecisionTimeoutMs?: (value: number) => void
}) {
  const { t } = useTranslation()
  return (
    <fieldset className='border-t border-border px-6 py-4'>
      <legend className='sr-only'>{t('routing.scenarios.blockedEscalationTiers')}</legend>
      <div className='text-xs font-medium'>{t('routing.scenarios.blockedEscalationTiers')}</div>
      <p className='mt-1 text-xs text-muted-foreground'>{t('routing.scenarios.blockedEscalationHint')}</p>
      <div className='mt-3 flex flex-wrap gap-x-5 gap-y-2'>
        {REQUESTED_MODEL_TIERS.map((tier) => (
          <label key={tier} className='flex items-center gap-2 text-xs'>
            <input
              type='checkbox'
              checked={selected.includes(tier)}
              disabled={!editing}
              onChange={(event) =>
                onChange(event.target.checked ? [...selected, tier] : selected.filter((value) => value !== tier))
              }
              className='size-3.5 accent-primary'
            />
            <span className='capitalize'>{tier}</span>
          </label>
        ))}
      </div>
      {decisionEnabled === undefined ? null : (
        <label className='mt-4 flex items-start gap-2 text-xs'>
          <input
            type='checkbox'
            checked={decisionEnabled}
            disabled={!editing}
            onChange={(event) => onDecisionEnabled?.(event.target.checked)}
            className='mt-0.5 size-3.5 accent-primary'
          />
          <span>
            <span className='font-medium'>{t('routing.scenarios.decisionEnabled')}</span>
            <span className='mt-1 block text-muted-foreground'>{t('routing.scenarios.decisionHint')}</span>
          </span>
        </label>
      )}
      {decisionEnabled === true ? (
        <div className='mt-4 grid max-w-2xl gap-3 sm:grid-cols-2'>
          <label className='grid gap-1 text-xs'>
            <span>{t('routing.scenarios.decisionBaseUrl')}</span>
            <input
              value={decisionApiBaseUrl ?? ''}
              disabled={!editing}
              onChange={(event) => onDecisionApiBaseUrl?.(event.target.value)}
              placeholder='https://api.typesafe.ai'
              className='h-8 rounded-md border border-border bg-background px-2 font-mono text-xs'
            />
          </label>
          <label className='grid gap-1 text-xs'>
            <span>{t('routing.scenarios.decisionModel')}</span>
            <input
              value={decisionModel ?? ''}
              disabled={!editing}
              onChange={(event) => onDecisionModel?.(event.target.value)}
              placeholder='jev-latest'
              className='h-8 rounded-md border border-border bg-background px-2 font-mono text-xs'
            />
          </label>
          <label className='grid gap-1 text-xs'>
            <span>{t('routing.scenarios.decisionApiKeyEnv')}</span>
            <input
              value={decisionApiKeyEnv ?? ''}
              disabled={!editing}
              onChange={(event) => onDecisionApiKeyEnv?.(event.target.value)}
              placeholder='JEV_API_KEY'
              className='h-8 rounded-md border border-border bg-background px-2 font-mono text-xs'
            />
          </label>
          <label className='grid gap-1 text-xs'>
            <span>{t('routing.scenarios.decisionMinConfidence')}</span>
            <input
              type='number'
              min='0'
              max='1'
              step='0.01'
              value={decisionMinConfidence ?? 0.9}
              disabled={!editing}
              onChange={(event) => onDecisionMinConfidence?.(Number(event.target.value))}
              className='h-8 rounded-md border border-border bg-background px-2 font-mono text-xs'
            />
          </label>
          <label className='grid gap-1 text-xs'>
            <span>{t('routing.scenarios.decisionTimeout')}</span>
            <input
              type='number'
              min='1'
              max='10000'
              step='100'
              value={decisionTimeoutMs ?? 1_500}
              disabled={!editing}
              onChange={(event) => onDecisionTimeoutMs?.(Number(event.target.value))}
              className='h-8 rounded-md border border-border bg-background px-2 font-mono text-xs'
            />
          </label>
        </div>
      ) : null}
    </fieldset>
  )
}
