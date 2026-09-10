/**
 * Live upstream usage polling (Claude /api/oauth/usage, Codex wham/usage)
 * plus the TTL-cached snapshot readers consumed by the API route and the
 * usage-history poller.
 */

import dayjs from '../../lib/dayjs'
import { logger } from '../../logger'
import type {
  ClaudeScopedWindow,
  ClaudeUsage,
  CodexUsage,
  CodexUsageWindowValue,
  GetUsageInput,
  GetUsageOutput,
  UsageResponse
} from '../../schemas/api/usage'
import { ClaudeUsageWireSchema, CodexUsageWireSchema } from '../../schemas/wire/usage'
import { ensureFreshCodexAccessToken } from '../codex-auth/token'
import { getSubAccountTokensForKind, type SubAccountTokenInfo } from '../subscription-account-sync-service'
import { claudeCache, codexCache, TTL_MS } from './cache'

const windowOf = (v: unknown): { utilization: number; resetsAt: string | null } | null => {
  if (v === null || typeof v !== 'object') return null
  if (!('utilization' in v) || typeof v.utilization !== 'number') return null
  const resetsAt = 'resets_at' in v && typeof v.resets_at === 'string' && v.resets_at.length > 0 ? v.resets_at : null
  return { utilization: v.utilization, resetsAt }
}

// Pull `weekly_scoped` limit rows from the response's `limits[]` array —
// each carries a `scope.model.display_name` (e.g. "Fable") and a `percent`.
// Every other kind (`session`, `weekly_all`) is ignored here; they mirror
// the flat `five_hour` / `seven_day` fields the top-level schema already
// covers.
const scopedWindowsOf = (v: unknown): ClaudeScopedWindow[] => {
  if (!Array.isArray(v)) return []
  const out: ClaudeScopedWindow[] = []
  for (const item of v) {
    if (item === null || typeof item !== 'object') continue
    if (!('kind' in item) || item.kind !== 'weekly_scoped') continue
    if (!('percent' in item) || typeof item.percent !== 'number') continue
    if (!('scope' in item) || item.scope === null || typeof item.scope !== 'object') continue
    const scope = item.scope
    if (!('model' in scope) || scope.model === null || typeof scope.model !== 'object') continue
    const model = scope.model
    if (!('display_name' in model) || typeof model.display_name !== 'string' || model.display_name.length === 0)
      continue
    const resetsAt =
      'resets_at' in item && typeof item.resets_at === 'string' && item.resets_at.length > 0 ? item.resets_at : null
    out.push({ modelName: model.display_name, utilization: item.percent, resetsAt })
  }
  return out
}

const codexWindowOf = (v: unknown): CodexUsageWindowValue | null => {
  if (v === null || typeof v !== 'object') return null
  if (!('used_percent' in v) || typeof v.used_percent !== 'number') return null
  const resetAt = 'reset_at' in v && typeof v.reset_at === 'number' ? dayjs(v.reset_at * 1000).toISOString() : null
  const windowSeconds =
    'limit_window_seconds' in v && typeof v.limit_window_seconds === 'number' ? v.limit_window_seconds : null
  return { usedPercent: v.used_percent, resetAt, windowSeconds }
}

