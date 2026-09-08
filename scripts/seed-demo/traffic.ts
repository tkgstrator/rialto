/**
 * The traffic archive: Session / Message / RequestLog rows.
 *
 * This is what Activity, Overview's spend and recent-session blocks, and
 * the per-token cost column all read. Rows are generated against the same
 * chains the routing seed wrote, so what Activity says was used and what
 * Routing says is configured tell the same story — a demo where the two
 * disagree is worse than no demo at all.
 */

import type { PrismaClient } from '../../src/generated/prisma/client'
import { CURATED_CONVERSATIONS, FILLER_TURNS } from './conversations'
import { demoId, demoSessionId } from './demo-rows'
import type { Random } from './random'
import type { ChainsByScenario } from './routing'
import type { DemoTarget } from './targets'

type ScenarioKey = 'default' | 'think' | 'longContext' | 'webSearch' | 'image'

interface SurfaceSpec {
  id: string
  inboundType: 'anthropic' | 'openai' | 'gemini'
  /** What the client puts in body.model before routing rewrites it. */
  requestedModels: string[]
  weight: number
}

// Weighted the way a Claude Code install actually looks: most traffic
// arrives on /v1/messages, with the OpenAI-compatible surfaces carrying
// the scripted / CI clients.
const SURFACES: SurfaceSpec[] = [
  {
    id: 'anthropic-messages',
    inboundType: 'anthropic',
    requestedModels: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5'],
    weight: 55
  },
  { id: 'openai-chat', inboundType: 'openai', requestedModels: ['gpt-5.6-terra', 'gpt-5.6-luna'], weight: 20 },
  { id: 'openai-responses', inboundType: 'openai', requestedModels: ['gpt-5.6-sol', 'gpt-5.6-terra'], weight: 15 },
  { id: 'gemini-generate', inboundType: 'gemini', requestedModels: ['gemini-3.7-flash'], weight: 10 }
]

const SCENARIO_WEIGHTS: ReadonlyArray<readonly [ScenarioKey, number]> = [
  ['default', 66],
  ['think', 12],
  ['longContext', 8],
  ['webSearch', 8],
  ['image', 6]
]

// Mostly 200s. The failures are here because every screen that shows an
// error rate or a 429 badge is otherwise untestable against demo data.
const STATUS_WEIGHTS: ReadonlyArray<readonly [number, number]> = [
  [200, 94],
  [429, 3],
  [500, 2],
  [400, 1]
]

// Working-hours shape, so the Activity timeline has a rhythm instead of
// a uniform smear across the day.
const HOUR_WEIGHTS: ReadonlyArray<readonly [number, number]> = [
  [9, 6],
  [10, 9],
  [11, 10],
  [13, 8],
  [14, 10],
  [15, 11],
  [16, 9],
  [17, 7],
  [20, 6],
  [21, 8],
  [22, 7],
  [23, 4],
  [1, 2],
  [7, 3]
]

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS

// Exponent on the session index → day offset curve. 1 spreads sessions
// evenly across the window; higher values crowd them toward now.
const RECENCY_BIAS = 2.2

/** Hex string of fixed length, so demo session ids look like real uuids. */
const hex = (random: Random, length: number): string =>
  Array.from({ length }, () => '0123456789abcdef'[random.int(0, 15)]).join('')

const uuidish = (random: Random): string =>
  `${hex(random, 8)}-${hex(random, 4)}-4${hex(random, 3)}-a${hex(random, 3)}-${hex(random, 12)}`

interface TurnPlan {
  scenario: ScenarioKey
  isSubagent: boolean
  target: DemoTarget
  requestedModel: string
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  durationMs: number
  status: number
  at: Date
}

// Walk the chain the way the router does: the primary answers most
// requests, and the tail only sees traffic when something upstream is
// unavailable — which is exactly what makes a fallback row interesting
// when it does show up in Activity.
const pickFromChain = (chain: DemoTarget[], random: Random): DemoTarget => {
  if (chain.length === 1) return chain[0]
  if (random.chance(0.78)) return chain[0]
  return random.pick(chain.slice(1))
}

