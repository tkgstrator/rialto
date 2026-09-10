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

const fetchClaudeUsage = async (): Promise<ClaudeUsage[]> => {
  const accounts = await getSubAccountTokensForKind('claude').catch(() => [])
  const results: ClaudeUsage[] = []
  for (const info of accounts) {
    const cached = claudeCache.get(info.subAccountId)
    if (cached && dayjs().valueOf() - cached.at < TTL_MS) {
      results.push(cached.value)
      continue
    }
    const next = await requestClaudeUsage(info)
    if (next) {
      claudeCache.set(info.subAccountId, { value: next, at: dayjs().valueOf() })
      results.push(next)
    } else if (cached) {
      results.push(cached.value)
    }
  }
  return results
}

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

const fetchCodexUsage = async (): Promise<CodexUsage[]> => {
  const accounts = await getSubAccountTokensForKind('codex').catch(() => [])
  const results: CodexUsage[] = []
  for (const info of accounts) {
    const cached = codexCache.get(info.subAccountId)
    if (cached && dayjs().valueOf() - cached.at < TTL_MS) {
      results.push(cached.value)
      continue
    }
    const next = await requestCodexUsage(info)
    if (next) {
      codexCache.set(info.subAccountId, { value: next, at: dayjs().valueOf() })
      results.push(next)
    } else if (cached) {
      results.push(cached.value)
    }
  }
  return results
}

export async function fetchUsageSnapshot(_input: GetUsageInput = {}): Promise<GetUsageOutput> {
  const [claude, codex] = await Promise.all([fetchClaudeUsage(), fetchCodexUsage()])
  return { usage: { claude, codex } }
}

export async function getUsage(): Promise<UsageResponse> {
  const { usage } = await fetchUsageSnapshot()
  return usage
}

// Per-account variant of the snapshot — used by the poller to write
// per-account rows into SubAccountUsage (history-aggregated UsageSnapshot
// loses the subAccountId, so we pair the cached value with its id
// directly here). Skips accounts whose cache is missing because the
// upstream fetch failed AND no prior value exists.
export async function fetchUsageSnapshotWithAccountIds(): Promise<{
  claude: Array<{ subAccountId: string; usage: ClaudeUsage }>
  codex: Array<{ subAccountId: string; usage: CodexUsage }>
}> {
  // Force a refresh by going through the public fetch path — this
  // ensures the cache is populated before we read it below.
  await fetchUsageSnapshot()
  const claudeAccts = await getSubAccountTokensForKind('claude').catch(() => [])
  const codexAccts = await getSubAccountTokensForKind('codex').catch(() => [])
  const claude: Array<{ subAccountId: string; usage: ClaudeUsage }> = []
  const codex: Array<{ subAccountId: string; usage: CodexUsage }> = []
  for (const a of claudeAccts) {
    const cached = claudeCache.get(a.subAccountId)
    if (cached) claude.push({ subAccountId: a.subAccountId, usage: cached.value })
  }
  for (const a of codexAccts) {
    const cached = codexCache.get(a.subAccountId)
    if (cached) codex.push({ subAccountId: a.subAccountId, usage: cached.value })
  }
  return { claude, codex }
}
