/**
 * Presets, as one control in the band that acts on the chain.
 *
 * They used to be listed down the right rail *and* offered as a button in
 * the page header — the same action in two places, one of which was a
 * permanent list of three rows for something applied a handful of times
 * in a profile's life. A menu is the shape of "apply one of these", and
 * it puts the trigger next to Add target and Save, which is where the
 * other things that change the chain already are.
 *
 * The built-ins are stored as tier chains rather than as models (see
 * `shared/data/routing-presets.ts`), so they are resolved against the
 * models this install has enabled at the moment they are applied. That is
 * also why their row shows the chain: "fable → opus → sonnet" is the
 * whole content of the preset, and it says what a name cannot — which
 * link will be dropped on an install that has no fable-class model.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useConfig } from '@/components/ConfigProvider'
import { RButton } from '@/components/rialto/primitives'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api, type RoutingPresetItem } from '@/lib/api'
import { applyPresetToLive } from '@/lib/routing-map/apply-to-live'
import { resolveBuiltinPreset, resolvesToNothing } from '@/lib/routing-map/builtin-presets'
import { cn } from '@/lib/utils'
import type { RouterConfig } from '@/schemas/domain/router'
import { BUILTIN_ROUTING_PRESETS, type BuiltinRoutingPreset } from '@/shared/data'
import { useEnabledTargets } from './data'
import type { PreferenceProfile } from './types'

const PRESET_ROW =
  'flex w-full items-center gap-2 rounded-md border border-border px-3 py-2 text-xs transition-colors hover:bg-muted/50 disabled:opacity-50'

export function PresetsMenu({
  profileKey,
  constraints,
  onApplied,
  onNotify
}: {
  profileKey: string | null
  constraints: Record<string, unknown> | null
  onApplied: (profile: PreferenceProfile) => void
  onNotify: (message: string, ok: boolean) => void
}) {
  const { t } = useTranslation()
  const { config, setConfig } = useConfig()
  const targets = useEnabledTargets()
  const [saved, setSaved] = useState<RoutingPresetItem[]>([])
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    api
      .listRoutingPresets()
      .then((res) => setSaved(res.presets))
      .catch(() => {
        // The built-ins still render: they are code, not rows, so a
        // snapshot store that does not answer costs the operator the
        // saved list and nothing else.
      })
  }, [])

  const applyConfig = useCallback(
    async (router: RouterConfig, name: string) => {
      if (config === null) return
      setBusy(true)
      const result = await applyPresetToLive(config, router, name, { profileKey, constraints })
      setBusy(false)
      if (!result.ok) {
        onNotify(result.message, false)
        return
      }
      setConfig(result.updatedConfig)
      // Push the chain that was just written into the editor's draft, so
      // the table shows the preset instead of waiting for a refetch that
      // nothing triggers.
      if (result.profile !== null) onApplied(result.profile)
      setOpen(false)
      onNotify(
        result.warnings.length === 0
          ? t('routing.common.presetApplied', { name })
          : t('routing.common.presetAppliedWithWarnings', { name, count: result.warnings.length }),
        true
      )
    },
    [config, setConfig, onNotify, onApplied, profileKey, constraints, t]
  )

  const applyBuiltin = useCallback(
    (preset: BuiltinRoutingPreset) => {
      const resolved = resolveBuiltinPreset(preset, targets)
      // Applying a chain of nulls is not "the preset did not fit", it is
      // an outage — say so instead of saving it.
      if (resolvesToNothing(resolved)) {
        onNotify(t('routing.common.presetUnresolved', { name: preset.name }), false)
        return
      }
      void applyConfig(resolved, preset.name)
    },
    [targets, applyConfig, onNotify, t]
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <RButton variant='ghost' icon='ri-stack-line'>
          {t('routing.common.presets')}
        </RButton>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-72 p-2'>
        {BUILTIN_ROUTING_PRESETS.map((preset, index) => (
          <button
            key={preset.id}
            type='button'
            disabled={busy}
            onClick={() => applyBuiltin(preset)}
            className={cn(PRESET_ROW, index === 0 ? '' : 'mt-2')}
          >
            <i className='ri-stack-line text-sm text-muted-foreground' />
            <span className='min-w-0 text-left'>
              <span className='block truncate'>{preset.name}</span>
              <span className='block truncate font-mono text-[11px] text-muted-foreground'>
                {preset.chains.agent.join(' → ')}
              </span>
            </span>
            <span className='ml-auto shrink-0 text-[12px] text-muted-foreground'>{t('routing.common.apply')}</span>
          </button>
        ))}
        {saved.map((preset) => (
          <button
            key={preset.id}
            type='button'
            disabled={busy}
            onClick={() => void applyConfig(preset.config, preset.name)}
            className={cn(PRESET_ROW, 'mt-2')}
          >
            <i className='ri-bookmark-line text-sm text-muted-foreground' />
            <span className='truncate'>{preset.name}</span>
            <span className='ml-auto shrink-0 text-[12px] text-muted-foreground'>{t('routing.common.apply')}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}
