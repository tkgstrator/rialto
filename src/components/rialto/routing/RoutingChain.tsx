/**
 * Routing → Chain.
 *
 * The outermost axis is the inbound surface, not the scenario. Whether the
 * router applies at all is a per-surface fact, so the surface is the first
 * thing you pick and its mode is the second — a chain is never shown for
 * traffic that will not walk it. The old build had no such axis, which is
 * how a routing screen could quietly be about one endpoint only.
 */
import type { TFunction } from 'i18next'
import { useCallback, useMemo, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useConfig } from '@/components/ConfigProvider'
import { RButton } from '@/components/rialto/primitives'
import { Screen } from '@/components/rialto/Screen'
import type { InboundSurfaceWire, RoutingMode, RoutingSchedulerWeightEntry } from '@/lib/api'
import { cn } from '@/lib/utils'
import { AddTargetDialog } from './AddTargetDialog'
import { ChainRail } from './ChainRail'
import { ChainTable } from './ChainTable'
import { useEnabledTargets, usePreferences, useProfiles, useScheduler, useSurfaces } from './data'
import { profileEntryCount, schedulerNotTickedYet, schedulerScoredNothing, weightIndex } from './derive'
import { PassthroughPanel } from './PassthroughPanel'
import { SurfaceTabs } from './RoutingTabs'
import { Segmented, SurfaceModeBar } from './SurfaceModeBar'
import type { EnabledTarget, Lane, PreferenceEntry, PreferenceProfile, ScenarioKey } from './types'
import { SCENARIOS } from './types'
import { useChainEditing } from './useChainEditing'
import { useRoutingSelection } from './useRoutingSelection'

const SCENARIO_LABEL_KEYS: Record<ScenarioKey, string> = {
  default: 'routing.chain.scenarioDefault',
  think: 'routing.chain.scenarioThink',
  longContext: 'routing.chain.scenarioLongContext',
  webSearch: 'routing.chain.scenarioWebSearch',
  image: 'routing.chain.scenarioImage'
}

function ScenarioTabs({
  counts,
  active,
  onSelect
}: {
  counts: Record<ScenarioKey, number>
  active: ScenarioKey
  onSelect: (scenario: ScenarioKey) => void
}) {
  const { t } = useTranslation()
  return (
    <div className='flex items-center gap-1 border-b border-border px-6'>
      {SCENARIOS.map((scenario) => (
        <button
          key={scenario}
          type='button'
          onClick={() => onSelect(scenario)}
          className={cn(
            // py-3, not py-2: the strip is where a scenario is switched,
            // and at 8px of padding it read as a caption over the table
            // rather than a control you aim at.
            'flex items-center gap-2 border-b-2 px-3 py-3 text-xs transition-colors',
            scenario === active
              ? 'border-b-foreground font-medium'
              : 'border-b-transparent text-muted-foreground hover:text-foreground'
          )}
        >
          {t(SCENARIO_LABEL_KEYS[scenario])}
          <span className='font-mono text-[12px] tabular-nums text-muted-foreground'>{counts[scenario]}</span>
        </button>
      ))}
    </div>
  )
}

function ChainToolbar({
  lane,
  onLane,
  entries,
  targets,
  onAdd,
  onSave,
  saveDisabled
}: {
  lane: Lane
  onLane: (lane: Lane) => void
  entries: readonly PreferenceEntry[]
  targets: readonly EnabledTarget[]
  onAdd: (target: string) => void
  onSave: () => void
  saveDisabled: boolean
}) {
  const { t } = useTranslation()
  const disabled = entries.filter((e) => !e.enabled).length
  const taken = useMemo(() => new Set(entries.map((e) => e.target)), [entries])
  return (
    <div className='flex items-center gap-3 px-6 py-3'>
      <Segmented
        value={lane}
        options={[
          { value: 'agent', label: t('routing.common.laneAgent') },
          { value: 'subagent', label: t('routing.common.laneSubagent') }
        ]}
        onChange={onLane}
      />
      <span className='text-[12px] text-muted-foreground'>
        {t('routing.common.targetCount', { n: entries.length })}
        {disabled === 0 ? '' : ` · ${t('routing.chain.disabledCount', { n: disabled })}`}
      </span>
      <div className='ml-auto flex gap-2'>
        <AddTargetDialog targets={targets} taken={taken} onAdd={onAdd} />
        <RButton variant='primary' icon='ri-check-line' onClick={onSave} disabled={saveDisabled}>
          {t('common.save')}
        </RButton>
      </div>
    </div>
  )
}

