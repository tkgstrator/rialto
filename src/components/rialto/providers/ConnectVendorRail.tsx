/**
 * Vendor picker for the add-provider flow — step 1, kept visible through
 * the whole flow so switching vendor is one click rather than a restart.
 */
import { useTranslation } from 'react-i18next'
import { Pill } from '@/components/rialto/primitives'
import { cn } from '@/lib/utils'
import type { CatalogEntry } from './types'
import { sortVendors, vendorHint, vendorLabel } from './vendor-labels'

// Marks the mock assigns to the vendors it names. Anything else falls
// back to the generic key glyph rather than guessing at a brand.
const VENDOR_ICON: Record<string, string> = {
  'claude-code': 'ri-sparkling-line',
  codex: 'ri-terminal-line',
  groq: 'ri-flashlight-line',
  openrouter: 'ri-shuffle-line',
  custom: 'ri-add-box-line'
}

const iconFor = (entry: CatalogEntry): string => {
  const named = VENDOR_ICON[entry.name]
  if (named !== undefined) return named
  return entry.authMode === 'subscription' ? 'ri-user-shared-line' : 'ri-key-2-line'
}

function VendorCard({ entry, selected, onSelect }: { entry: CatalogEntry; selected: boolean; onSelect: () => void }) {
  const { t } = useTranslation()
  const hint = vendorHint(entry)
  return (
    <button
      type='button'
      onClick={onSelect}
      className={cn(
        'flex w-full items-start gap-3 border-l-2 px-4 py-3 text-left transition-colors',
        selected ? 'border-l-foreground bg-muted/60' : 'border-l-transparent hover:border-l-border hover:bg-muted/50'
      )}
    >
      <i className={cn(iconFor(entry), 'mt-0.5 text-base leading-none text-muted-foreground')} />
      <div className='min-w-0 flex-1'>
        <div className='flex items-center gap-2'>
          <span className='text-xs font-medium'>{vendorLabel(entry.name, entry.displayName)}</span>
          {entry.authMode === 'subscription' ? (
            <Pill tone='info'>{t('providers.rail.oauth')}</Pill>
          ) : (
            <Pill tone='mute'>{t('providers.rail.apiKey')}</Pill>
          )}
          {entry.enabled ? (
            <span className='ml-auto text-[12px] text-muted-foreground'>{t('providers.connect.added')}</span>
          ) : null}
        </div>
        <div className='mt-0.5 text-[12px] text-muted-foreground'>{t(hint.key, hint.values)}</div>
      </div>
    </button>
  )
}

export function ConnectVendorRail({
  entries,
  selectedName,
  onSelect
}: {
  entries: CatalogEntry[]
  selectedName: string | null
  onSelect: (entry: CatalogEntry) => void
}) {
  const { t } = useTranslation()
  return (
    <aside className='min-w-0 overflow-y-auto border-r border-border'>
      <div className='px-4 pt-5 pb-2'>
        <h2 className='text-[12px] font-semibold uppercase tracking-wider text-muted-foreground'>
          {t('providers.connect.vendor')}
        </h2>
      </div>
      {sortVendors(entries).map((entry) => (
        <VendorCard
          key={entry.name}
          entry={entry}
          selected={entry.name === selectedName}
          onSelect={() => onSelect(entry)}
        />
      ))}
    </aside>
  )
}