const requestClaudeUsage = async (info: SubAccountTokenInfo): Promise<ClaudeUsage | null> => {
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        authorization: `Bearer ${info.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json'
      }
    })
    if (!res.ok) return null
    const parsed = ClaudeUsageWireSchema.safeParse(await res.json())
    if (!parsed.success) return null
    const j = parsed.data
    const extra = j.extra_usage
    const extraUsageEnabled =
      typeof extra === 'object' && extra !== null && 'is_enabled' in extra && extra.is_enabled === true
    return {
      subAccountId: info.subAccountId,
      accountLabel: info.displayName,
      fiveHour: windowOf(j.five_hour),
      sevenDay: windowOf(j.seven_day),
      sevenDaySonnet: windowOf(j.seven_day_sonnet),
      sevenDayOpus: windowOf(j.seven_day_opus),
      weeklyScoped: scopedWindowsOf(j.limits),
      extraUsageEnabled,
      capturedAt: dayjs().toISOString()
    }
  } catch {
    return null
  }
}

interface PollOutcome<T> {
  results: Array<{ subAccountId: string; usage: T }>
  // Accounts whose upstream call failed this pass. Each keeps its last
  // cached value in `results` when it has one — a stale reading beats a
  // gap for the poller's history — but a caller that promised a person
  // fresh numbers needs to know which account it could not deliver them for.
  failed: string[]
}

// One pass over a kind's accounts: serve the cache while it is inside
// TTL_MS, otherwise ask upstream and re-cache. `force` skips the TTL check
// and nothing else, so the forced path cannot drift from the scheduled one.
const pollAccounts = async <T>(
  accounts: readonly SubAccountTokenInfo[],
  cache: Map<string, { value: T; at: number }>,
  request: (info: SubAccountTokenInfo) => Promise<T | null>,
  force: boolean
): Promise<PollOutcome<T>> => {
  const results: PollOutcome<T>['results'] = []
  const failed: string[] = []
  for (const info of accounts) {
    const cached = cache.get(info.subAccountId)
    if (!force && cached && dayjs().valueOf() - cached.at < TTL_MS) {
      results.push({ subAccountId: info.subAccountId, usage: cached.value })
      continue
    }
    const next = await request(info)
    if (next) {
      cache.set(info.subAccountId, { value: next, at: dayjs().valueOf() })
      results.push({ subAccountId: info.subAccountId, usage: next })
      continue
    }
    failed.push(info.subAccountId)
    if (cached) results.push({ subAccountId: info.subAccountId, usage: cached.value })
  }
  return { results, failed }
}

// The same pool the account picker draws from, so an account on a
// switched-off provider is never polled either.
const accountsOf = (kind: 'claude' | 'codex'): Promise<SubAccountTokenInfo[]> =>
  getSubAccountTokensForKind(kind).catch(() => [])

const fetchClaudeUsage = async (input: GetUsageInput): Promise<PollOutcome<ClaudeUsage>> =>
  pollAccounts(await accountsOf('claude'), claudeCache, requestClaudeUsage, input.forceRefresh === true)

const requestCodexUsage = async (info: SubAccountTokenInfo): Promise<CodexUsage | null> => {
  try {
    // The poller runs on its own schedule, so the token it read from the
    // DB is routinely older than the request path's. Rotate it through
    // the shared codex-auth path (same in-flight lock as the proxy and
    // profile-sync) instead of spending a poll on a guaranteed 401.
    const accessToken = await ensureFreshCodexAccessToken({
      subAccountId: info.subAccountId,
      accessToken: info.accessToken,
      refreshToken: info.refreshToken,
      expiresAt: info.expiresAt
    })
    const res = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        ...(info.accountId ? { 'chatgpt-account-id': info.accountId } : {})
      }
    })
    if (!res.ok) {
      // Upstream error bodies here are typically JSON (token_expired, quota,
      // etc.) — parse when possible so the log record carries a structured
      // object the LogViewer / pino redact can walk, instead of a raw string
      // that gets chopped mid-key at an arbitrary character. Fall back to raw
      // text only when the body isn't JSON; cap that at 4KB defensively.
      const raw = await res.text().catch(() => '')
      const parsed = ((): unknown => {
        try {
          return JSON.parse(raw)
        } catch {
          return null
        }
      })()
      const body = parsed !== null ? parsed : raw.slice(0, 4096)
      logger.warn({ status: res.status, body }, '[codex] wham/usage non-OK')
      return null
    }
    const parsed = CodexUsageWireSchema.safeParse(await res.json())
    if (!parsed.success) {
      logger.warn('[codex] wham/usage response did not match expected shape')
      return null
    }
    const j = parsed.data
    const rl = j.rate_limit
    const primaryWindow =
      rl !== null && typeof rl === 'object' && 'primary_window' in rl ? rl.primary_window : undefined
    const secondaryWindow =
      rl !== null && typeof rl === 'object' && 'secondary_window' in rl ? rl.secondary_window : undefined
    return {
      subAccountId: info.subAccountId,
      accountLabel: info.displayName,
      planType: typeof j.plan_type === 'string' && j.plan_type.length > 0 ? j.plan_type : null,
      primary: codexWindowOf(primaryWindow),
      secondary: codexWindowOf(secondaryWindow),
      capturedAt: dayjs().toISOString()
    }
  } catch (e) {
    logger.warn({ err: e }, '[codex] wham/usage threw')
    return null
  }
}

const fetchCodexUsage = async (input: GetUsageInput): Promise<PollOutcome<CodexUsage>> =>
  pollAccounts(await accountsOf('codex'), codexCache, requestCodexUsage, input.forceRefresh === true)

const pollUsage = async (input: GetUsageInput) => {
  const [claude, codex] = await Promise.all([fetchClaudeUsage(input), fetchCodexUsage(input)])
  return { claude, codex }
}

export async function fetchUsageSnapshot(input: GetUsageInput = {}): Promise<GetUsageOutput> {
  const { claude, codex } = await pollUsage(input)
  return { usage: { claude: claude.results.map((r) => r.usage), codex: codex.results.map((r) => r.usage) } }
}

export async function getUsage(): Promise<UsageResponse> {
  const { usage } = await fetchUsageSnapshot()
  return usage
}

// Per-account variant of the snapshot — used by the poller to write
// per-account rows into SubAccountUsage (history-aggregated UsageSnapshot
// loses the subAccountId, so the value travels with its id here). Skips
// accounts whose upstream fetch failed AND that have no prior value;
// `failed` names every account whose fetch failed either way.
export async function fetchUsageSnapshotWithAccountIds(input: GetUsageInput = {}): Promise<{
  claude: Array<{ subAccountId: string; usage: ClaudeUsage }>
  codex: Array<{ subAccountId: string; usage: CodexUsage }>
  failed: string[]
}> {
  const { claude, codex } = await pollUsage(input)
  return { claude: claude.results, codex: codex.results, failed: [...claude.failed, ...codex.failed] }
}