function planTurn(
  chains: ChainsByScenario,
  surface: SurfaceSpec,
  random: Random,
  at: Date,
  turnIndex: number
): TurnPlan | null {
  const scenario = random.weighted(SCENARIO_WEIGHTS)
  const isSubagent = random.chance(0.15)
  const chain = isSubagent ? chains[scenario].subagent : chains[scenario].agent
  const usable = chain.length > 0 ? chain : chains.default.agent
  if (usable.length === 0) return null
  const target = pickFromChain(usable, random)
  const status = random.weighted(STATUS_WEIGHTS)

  // Context grows with the turn index; longContext requests start where
  // the others end up, which is what puts them over the threshold.
  const base = scenario === 'longContext' ? random.int(120_000, 420_000) : random.int(1_800, 26_000)
  const growth = Math.round(base * (1 + turnIndex * 0.12))
  // A resumed conversation reads most of its context from cache. The
  // first turn writes it instead — that asymmetry is the whole reason
  // the cache columns exist.
  const cacheReadTokens = turnIndex === 0 ? 0 : Math.round(growth * (random.int(45, 88) / 100))
  const cacheWriteTokens = turnIndex === 0 ? Math.round(growth * 0.6) : random.int(0, 2_400)
  const inputTokens = Math.max(200, growth - cacheReadTokens)
  const failed = status !== 200

  return {
    scenario,
    isSubagent,
    target,
    requestedModel: random.pick(surface.requestedModels),
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens: failed ? 0 : random.int(60, scenario === 'think' ? 5_200 : 2_400),
    // A rejected request comes back fast; a thinking one does not.
    durationMs: failed ? random.int(120, 900) : random.int(600, scenario === 'think' ? 24_000 : 9_000),
    status,
    at
  }
}

// Written out rather than inferred: Prisma's createMany input rejects a
// widened `Record<string, unknown>`, and naming the shape here is also
// where the RequestLog columns the demo cares about are documented.
type LogRow = {
  id: string
  sessionId: string
  provider: string
  model: string
  requestedModel: string
  scenario: string
  isSubagent: boolean
  inboundType: string
  surface: string
  accessTokenId: string | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalInputTokens: number
  cacheHitPct: number
  durationMs: number
  status: number
  createdAt: Date
}

type MessageRow = {
  id: string
  sessionId: string
  role: string
  // A user turn is stored as plain text; an assistant turn as the block
  // array the pipeline assembles.
  content: string | Array<{ type: string; text: string }>
  createdAt: Date
}

export interface TrafficOptions {
  days: number
  sessions: number
  /** Demo tokens to attribute traffic to; an empty list leaves it null. */
  accessTokenIds: string[]
}

export interface TrafficReport {
  sessions: number
  messages: number
  requestLogs: number
  archived: number
}

