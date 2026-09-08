/**
 * Step 3 of the add-provider flow: pick what the new provider may serve.
 *
 * Reuses the detail screen's model table rather than inventing a second
 * treatment — it is the same decision, made once before the provider takes
 * traffic instead of after.
 */
import { useTranslation } from 'react-i18next'
import { Pill } from '@/components/rialto/primitives'
import { buildModelRows, enabledCountOf, listedModelsOf } from './derive'
import { ModelsTable } from './ModelsTable'
import type { CatalogEntry, Provider, ReasoningEffort, Tier } from './types'
import { vendorLabel } from './vendor-labels'

export function ConnectModelsStep({
  entry,
  provider,
  onToggle,
  onTier,
  onEffort
}: {
  entry: CatalogEntry
  provider: Provider | undefined
  onToggle: (model: string, next: boolean) => void
  onTier: (model: string, next: Tier | null) => void
  onEffort: (model: string, next: ReasoningEffort | null) => void
}) {
  const { t } = useTranslation()
  if (provider === undefined) {
    return (
      <div className='min-w-0 overflow-y-auto'>
        <div className='px-6 py-6 text-xs text-muted-foreground'>
          {t('providers.connect.notAddedYet', { vendor: vendorLabel(entry.name, entry.displayName) })}
        </div>
      </div>
    )
  }
  const isApiKey = provider.auth_mode !== 'subscription'
  return (
    <div className='min-w-0 overflow-y-auto'>
      <div className='border-b border-border px-6 py-4'>
        <div className='flex items-center gap-2'>
          <h2 className='text-sm font-semibold'>{vendorLabel(entry.name, entry.displayName)}</h2>
          {isApiKey ? (
            <Pill tone='mute'>{t('providers.connect.pillApiKey')}</Pill>
          ) : (
            <Pill tone='info'>{t('providers.connect.pillSubscription')}</Pill>
          )}
        </div>
        <p className='mt-1 text-[12px] leading-relaxed text-muted-foreground'>
          {t('providers.connect.modelsExplainer')}
        </p>
      </div>
      <div className='flex items-center gap-3 px-6 pt-5 pb-3'>
        <h3 className='text-sm font-semibold'>{t('providers.models.title')}</h3>
        <span className='text-[12px] text-muted-foreground'>
          {t('providers.models.enabledCount', {
            enabled: enabledCountOf(provider),
            total: listedModelsOf(provider).length
          })}
        </span>
      </div>
      <ModelsTable
        rows={buildModelRows(provider, entry)}
        withOverride={isApiKey}
        onToggle={onToggle}
        onTier={onTier}
        onEffort={onEffort}
      />
      <div className='h-6' />
    </div>
  )
}
