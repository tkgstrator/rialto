/**
 * Settings → Advanced. The raw config document and the health probe.
 *
 * Absorbs `JsonEditor` (the config document). A third tab, "Request
 * scratchpad", used to sit between them: it rendered a "not built yet"
 * panel whose copy sent the operator to `/debug` — a route that no
 * longer exists and whose own 404 says it "moved into Settings". A tab
 * that costs a click to reach a dead end is worse than no tab, so it is
 * gone until there is something to put in it.
 *
 * Tab state rides on the query string so each tab is linkable and the
 * shared `Tabs` primitive can stay a plain list of links. The pane opens
 * straight into the strip — hence `showHeading={false}`.
 */
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { Tabs } from '@/components/rialto/primitives'
import { ConfigDocument } from '@/components/rialto/settings/advanced/ConfigDocument'
import { DangerZone } from '@/components/rialto/settings/advanced/DangerZone'
import { HealthPanel } from '@/components/rialto/settings/advanced/HealthPanel'
import { SectionHead } from '@/components/rialto/settings/fields'
import { SettingsLayout } from '@/components/rialto/settings/SettingsLayout'

const TAB_KEYS = [
  { id: 'config', labelKey: 'settings.advanced.tabConfig', href: '?tab=config' },
  { id: 'health', labelKey: 'settings.advanced.tabHealth', href: '?tab=health' }
]

export function SettingsAdvanced() {
  const { t } = useTranslation()
  const [params] = useSearchParams()
  const requested = params.get('tab')
  // An old ?tab=scratch link now lands on the config document rather
  // than an empty pane — the tab it named is gone.
  const tab = requested === 'health' ? 'health' : 'config'

  return (
    <SettingsLayout active='advanced' subtitle={t('settings.advanced.subtitle')} showHeading={false}>
      <div className='flex items-center gap-1 border-b border-border px-6'>
        <Tabs
          items={TAB_KEYS.map((item) => ({ id: item.id, label: t(item.labelKey), href: item.href }))}
          active={tab}
        />
      </div>

      {tab === 'health' ? <HealthPanel /> : <ConfigDocument />}

      <DangerZone />
      <div className='h-10' />
    </SettingsLayout>
  )
}
