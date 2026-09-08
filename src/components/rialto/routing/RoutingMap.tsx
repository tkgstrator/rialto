/**
 * Routing → Map.
 *
 * One canvas for what used to be three screens (library, live editor,
 * preset editor). It is a live view of the routing that is in force, not a
 * separate draft: the one thing it edits — a surface's routing mode —
 * writes through immediately, because a mode you have to remember to save
 * is a mode you will get wrong.
 */
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { useConfig } from '@/components/ConfigProvider'
import { Pill, RButton } from '@/components/rialto/primitives'
import { Screen } from '@/components/rialto/Screen'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api, type RoutingPresetItem, type SurfaceId } from '@/lib/api'
import { applyPresetToLive } from '@/lib/routing-map/apply-to-live'
import { resolveBuiltinPreset, resolvesToNothing } from '@/lib/routing-map/builtin-presets'
import type { RouterConfig } from '@/schemas/domain/router'
import { BUILTIN_ROUTING_PRESETS, type BuiltinRoutingPreset } from '@/shared/data'
import { useEnabledTargets, usePreferences, useProfiles, useScheduler, useSurfaces } from './data'
import { profileEntryCount, profileTargets, STATE_LABEL_KEYS, weightIndex } from './derive'
import { MapCanvas } from './MapCanvas'
import { allRules } from './rules'
import { SelectorBar } from './SelectorBar'
import type { ProfileSummary } from './types'
import { SCENARIOS } from './types'

const ZOOM_STEP = 1.2

function ZoomControls({ onZoom, onFit }: { onZoom: (factor: number) => void; onFit: () => void }) {
  const { t } = useTranslation()
  const cls = 'px-2 py-1.5 text-muted-foreground hover:bg-muted/60'
  return (
    <div className='absolute left-4 top-4 z-10 flex flex-col overflow-hidden rounded-md border border-border bg-background'>
      <button type='button' aria-label={t('routing.map.zoomIn')} className={cls} onClick={() => onZoom(ZOOM_STEP)}>
        <i className='ri-add-line text-sm' />
      </button>
      <button
        type='button'
        aria-label={t('routing.map.zoomOut')}
        className={`border-t border-border ${cls}`}
        onClick={() => onZoom(1 / ZOOM_STEP)}
      >
        <i className='ri-subtract-line text-sm' />
      </button>
      <button
        type='button'
        aria-label={t('routing.map.fit')}
        className={`border-t border-border ${cls}`}
        onClick={onFit}
      >
        <i className='ri-focus-3-line text-sm' />
      </button>
    </div>
  )
}

function Legend() {
  const { t } = useTranslation()
  const item = 'flex items-center gap-1.5 text-[12px] text-muted-foreground'
  return (
    <div className='absolute bottom-4 right-4 z-10 flex items-center gap-3 rounded-md border border-border bg-background px-3 py-1.5'>
      <span className={item}>
        <span className='size-1.5 rounded-full bg-emerald-500' />
        {t(STATE_LABEL_KEYS.ready)}
      </span>
      <span className={item}>
        <span className='size-1.5 rounded-full bg-amber-500' />
        {t(STATE_LABEL_KEYS.throttled)}
      </span>
      <span className={item}>
        <span className='size-1.5 rounded-full bg-destructive' />
        {t(STATE_LABEL_KEYS.exhausted)}
      </span>
      <span className='ml-1 border-l border-border pl-3 text-[12px] text-muted-foreground'>
        {`┄ ${t('routing.common.modePassthrough')}`}
      </span>
    </div>
  )
}

