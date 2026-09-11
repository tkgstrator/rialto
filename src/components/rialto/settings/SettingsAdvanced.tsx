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
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { RButton, Tabs } from '@/components/rialto/primitives'
import { ConfigDocument, maskSecrets, stripMasked } from '@/components/rialto/settings/advanced/ConfigDocument'
import { DangerZone } from '@/components/rialto/settings/advanced/DangerZone'
import { HealthPanel } from '@/components/rialto/settings/advanced/HealthPanel'
import { SettingsLayout } from '@/components/rialto/settings/SettingsLayout'
import { api, type HealthResponse } from '@/lib/api'
import { formatJson, isValidJson } from '@/lib/rialto/settings/envelope'

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

  // Lifted out of HealthPanel so the breadcrumb subtitle can report the
  // same status the tab is about to show, the way the mock's per-tab
  // subtitle does — "GET /health · degraded" rather than a static label
  // that never changes with the probe.
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [healthReachable, setHealthReachable] = useState(true)
  const loadHealth = useCallback(() => {
    api
      .getHealth()
      .then((res) => {
        setHealth(res)
        setHealthReachable(true)
      })
      .catch(() => setHealthReachable(false))
  }, [])
  // Re-probes on every visit to the tab, matching the old per-mount fetch
  // HealthPanel did on its own before this state moved up.
  useEffect(() => {
    if (tab === 'health') loadHealth()
  }, [tab, loadHealth])

  const healthStatus = !healthReachable
    ? t('settings.advanced.unreachable')
    : health === null
      ? t('settings.advanced.probing')
      : t(health.status === 'ok' ? 'settings.advanced.statusOk' : 'settings.advanced.degraded')
  const subtitle =
    tab === 'health'
      ? t('settings.advanced.subtitleHealth', { status: healthStatus })
      : t('settings.advanced.subtitleConfig')

  // Also lifted out of its panel: the mock's app-level header carries its
  // own "Save" beside the config toolbar's — the two act on the same
  // document — while the Health tab has nothing to save and the header
  // shows no action at all there.
  const [configText, setConfigText] = useState('')
  const [configSaving, setConfigSaving] = useState(false)
  // The unmasked document, kept so a save can put back the credentials
  // the operator never saw.
  const [configLoaded, setConfigLoaded] = useState<unknown>(null)

  const loadConfigDocument = useCallback(() => {
    api
      .get<unknown>('/config')
      .then((raw) => {
        setConfigLoaded(raw)
        setConfigText(JSON.stringify(maskSecrets(raw), null, 2))
      })
      .catch((e: Error) => toast.error(t('settings.advanced.readFailed', { message: e.message })))
  }, [t])

  useEffect(loadConfigDocument, [loadConfigDocument])

  const configValid = isValidJson(configText)

  const formatConfigDocument = () => {
    const pretty = formatJson(configText)
    if (pretty === null) {
      toast.error(t('settings.advanced.cannotFormat'))
      return
    }
    setConfigText(pretty)
  }

  const saveConfigDocument = () => {
    if (!configValid) {
      toast.error(t('settings.advanced.cannotSave'))
      return
    }
    setConfigSaving(true)
    api
      .post<{ success: boolean; message: string }>('/config', stripMasked(JSON.parse(configText), configLoaded))
      .then((res) => {
        toast.success(res.message)
        loadConfigDocument()
      })
      .catch((e: Error) => toast.error(t('settings.common.saveFailed', { message: e.message })))
      .finally(() => setConfigSaving(false))
  }

  return (
    <SettingsLayout
      active='advanced'
      subtitle={subtitle}
      showHeading={false}
      actions={
        tab === 'health' ? undefined : (
          <RButton
            variant='primary'
            icon='ri-check-line'
            onClick={saveConfigDocument}
            disabled={!configValid || configSaving}
          >
            {t('common.save')}
          </RButton>
        )
      }
    >
      <div className='flex items-center gap-1 border-b border-border px-6'>
        <Tabs
          items={TAB_KEYS.map((item) => ({ id: item.id, label: t(item.labelKey), href: item.href }))}
          active={tab}
        />
      </div>

      {tab === 'health' ? (
        <HealthPanel health={health} reachable={healthReachable} onReload={loadHealth} />
      ) : (
        <ConfigDocument
          text={configText}
          onTextChange={setConfigText}
          valid={configValid}
          saving={configSaving}
          onLoad={loadConfigDocument}
          onFormat={formatConfigDocument}
          onSave={saveConfigDocument}
        />
      )}

      <DangerZone />
      <div className='h-10' />
    </SettingsLayout>
  )
}
