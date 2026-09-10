/**
 * Routing → Chain.
 *
 * The outermost axis is the inbound surface, not the scenario. Whether the
 * router applies at all is a per-surface fact, so the surface is the first
 * thing you pick and its mode is the second — a chain is never shown for
 * traffic that will not walk it. The old build had no such axis, which is
 * how a routing screen could quietly be about one endpoint only.
 */
import { useCallback, useMemo, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { RButton } from '@/components/rialto/primitives'
import { Screen } from '@/components/rialto/Screen'
import type { InboundSurfaceWire, RoutingMode, RoutingSchedulerWeightEntry } from '@/lib/api'
import { cn } from '@/lib/utils'
import { AddTargetDialog } from './AddTargetDialog'
import { ChainConstraints } from './ChainConstraints'
import { ChainTable } from './ChainTable'
import { useEnabledTargets, usePreferences, useProfiles, useScheduler, useSurfaces } from './data'
import { profileEntryCount, schedulerNotTickedYet, schedulerScoredNothing, weightIndex } from './derive'
import { PassthroughPanel } from './PassthroughPanel'
import { SurfaceBar } from './RoutingTabs'
import { Segmented, SurfaceScopeBar } from './SurfaceModeBar'
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

/**
 * Underline tabs, the same treatment the surface strip uses.
 *
 * These were filled chips while the two strips sat adjacent: two
 * underline rows stacked read as one nested inside the other, and the
 * surface is the outer axis, so it was the wrong one to lose its
 * emphasis. The scope strip sits between them now, so the ambiguity is
 * gone and the two selectors can look like what they both are.
 *
 * The tab spans the band rather than matching the 32px controls beside
 * it — `-my-2.5` with `self-stretch` cancels the band's padding — so the
 * underline lands on the band's own rule instead of floating above it,
 * which is what makes it read as a tab and not as underlined text.
 */
function ScenarioChips({
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
    // Equal columns rather than content width: "Long context" is twice
    // "Think", so packed side by side the strip read as five different
    // kinds of thing. auto-cols-fr rather than a fixed width — the labels
    // are translated, and the widest one is not the same string in every
    // locale.
    <div className='-my-2.5 grid grid-flow-col auto-cols-fr gap-0.5 self-stretch'>
      {SCENARIOS.map((scenario) => {
        const on = scenario === active
        return (
          <button
            key={scenario}
            type='button'
            onClick={() => onSelect(scenario)}
            className={cn(
              'flex h-full items-center justify-center gap-1.5 border-b-2 px-2.5 text-xs transition-colors',
              on
                ? 'border-b-foreground font-medium'
                : 'border-b-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {t(SCENARIO_LABEL_KEYS[scenario])}
            <span
              className={cn(
                'font-mono text-[12px] tabular-nums',
                on ? 'text-muted-foreground' : 'text-muted-foreground/70'
              )}
            >
              {counts[scenario]}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/**
 * Band 2: which chain, and what you can do to it.
 *
 * Scenario, lane and the actions used to be two bands — a full-width
 * scenario strip and a full-width toolbar under it — and both sat inside
 * the left column of a grid, so they were laid out in 320px less than
 * the page had. With the rail gone they fit in one row.
 *
 * The target count moved out of here and under the table, where it reads
 * as a total of the thing above it rather than as a fourth control in a
 * row of controls.
 */
function ChainBand({
  scenario,
  onScenario,
  counts,
  lane,
  onLane,
  onSave,
  saveDisabled
}: {
  scenario: ScenarioKey
  onScenario: (scenario: ScenarioKey) => void
  counts: Record<ScenarioKey, number>
  lane: Lane
  onLane: (lane: Lane) => void
  onSave: () => void
  saveDisabled: boolean
}) {
  const { t } = useTranslation()
  return (
    <div className='flex items-center gap-3 border-b border-border px-6 py-2.5'>
      <ScenarioChips counts={counts} active={scenario} onSelect={onScenario} />
      <span className='h-4 w-px bg-border' />
      <Segmented
        value={lane}
        options={[
          { value: 'agent', label: t('routing.common.laneAgent') },
          { value: 'subagent', label: t('routing.common.laneSubagent') }
        ]}
        onChange={onLane}
      />
      {/* Save alone. Add target moved under the table: five scenario
          chips, a lane switch and two buttons was more than one row should
          carry, and it does not act on the coordinate this band picks — it
          acts on the list below it. */}
      <div className='ml-auto'>
        <RButton variant='primary' icon='ri-check-line' onClick={onSave} disabled={saveDisabled}>
          {t('common.save')}
        </RButton>
      </div>
    </div>
  )
}

/**
 * The total, under the thing it totals — with the one action that adds
 * to it.
 *
 * "Add target" appends a row to the table directly above, which is where
 * a reader looks for it once they have read the last one.
 *
 * The count line also carries the one sentence left of the four-line
 * dashed box that used to close the table. The rest of that box
 * explained the Share column, which is where the explanation belongs —
 * it is a marker on that header now.
 *
 * This renders even when the lane is empty. The button is the only way
 * out of an empty lane, so it cannot live inside the branch that an
 * empty lane skips.
 */
function ChainFooter({
  entries,
  targets,
  onAdd
}: {
  entries: readonly PreferenceEntry[]
  targets: readonly EnabledTarget[]
  onAdd: (target: string) => void
}) {
  const { t } = useTranslation()
  const disabled = entries.filter((e) => !e.enabled).length
  const taken = useMemo(() => new Set(entries.map((e) => e.target)), [entries])
  return (
    <div className='flex items-center gap-3 border-t border-border/60 px-6 py-2.5'>
      <span className='text-[12px] text-muted-foreground'>
        {t('routing.common.targetCount', { n: entries.length })}
        {disabled === 0 ? '' : ` · ${t('routing.chain.disabledCount', { n: disabled })}`}
        {entries.length === 0 ? '' : ` · ${t('routing.chain.orderHint')}`}
      </span>
      <div className='ml-auto flex items-center gap-2'>
        <AddTargetDialog targets={targets} taken={taken} onAdd={onAdd} />
      </div>
    </div>
  )
}

/**
 * A profile with no entries anywhere is unconfigured, not broken: each
 * request passes through with the model the caller asked for. Saying "no
 * targets" here would read as "this traffic goes nowhere", which is the
 * opposite of what happens.
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
}

function RoutedBody(props: RoutedBodyProps) {
  const { t } = useTranslation()
  const { entries, actions, addTarget, counts } = useChainEditing(
    props.profile,
    props.setProfile,
    props.scenario,
    props.lane
  )

  // No grid. The chain runs the full width and its constraints follow it
  // as a footer — see ChainConstraints for why the rail went.
  return (
    <>
      <ChainBand
        scenario={props.scenario}
        onScenario={props.onScenario}
        counts={counts}
        lane={props.lane}
        onLane={props.onLane}
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
      <ChainFooter entries={entries} targets={props.targets} onAdd={addTarget} />
      <ChainConstraints constraints={props.profile.constraints} />
    </>
  )
}

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
  const { surfaces, loading, error, setMode, setProfile: setSurfaceProfile, setTargetAllowed } = useSurfaces()
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

  // No subtitle on the Screen. It read "{path} · routed · {profile}",
  // which is the surface tab, the mode switch and the profile picker of
  // band 1 spelled out a second time one line above them.
  return (
    <Screen>
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
          <SurfaceBar surfaces={surfaces} active={surface.id} onSelect={selectSurface} />
          <SurfaceScopeBar surface={surface} profiles={profiles} onMode={onMode} onProfile={onProfile} />
          {/* The notes explain a missing live reading, and Share is the
              only one on this screen — the passthrough half has no
              scheduler-fed column at all now, so they render inside the
              routed branch rather than above both. */}
          {surface.routingMode === 'routed' ? (
            <>
              {noChainToScore ? <SchedulerNote i18nKey='routing.chain.schedulerNoChain' /> : null}
              {notTickedYet ? <SchedulerNote i18nKey='routing.chain.schedulerNotTicked' /> : null}
            </>
          ) : null}
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
            />
          ) : (
            <PassthroughPanel surface={surface} targets={targets} onSetDenied={setTargetAllowed} />
          )}
        </>
      )}
    </Screen>
  )
}
