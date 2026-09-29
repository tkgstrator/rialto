/**
 * `status` — how much Codex is left, and what can be asked of it.
 *
 * Read from what Rialto already holds, never from the vendor: the quota
 * windows are the SubAccountQuota rows the usage collector keeps current,
 * and `measuredAt` says how old each reading is. Polling the vendor here
 * would let any tool call trigger a round of upstream requests.
 *
 * Its reach is why the `codex-mcp` scope is opt-in: this is the operator's
 * accounts, their plans and how much of each is spent.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { getPrismaClient } from '../../db/client'
import dayjs from '../../lib/dayjs'
import { noteTokenUse } from '../../services/access-token-service'
import { isAccountExhausted } from '../../services/failover-state'
import { getSubscriptionsInfo } from '../../services/subscription-info-service'
import { isReasoningEffort } from '../../shared/model-reasoning-effort'
import { planLabel } from '../../shared/plan-label'
import { type CodexTarget, codexModels, codexProviderNames, targetId } from './targets'
import { type ToolContext, textResult } from './tool-context'

interface Window {
  usedPercent: number | null
  resetsAt: string | null
}

const windowOf = (used: number | null, limit: number | null, resetAt: Date | null): Window => ({
  // Codex reports a percentage against a limit of 100; divide anyway so a
  // row carrying some other limit still reads as a percentage.
  usedPercent: used === null ? null : Math.round(limit !== null && limit > 0 ? (used / limit) * 100 : used),
  resetsAt: resetAt === null ? null : resetAt.toISOString()
})

async function accountsReport() {
  const [names, subscriptions] = await Promise.all([codexProviderNames(), getSubscriptionsInfo()])
  const accounts = subscriptions
    .filter((s) => names.has(s.providerName))
    .flatMap((s) => s.accounts.map((a) => ({ provider: s.providerName, providerEnabled: s.enabled, account: a })))
  const quotas = await getPrismaClient().subAccountQuota.findMany({
    where: { subAccountId: { in: accounts.map((a) => a.account.id) } }
  })
  const quotaOf = new Map(quotas.map((q) => [q.subAccountId, q]))
  return accounts.map(({ provider, providerEnabled, account }) => {
    const q = quotaOf.get(account.id)
    return {
      provider,
      account: account.label,
      plan: planLabel('codex', account.plan, account.rateLimitTier),
      enabled: providerEnabled && account.enabled,
      auth: account.authStatus,
      // Marked by a 429 and not yet expired: the router skips it until then.
      rateLimited: isAccountExhausted(account.id),
      fiveHour: q === undefined ? null : windowOf(q.fiveHourUsed, q.fiveHourLimit, q.fiveHourResetAt),
      weekly: q === undefined ? null : windowOf(q.weeklyUsed, q.weeklyLimit, q.weeklyResetAt),
      bankedResets: q === undefined ? null : q.resetCreditsAvailable,
      measuredAt: q === undefined || q.quotaRefreshedAt === null ? null : q.quotaRefreshedAt.toISOString()
    }
  })
}

/** The caller's own daily allowance, for a token on a capped plan. */
async function allowanceReport(ctx: ToolContext) {
  const limit = ctx.token.plan === null ? null : ctx.token.plan.dailyRequestLimit
  if (limit === null) return null
  // The same UTC day key consumeDailyRequest writes under.
  const day = dayjs().toDate().toISOString().slice(0, 10)
  const row = await getPrismaClient().accessTokenDailyUsage.findUnique({
    where: { accessTokenId_day: { accessTokenId: ctx.token.id, day } }
  })
  return { dailyLimit: limit, usedToday: row === null ? 0 : row.requests, resetsAt: 'next 00:00 UTC' }
}

// The levels each model's own Codex list reported, recorded once
// (ModelCapability). A model not recorded yet reports null.
async function recordedEfforts(targets: readonly CodexTarget[]): Promise<Map<string, string[]>> {
  if (targets.length === 0) return new Map()
  const rows = await getPrismaClient().modelCapability.findMany({
    where: {
      model: {
        name: { in: targets.map((t) => t.model) },
        provider: { name: { in: [...new Set(targets.map((t) => t.provider))] } }
      }
    },
    select: { efforts: true, model: { select: { name: true, provider: { select: { name: true } } } } }
  })
  return new Map(
    rows.map((row) => [
      targetId({ provider: row.model.provider.name, model: row.model.name }),
      row.efforts.filter(isReasoningEffort)
    ])
  )
}

export async function status(ctx: ToolContext): Promise<CallToolResult> {
  noteTokenUse(ctx.token.id)
  const [accounts, chat, images, allowance] = await Promise.all([
    accountsReport(),
    codexModels('completion'),
    codexModels('image'),
    allowanceReport(ctx)
  ])
  const efforts = await recordedEfforts(chat)
  const report = {
    accounts,
    models: chat.map((m) => {
      const recorded = efforts.get(targetId(m))
      return { model: targetId(m), reasoningEfforts: recorded === undefined ? null : recorded }
    }),
    imageModels: images.map(targetId),
    ...(allowance === null ? {} : { yourToken: allowance })
  }
  return textResult(JSON.stringify(report, null, 2))
}

export function registerStatusTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'status',
    {
      title: 'Codex status',
      description: [
        "The operator's Codex subscription accounts — how much of each 5-hour and weekly window is used and",
        'when it resets — and the Codex models and image models `ask` and `generate_image` can use.',
        'Use it to pick a model, or to find out why Codex is rate limited.'
      ].join('\n'),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => status(ctx)
  )
}
