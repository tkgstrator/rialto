/**
 * The preset library column: what is installed, and what can be.
 *
 * Absorbs `PresetListItem` and the market dialog's list. Browsing used to
 * be a modal over a modal; it is a tab here, so installing and inspecting
 * happen against the same detail pane.
 */
import { useTranslation } from 'react-i18next'
import { RButton, Tabs } from '@/components/rialto/primitives'
import type { MarketPreset, PresetMetadata } from '@/lib/presets/types'
import { cn } from '@/lib/utils'

export type PresetTab = 'installed' | 'market'

function PresetRow({
  name,
  badge,
  subtitle,
  selected,
  onSelect
}: {
  name: string
  badge: string
  subtitle: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type='button'
      onClick={onSelect}
      className={cn(
        'block w-full border-l-2 px-4 py-3 text-left transition-colors',
        selected ? 'border-l-foreground bg-muted/60' : 'border-l-transparent hover:border-l-border hover:bg-muted/50'
      )}
    >
      <div className='flex items-center gap-2'>
        <span className='text-xs font-medium'>{name}</span>
        <span className='ml-auto font-mono text-[11px] text-muted-foreground'>{badge}</span>
      </div>
      <div className='mt-0.5 truncate text-[12px] text-muted-foreground'>{subtitle}</div>
    </button>
  )
}

/**
 * Install source. The server only knows how to fetch a preset from a
 * GitHub repository, so the field asks for `owner/repo` rather than
 * pretending a local file picker exists.
 */
function InstallBox({
  open,
  repo,
  busy,
  onOpen,
  onRepoChange,
  onInstall
}: {
  open: boolean
  repo: string
  busy: boolean
  onOpen: () => void
  onRepoChange: (next: string) => void
  onInstall: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className='space-y-2 p-4'>
      <RButton variant='outline' icon='ri-upload-line' onClick={onOpen}>
        {t('settings.presets.installFromGithub')}
      </RButton>
      {open ? (
        <div className='flex items-center gap-2'>
          <input
            value={repo}
            onChange={(e) => onRepoChange(e.target.value)}
            placeholder={t('settings.presets.repoPlaceholder')}
            aria-label={t('settings.presets.repoLabel')}
            className='h-8 min-w-0 flex-1 rounded-md border border-border bg-transparent px-2.5 font-mono text-[12px] outline-none focus:border-foreground/40'
          />
          <RButton variant='primary' onClick={onInstall} disabled={repo === '' || busy}>
            {t(busy ? 'settings.presets.installing' : 'settings.presets.install')}
          </RButton>
        </div>
      ) : null}
      <RButton variant='ghost' icon='ri-download-line' disabled title={t('settings.presets.exportUnavailable')}>
        {t('settings.presets.exportCurrent')}
      </RButton>
    </div>
  )
}

export function PresetList({
  tab,
  installed,
  market,
  selectedId,
  installRepo,
  installOpen,
  installing,
  onSelect,
  onOpenInstall,
  onInstallRepoChange,
  onInstall
}: {
  tab: PresetTab
  installed: PresetMetadata[]
  market: MarketPreset[]
  selectedId: string | null
  installRepo: string
  installOpen: boolean
  installing: boolean
  onSelect: (id: string) => void
  onOpenInstall: () => void
  onInstallRepoChange: (next: string) => void
  onInstall: () => void
}) {
  const { t } = useTranslation()
  return (
    <aside className='min-w-0 overflow-y-auto border-r border-border'>
      <div className='flex items-center gap-1 border-b border-border px-3'>
        <Tabs
          items={[
            {
              id: 'installed',
              label: t('settings.presets.tabInstalled'),
              count: installed.length,
              href: '/settings/presets'
            },
            { id: 'market', label: t('settings.presets.tabBrowse'), href: '/settings/presets?tab=market' }
          ]}
          active={tab}
        />
      </div>

      {tab === 'installed'
        ? installed.map((preset) => (
            <PresetRow
              key={preset.id}
              name={preset.name}
              badge={`v${preset.version}`}
              subtitle={[preset.author, preset.description]
                .filter((s) => typeof s === 'string' && s !== '')
                .join(' · ')}
              selected={preset.id === selectedId}
              onSelect={() => onSelect(preset.id)}
            />
          ))
        : market.map((preset) => (
            <PresetRow
              key={preset.id}
              name={preset.name}
              badge={preset.repo}
              subtitle={[preset.author, preset.description]
                .filter((s) => typeof s === 'string' && s !== '')
                .join(' · ')}
              selected={preset.id === selectedId}
              onSelect={() => onSelect(preset.id)}
            />
          ))}

      <InstallBox
        open={installOpen}
        repo={installRepo}
        busy={installing}
        onOpen={onOpenInstall}
        onRepoChange={onInstallRepoChange}
        onInstall={onInstall}
      />

      <div className='border-t border-border px-4 py-4'>
        <p className='text-[12px] leading-relaxed text-muted-foreground'>{t('settings.presets.libraryNote')}</p>
      </div>
    </aside>
  )
}