function ProfileButton({
  current,
  profiles,
  onSelect
}: {
  current: string
  profiles: readonly ProfileSummary[]
  onSelect: (key: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className='inline-flex h-7 items-center gap-2 rounded-md border border-border px-2.5 text-xs hover:bg-muted/60'
        >
          <i className='ri-bookmark-line text-sm text-muted-foreground' />
          {current}
          <i className='ri-arrow-down-s-line text-sm text-muted-foreground' />
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-52 p-1'>
        {profiles.map((profile) => (
          <button
            key={profile.key}
            type='button'
            onClick={() => {
              onSelect(profile.key)
              setOpen(false)
            }}
            className='flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60'
          >
            <span className='truncate'>{profile.key}</span>
            {/* A reserved mode has no chain to count, and a bare 0 beside
                it would read as an empty one. */}
            <span className='ml-auto shrink-0 text-[11px] text-muted-foreground'>
              {profile.kind === 'passthrough' ? (
                t('routing.map.skipsRouting')
              ) : (
                <span className='font-mono tabular-nums'>{profile.entryCount}</span>
              )}
            </span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

function PresetsMenu({ onNotify }: { onNotify: (text: string, ok: boolean) => void }) {
  const { t } = useTranslation()
  const { config, setConfig } = useConfig()
  // What the built-ins' tier chains resolve against.
  const enabled = useEnabledTargets()
  const [open, setOpen] = useState(false)
  const [presets, setPresets] = useState<RoutingPresetItem[]>([])

  const load = useCallback(
    (next: boolean) => {
      setOpen(next)
      if (!next) return
      api
        .listRoutingPresets()
        .then((res) => setPresets(res.presets))
        .catch((err: unknown) => onNotify(err instanceof Error ? err.message : String(err), false))
    },
    [onNotify]
  )

  const applyConfig = useCallback(
    async (router: RouterConfig, name: string) => {
      if (config === null) return
      const result = await applyPresetToLive(config, router, name)
      if (result.ok) {
        setConfig(result.updatedConfig)
        onNotify(t('routing.common.presetApplied', { name }), true)
      } else {
        onNotify(result.message, false)
      }
      setOpen(false)
    },
    [config, setConfig, onNotify, t]
  )

  const applyBuiltin = useCallback(
    (preset: BuiltinRoutingPreset) => {
      const resolved = resolveBuiltinPreset(preset, enabled)
      if (resolvesToNothing(resolved)) {
        onNotify(t('routing.common.presetUnresolved', { name: preset.name }), false)
        return
      }
      void applyConfig(resolved, preset.name)
    },
    [enabled, applyConfig, onNotify, t]
  )

  const remove = useCallback(
    async (preset: RoutingPresetItem) => {
      // A rejected delete leaves the row exactly where it was, which reads
      // as a click that never registered rather than as a refusal — and
      // the operator's next move is to click it again.
      try {
        await api.deleteRoutingPreset(preset.id)
      } catch (err: unknown) {
        onNotify(err instanceof Error ? err.message : String(err), false)
        return
      }
      setPresets((rows) => rows.filter((r) => r.id !== preset.id))
      onNotify(t('routing.map.presetDeleted', { name: preset.name }), true)
    },
    [onNotify, t]
  )

  return (
    <Popover open={open} onOpenChange={load}>
      <PopoverTrigger asChild>
        <RButton variant='outline' icon='ri-archive-drawer-line'>
          {t('routing.common.presets')}
        </RButton>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-64 p-1'>
        {/* The built-ins have no delete affordance because there is
            nothing to delete — they are code, not rows. */}
        {BUILTIN_ROUTING_PRESETS.map((preset) => (
          <div key={preset.id} className='flex items-center gap-1 rounded px-2 py-1.5 text-xs hover:bg-muted/60'>
            <span className='min-w-0'>
              <span className='block truncate'>{preset.name}</span>
              <span className='block truncate font-mono text-[11px] text-muted-foreground'>
                {preset.chains.agent.join(' → ')}
              </span>
            </span>
            <button
              type='button'
              className='ml-auto shrink-0 text-[12px] text-muted-foreground hover:text-foreground'
              onClick={() => applyBuiltin(preset)}
            >
              {t('routing.common.apply')}
            </button>
          </div>
        ))}
        {presets.map((preset) => (
          <div key={preset.id} className='flex items-center gap-1 rounded px-2 py-1.5 text-xs hover:bg-muted/60'>
            <span className='truncate'>{preset.name}</span>
            <button
              type='button'
              className='ml-auto shrink-0 text-[12px] text-muted-foreground hover:text-foreground'
              onClick={() => void applyConfig(preset.config, preset.name)}
            >
              {t('routing.common.apply')}
            </button>
            <button
              type='button'
              aria-label={t('routing.map.deletePreset', { name: preset.name })}
              className='shrink-0 text-muted-foreground/60 hover:text-destructive'
              onClick={() => void remove(preset)}
            >
              <i className='ri-delete-bin-line text-sm' />
            </button>
          </div>
        ))}
      </PopoverContent>
    </Popover>
  )
}

export function RoutingMap() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { config } = useConfig()
  const { surfaces, reload: reloadSurfaces, setMode } = useSurfaces()
  const profiles = useProfiles()
  const { snapshot: scheduler, reload: reloadScheduler } = useScheduler()
  const [chosenProfile, setChosenProfile] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)

  // Default to the profile the routed surfaces actually read, so the map
  // opens on the graph that is serving traffic rather than on `live` by
  // convention.
  const routedSurface = surfaces.find((s) => s.routingMode === 'routed')
  const fallbackProfile = routedSurface === undefined ? 'live' : routedSurface.profileKey
  const profileKey = chosenProfile === null ? fallbackProfile : chosenProfile

  const { profile } = usePreferences(surfaces.length === 0 ? null : profileKey)
  const weights = useMemo(() => weightIndex(scheduler), [scheduler])
  const targets = useMemo(() => profileTargets(profile.entriesByScenario), [profile])
  const _ruleCount = config === null ? 0 : allRules(config.Router).length
  const counts = t('routing.map.counts', {
    surfaces: surfaces.length,
    scenarios: SCENARIOS.length,
    targets: targets.length
  })

  const notify = useCallback((text: string, ok: boolean) => {
    if (ok) toast.success(text)
    else toast.error(text)
  }, [])

  const write = useCallback(
    (surface: SurfaceId, mode: 'routed' | 'passthrough') => {
      setMode(surface, mode).catch((err: unknown) => notify(err instanceof Error ? err.message : String(err), false))
    },
    [setMode, notify]
  )

  const toggleSurface = useCallback(
    (id: SurfaceId) => {
      const surface = surfaces.find((s) => s.id === id)
      if (surface === undefined) return
      write(id, surface.routingMode === 'routed' ? 'passthrough' : 'routed')
    },
    [surfaces, write]
  )

  const refresh = useCallback(() => {
    reloadSurfaces()
    reloadScheduler()
  }, [reloadSurfaces, reloadScheduler])

  const saveAsPreset = useCallback(() => {
    if (config === null) return
    const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(Date.now())
    const name = t('routing.map.snapshotName', { when })
    api
      .createRoutingPreset({ name, config: config.Router })
      .then(() => notify(t('routing.map.presetSaved', { name }), true))
      .catch((err: unknown) => notify(err instanceof Error ? err.message : String(err), false))
  }, [config, notify, t])

  return (
    <Screen
      crumbs={[{ label: t('routing.common.tabMap') }]}
      subtitle={`${profileKey} · ${counts}`}
      actions={
        <>
          <PresetsMenu onNotify={notify} />
          <RButton variant='ghost' icon='ri-play-line' onClick={() => navigate('/routing/rules')}>
            {t('routing.common.simulate')}
          </RButton>
        </>
      }
    >
      <SelectorBar />

      <div className='flex items-center gap-3 border-b border-border px-6 py-3'>
        <ProfileButton current={profileKey} profiles={profiles} onSelect={setChosenProfile} />
        {/* An empty graph could mean "unconfigured" or "nothing routes"; only
            the first is true, so it says which. */}
        {profileEntryCount(profile.entriesByScenario) === 0 ? (
          <Pill tone='warn'>{t('routing.common.notConfigured')}</Pill>
        ) : null}
        <span className='text-[12px] text-muted-foreground'>{counts}</span>
        <div className='ml-auto flex gap-2'>
          <RButton variant='outline' icon='ri-bookmark-line' onClick={saveAsPreset}>
            {t('routing.map.saveAsPreset')}
          </RButton>
          <RButton variant='primary' icon='ri-refresh-line' onClick={refresh}>
            {t('routing.map.refresh')}
          </RButton>
        </div>
      </div>

      <div className='relative overflow-hidden border-b border-border bg-muted/20'>
        <ZoomControls
          onZoom={(factor) => setZoom((z) => Math.min(3, Math.max(0.4, z * factor)))}
          onFit={() => setZoom(1)}
        />
        <Legend />
        <div style={{ transform: `scale(${zoom})`, transformOrigin: 'top left', width: `${100 / zoom}%` }}>
          <MapCanvas
            surfaces={surfaces}
            byScenario={profile.entriesByScenario}
            targets={targets}
            weights={weights}
            onDropOnScenario={(id) => write(id, 'routed')}
            onToggleSurface={toggleSurface}
          />
        </div>
      </div>

      <div className='px-6 py-4'>
        <div className='rounded-md border border-dashed border-border px-4 py-3 text-[12px] leading-relaxed text-muted-foreground'>
          <i className='ri-information-line mr-1 align-[-1px]' />
          {t('routing.map.note')}
        </div>
      </div>
      <div className='h-6' />
    </Screen>
  )
}
