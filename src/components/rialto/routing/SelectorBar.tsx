/**
 * The outermost axis of the Routing screens: which of the two selectors
 * decides a request at all.
 *
 * It sits above the surface tabs because it is a wider fact than any of
 * them — `ROUTER_MODE` is one envelope scalar for the whole install,
 * while the surface, the profile and the chain below it are all narrower.
 * Until it was on screen, the Rules editor and the Chain editor looked
 * equally live while only ever one of them ran, and nothing in the UI
 * said which.
 *
 * Writing through on click matches the surface mode switch a row down: a
 * single choice rather than an edit in progress, so there is no Save. The
 * write is a partial `POST /api/config`, which `applyUiConfig` merges
 * onto the disk envelope and re-mirrors onto `process.env` — the routing
 * decision changes on the next request, no restart.
 */
import { useCallback, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useConfig } from '@/components/ConfigProvider'
import { api } from '@/lib/api'
import { activeSelector, MODE_FOR_SELECTOR, type RouterSelector } from './derive'
import { Segmented } from './SurfaceModeBar'

const LABEL_KEY = { rules: 'routing.common.tabRules', chain: 'routing.common.tabChain' } as const

const EXPLAINER_KEY = {
  rules: 'routing.common.selectorRulesHint',
  chain: 'routing.common.selectorChainHint'
} as const

export function SelectorBar() {
  const { t } = useTranslation()
  const { config, reloadConfig } = useConfig()
  const [saving, setSaving] = useState(false)
  const selector = activeSelector(config?.ROUTER_MODE)

  const onSelect = useCallback(
    (next: RouterSelector) => {
      if (next === selector || saving) return
      setSaving(true)
      api
        .post<{ success: boolean; message: string }>('/config', { ROUTER_MODE: MODE_FOR_SELECTOR[next] })
        .then(() => reloadConfig())
        .then(() => toast.success(t('routing.common.selectorSwitched', { selector: t(LABEL_KEY[next]) })))
        .catch((e: Error) => toast.error(e.message))
        .finally(() => setSaving(false))
    },
    [selector, saving, reloadConfig, t]
  )

  return (
    <div className='flex items-center gap-4 border-b border-border px-6 py-3'>
      <div className='flex items-center gap-2'>
        <span className='text-xs text-muted-foreground'>{t('routing.common.selector')}</span>
        <Segmented
          value={selector}
          options={[
            { value: 'rules', label: t(LABEL_KEY.rules) },
            { value: 'chain', label: t(LABEL_KEY.chain) }
          ]}
          onChange={onSelect}
        />
      </div>
      <p className='ml-auto max-w-lg text-right text-[12px] leading-snug text-muted-foreground'>
        <Trans i18nKey={EXPLAINER_KEY[selector]} components={{ mono: <span className='font-mono' /> }} />
      </p>
    </div>
  )
}