export async function seedTraffic(
  prisma: PrismaClient,
  chains: ChainsByScenario,
  random: Random,
  now: number,
  options: TrafficOptions
): Promise<TrafficReport> {
  const sessionRows: Array<{
    id: string
    createdAt: Date
    updatedAt: Date
    archivedAt: Date | null
    inboundType: string
  }> = []
  const messageRows: MessageRow[] = []
  const logRows: LogRow[] = []
  const counters = { messages: 0, logs: 0, archived: 0 }

  for (const index of Array.from({ length: options.sessions }, (_, i) => i)) {
    const surface = random.weighted(SURFACES.map((s) => [s, s.weight] as const))
    // Newest sessions first, so index 0 is "a moment ago" and the tail
    // spreads back over the window — the curated conversations then land
    // at the top of the History list where they are easy to find.
    //
    // The offset is superlinear on purpose: Activity opens on a 6-hour
    // window and Overview on 24, so a uniform spread over 30 days would
    // show an all-but-empty screen on first load. RECENCY_BIAS packs
    // roughly a quarter of the sessions into the last day.
    const dayOffset = Math.floor(options.days * (index / options.sessions) ** RECENCY_BIAS)
    const dayStart = now - dayOffset * DAY_MS
    const naiveStart =
      index === 0
        ? now - random.int(2, 40) * MINUTE_MS
        : new Date(dayStart).setHours(random.weighted(HOUR_WEIGHTS), random.int(0, 59), random.int(0, 59), 0)
    // Today's slot draws an hour-of-day like every other session, which
    // for a morning run lands in the future. Those fall back to "some
    // time in the last few hours" rather than being dropped.
    const startedAt = naiveStart > now - MINUTE_MS ? now - random.int(5, 320) * MINUTE_MS : naiveStart

    const curated = index < CURATED_CONVERSATIONS.length ? CURATED_CONVERSATIONS[index] : null
    const sessionId = curated === null ? demoSessionId(uuidish(random)) : demoSessionId(curated.id)
    // Chat content is captured for the newest handful only, mirroring an
    // install that turned CAPTURE_MESSAGES on partway through.
    const filler = curated === null && index < CURATED_CONVERSATIONS.length + 9
    const turnCount = curated === null ? random.int(1, 9) : curated.turns.length

    const plans = Array.from({ length: turnCount }, (_, turnIndex) => turnIndex).reduce<{
      at: number
      turns: TurnPlan[]
    }>(
      (state, turnIndex) => {
        const at = new Date(state.at)
        const plan = planTurn(chains, surface, random, at, turnIndex)
        if (plan === null) return state
        const curatedTurn = curated === null ? null : curated.turns[turnIndex]
        const merged =
          curatedTurn === null
            ? plan
            : {
                ...plan,
                scenario: 'default' as ScenarioKey,
                isSubagent: false,
                requestedModel: curated === null ? plan.requestedModel : curated.requestedModel,
                inputTokens: curatedTurn.inputTokens,
                outputTokens: curatedTurn.outputTokens,
                durationMs: curatedTurn.durationMs,
                status: 200
              }
        return { at: state.at + merged.durationMs + random.int(20, 240) * 1_000, turns: [...state.turns, merged] }
      },
      { at: startedAt, turns: [] }
    )

    if (plans.turns.length === 0) continue
    // A long session started late in the window can still run past now.
    // Shifting the whole session back keeps the turn spacing intact,
    // where clamping each turn would pile them onto one instant.
    const rawLastAt = plans.turns[plans.turns.length - 1].at.getTime()
    const overshoot = Math.max(0, rawLastAt + plans.turns[plans.turns.length - 1].durationMs - (now - MINUTE_MS))
    const at = (date: Date): Date => new Date(date.getTime() - overshoot)
    const lastAt = rawLastAt - overshoot
    // Only sessions well outside the History window are archived, so the
    // archived state is visible without hiding anything recent.
    const archived = dayOffset > 3 && random.chance(0.12)
    if (archived) counters.archived += 1

    sessionRows.push({
      id: sessionId,
      createdAt: at(new Date(startedAt)),
      updatedAt: new Date(lastAt),
      archivedAt: archived ? new Date(lastAt + 30 * MINUTE_MS) : null,
      inboundType: surface.inboundType
    })

    const accessTokenId =
      options.accessTokenIds.length === 0 || random.chance(0.35) ? null : random.pick(options.accessTokenIds)

    for (const [turnIndex, plan] of plans.turns.entries()) {
      const totalInputTokens = plan.inputTokens + plan.cacheReadTokens + plan.cacheWriteTokens
      counters.logs += 1
      logRows.push({
        id: demoId('log', counters.logs),
        sessionId,
        provider: plan.target.providerName,
        model: plan.target.modelName,
        requestedModel: plan.requestedModel,
        scenario: plan.scenario,
        isSubagent: plan.isSubagent,
        inboundType: surface.inboundType,
        surface: surface.id,
        accessTokenId,
        inputTokens: plan.inputTokens,
        outputTokens: plan.outputTokens,
        cacheReadTokens: plan.cacheReadTokens,
        cacheWriteTokens: plan.cacheWriteTokens,
        totalInputTokens,
        cacheHitPct: totalInputTokens === 0 ? 0 : Math.round((plan.cacheReadTokens / totalInputTokens) * 100),
        durationMs: plan.durationMs,
        status: plan.status,
        createdAt: at(new Date(plan.at.getTime() + plan.durationMs))
      })

      if (curated === null && !filler) continue
      const turn =
        curated === null ? FILLER_TURNS[(index * 3 + turnIndex) % FILLER_TURNS.length] : curated.turns[turnIndex]
      counters.messages += 1
      messageRows.push({
        id: demoId('msg', counters.messages),
        sessionId,
        role: 'user',
        content: turn.user,
        createdAt: at(plan.at)
      })
      // A failed turn never produced an assistant message; leaving it out
      // is what the pipeline does, and the chat view has to render it.
      if (plan.status !== 200) continue
      counters.messages += 1
      messageRows.push({
        id: demoId('msg', counters.messages),
        sessionId,
        role: 'assistant',
        content: [{ type: 'text', text: turn.assistant }],
        createdAt: at(new Date(plan.at.getTime() + plan.durationMs))
      })
    }
  }

  // Sessions first: RequestLog and Message both point at them.
  await prisma.session.createMany({ data: sessionRows })
  await prisma.requestLog.createMany({ data: logRows })
  await prisma.message.createMany({ data: messageRows })

  return {
    sessions: sessionRows.length,
    messages: counters.messages,
    requestLogs: counters.logs,
    archived: counters.archived
  }
}