function ChainNote() {
  return (
    <div className='px-6 py-4'>
      <div className='rounded-md border border-dashed border-border px-4 py-3 text-[12px] leading-relaxed text-muted-foreground'>
        <i className='ri-information-line mr-1 align-[-1px]' />
        <Trans i18nKey='routing.chain.note' components={{ mono: <span className='font-mono' /> }} />
      </div>
    </div>
  )
}

/**
 * A profile with no entries anywhere is unconfigured, not broken: the
 * request falls through to the scenario router. Saying "no targets" here
 * would read as "this traffic goes nowhere", which is the opposite of what
 * happens.
 */
function UnconfiguredProfile({ surface }: { surface: InboundSurfaceWire }) {
  return (
    <div className='border-t border-border/60 px-6 py-6'>
      <div className='rounded-md border border-dashed border-border px-4 py-3 text-[12px] leading-relaxed text-muted-foreground'>
        <i className='ri-information-line mr-1 align-[-1px]' />
        <Trans
          i18nKey='routing.chain.unconfiguredProfile'
          values={{ profile: surface.profileKey, path: surface.path }}
          components={{ mono: <span className='font-mono' /> }}
        />
      </div>
    </div>
  )
}

interface RoutedBodyProps {
  surface: InboundSurfaceWire
  profile: PreferenceProfile
  setProfile: React.Dispatch<React.SetStateAction<PreferenceProfile>>
  scenario: ScenarioKey
  onScenario: (scenario: ScenarioKey) => void
  lane: Lane
  onLane: (lane: Lane) => void
  targets: readonly EnabledTarget[]
  weights: Map<string, RoutingSchedulerWeightEntry>
  onSave: () => void
  saveDisabled: boolean
  onNotify: (text: string, ok: boolean) => void
}

function RoutedBody(props: RoutedBodyProps) {
  const { t } = useTranslation()
  const { config } = useConfig()
  const { entries, actions, addTarget, counts } = useChainEditing(
    props.profile,
    props.setProfile,
    props.scenario,
    props.lane
  )

  return (
    <div className='grid grid-cols-[1fr_20rem]'>
      <div className='min-w-0 border-r border-border'>
        <ScenarioTabs counts={counts} active={props.scenario} onSelect={props.onScenario} />
        <ChainToolbar
          lane={props.lane}
          onLane={props.onLane}
          entries={entries}
          targets={props.targets}
          onAdd={addTarget}
          onSave={props.onSave}
          saveDisabled={props.saveDisabled}
        />
        {entries.length === 0 ? (
          profileEntryCount(props.profile.entriesByScenario) === 0 ? (
            <UnconfiguredProfile surface={props.surface} />
          ) : (
            <div className='border-t border-border/60 px-6 py-6 text-xs text-muted-foreground'>
              {t('routing.chain.emptyLane')}
            </div>
          )
        ) : (
          <ChainTable entries={entries} weights={props.weights} actions={actions} />
        )}
        <ChainNote />
      </div>
      <ChainRail
        constraints={props.profile.constraints}
        profileKey={props.surface.profileKey}
        onApplied={props.setProfile}
        onNotify={props.onNotify}
      />
    </div>
  )
}

const subtitleFor = (surface: InboundSurfaceWire, t: TFunction): string =>
  surface.routingMode === 'routed'
    ? // Both placeholders have to be passed here: i18next renders an
      // unsupplied one verbatim, so the header read "{{path}} · routed ·
      // {{profile}}" on every routed surface.
      t('routing.chain.subtitleRouted', { path: surface.path, profile: surface.profileKey })
    : t('routing.chain.subtitlePassthrough', { path: surface.path })

/**
 * Why every State column reads `unknown`.
 *
 * The states come from the scheduler's published weights, and there are
 * two independent reasons there may be none — so there are two notes.
 * The scheduler only ticks for quota-aware selection, and even when it
 * ticks it builds its weights entirely from the preference chain. An
 * install with the mode on and no chain configured publishes an empty
 * snapshot, and the column is just as permanently `unknown`.
 *
 * The first version of this note named only the mode, which sent an
 * operator with no chain to flip a switch that changed nothing on their
 * screen. Whichever half is missing is the half worth naming.
 */
function SchedulerNote({ i18nKey }: { i18nKey: string }) {
  return (
    <div className='px-6 pt-5'>
      <div className='rounded-md border border-dashed border-border px-4 py-3 text-[12px] leading-relaxed text-muted-foreground'>
        <i className='ri-information-line mr-1 align-[-1px]' />
        <Trans i18nKey={i18nKey} components={{ mono: <span className='font-mono' /> }} />
      </div>
    </div>
  )
}

