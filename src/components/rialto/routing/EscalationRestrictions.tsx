import { useTranslation } from 'react-i18next'
import type { ModelTier } from '@/lib/api'
import { REQUESTED_MODEL_TIERS } from '@/schemas/domain/router'

export function EscalationRestrictions({
  selected,
  onChange,
  editing
}: {
  selected: readonly ModelTier[]
  onChange: (tiers: ModelTier[]) => void
  editing: boolean
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
    </fieldset>
  )
}