export function RoutingChain() {
  const { t } = useTranslation()
  const { config } = useConfig()
  const { surfaces, loading, error, setMode, setProfile: setSurfaceProfile } = useSurfaces()
  const profiles = useProfiles()
  const { snapshot: scheduler } = useScheduler()
  const targets = useEnabledTargets()

  const [saving, setSaving] = useState(false)
  // Surface / scenario / lane live in the query string, not in state: the
  // passthrough half of this screen is only reachable as a URL, and an
  // operator mid-way through a chain should survive a reload.
  const { surface, scenario, lane, selectSurface, selectScenario, selectLane } = useRoutingSelection(surfaces)

  const { profile, setProfile, dirty, save } = usePreferences(surface === undefined ? null : surface.profileKey)
  const weights = useMemo(() => weightIndex(scheduler), [scheduler])
  // The scheduler always runs now. It used to sit armed and idle under
  // the rules selector, which needed its own permanent note; the two
  // remaining states are transient and resolve within a tick.
  const noChainToScore = schedulerScoredNothing(scheduler)
  const notTickedYet = schedulerNotTickedYet(scheduler)

  const notify = useCallback((text: string, ok: boolean) => {
    if (ok) toast.success(text)
    else toast.error(text)
  }, [])

  const fail = useCallback((err: unknown) => notify(err instanceof Error ? err.message : String(err), false), [notify])

  const onSave = useCallback(() => {
    setSaving(true)
    save()
      .then((outcome) => {
        notify(outcome.success ? t('routing.chain.saved') : t('routing.chain.saveFailed'), outcome.success)
        for (const warning of outcome.warnings) toast.warning(warning)
      })
      .catch(fail)
      .finally(() => setSaving(false))
  }, [save, notify, fail, t])

  // The mode, the profile and the reset apply on click — there is no
  // Save for them, in the design or here, because each is a single
  // choice rather than an edit in progress. That only reads as
  // deliberate if the write is acknowledged; silence is
  // indistinguishable from a dropped click, which is what makes people
  // go looking for a Save button.
  const onMode = useCallback(
    (mode: RoutingMode) => {
      if (surface === undefined) return
      setMode(surface.id, mode)
        .then(() =>
          notify(
            t('routing.chain.modeChanged', {
              path: surface.path,
              mode: t(mode === 'routed' ? 'routing.common.modeRouted' : 'routing.common.modePassthrough')
            }),
            true
          )
        )
        .catch(fail)
    },
    [surface, setMode, notify, fail, t]
  )

  const onProfile = useCallback(
    (key: string) => {
      if (surface === undefined) return
      setSurfaceProfile(surface.id, surface.routingMode, key)
        .then(() => notify(t('routing.chain.profileChanged', { path: surface.path, profile: key }), true))
        .catch(fail)
    },
    [surface, setSurfaceProfile, notify, fail, t]
  )

  return (
    <Screen subtitle={surface === undefined ? undefined : subtitleFor(surface, t)}>
      {/* No selector bar. There is one selector now: the operator says
          which models and in what order, and the scheduler computes the
          weights. A segmented control offering a second option that no
          longer exists would be a switch with one position. */}
      {error === null ? null : <div className='px-6 py-6 text-xs text-destructive'>{error}</div>}
      {surface === undefined ? (
        <div className='px-6 py-6 text-xs text-muted-foreground'>
          {loading ? t('common.loading') : t('routing.chain.noSurfaces')}
        </div>
      ) : (
        <>
          <SurfaceTabs surfaces={surfaces} active={surface.id} onSelect={selectSurface} />
          <SurfaceModeBar surface={surface} profiles={profiles} onMode={onMode} onProfile={onProfile} />
          {noChainToScore ? <SchedulerNote i18nKey='routing.chain.schedulerNoChain' /> : null}
          {notTickedYet ? <SchedulerNote i18nKey='routing.chain.schedulerNotTicked' /> : null}
          {surface.routingMode === 'routed' ? (
            <RoutedBody
              surface={surface}
              profile={profile}
              setProfile={setProfile}
              scenario={scenario}
              onScenario={selectScenario}
              lane={lane}
              onLane={selectLane}
              targets={targets}
              weights={weights}
              onSave={onSave}
              saveDisabled={saving || !dirty}
              onNotify={notify}
            />
          ) : (
            <PassthroughPanel surface={surface} targets={targets} weights={weights} />
          )}
        </>
      )}
    </Screen>
  )
}
