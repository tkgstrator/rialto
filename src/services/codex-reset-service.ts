/**
 * Banked Codex rate-limit resets.
 *
 * A ChatGPT plan can hold "rate limit reset" credits: spending one puts the
 * account's 5-hour and weekly windows back to zero. The Codex app spends
 * them from its Settings; an operator running several accounts through
 * Rialto wants to see how many each holds, when they lapse (unspent
 * credits expire), and to spend one without opening the app.
 *
 * Spending is only ever an operator's click. A credit is finite, lapses on
 * its own clock, and the vendor keeps no "unspend", so nothing here decides
 * to use one.
 *
 * Both endpoints are the undocumented `wham` side channel Rialto already
 * polls for usage. The list's shape comes from a live response; the
 * consume request mirrors what the Codex CLI sends (`credit_id` plus a
 * `redeem_request_id` idempotency key) and its response is read loosely —
 * any 2xx is success, and the body is logged so the first real spend
 * documents it.
 *
 * After a spend the account's usage is re-polled through the same path as
 * the Providers screens' Refresh, which lands the fresh windows, lifts the
 * exhaustion marks routing held against the account, and republishes the
 * routing snapshot — so the account takes traffic as soon as this answers.
 */

import { randomUUID } from 'node:crypto'
import { getPrismaClient } from '../db/client'
import type { PrismaClient } from '../generated/prisma/client'
import dayjs from '../lib/dayjs'
import { logger } from '../logger'
import { type CodexResetCreditsWire, CodexResetCreditsWireSchema } from '../schemas/wire/usage'
import { ensureFreshCodexAccessToken } from './codex-auth/token'
import { getSubAccountTokenById } from './subscription-account-sync-service'
import { refreshAccountUsage } from './subscription-refresh-service'

const WHAM = 'https://chatgpt.com/backend-api/wham'

export interface ResetCredit {
  id: string
  grantedAt: string | null
  expiresAt: string | null
}

export interface ResetCreditsView {
  credits: ResetCredit[]
  applicable: number | null
}

export interface UseResetResult {
  spentCreditId: string
  remaining: number
  refreshed: boolean
}

// What went wrong, as the HTTP status the route answers with.
//   404: no such account; 409: not a Codex account, or nothing to spend,
//   or the vendor refused the spend; 502: the vendor could not be read.
export class ResetCreditError extends Error {
  constructor(
    readonly status: 404 | 409 | 502,
    message: string
  ) {
    super(message)
  }
}

/**
 * The credits that can be spent, soonest to lapse first.
 *
 * "available" is the status the live list uses for an unspent credit; a
 * credit the plan does not support is left out because the vendor would
 * refuse it. Spending the one closest to expiry first is the only order
 * that never lets one lapse while a later one is used.
 */
export function spendableCredits(wire: CodexResetCreditsWire): ResetCredit[] {
  const toCredit = (c: CodexResetCreditsWire['credits'][number]): ResetCredit => ({
    id: c.id,
    grantedAt: c.granted_at === undefined ? null : c.granted_at,
    expiresAt: c.expires_at === undefined ? null : c.expires_at
  })
  // An unknown expiry sorts last: it cannot be the one about to lapse.
  const expiryOf = (c: ResetCredit): number =>
    c.expiresAt === null ? Number.POSITIVE_INFINITY : dayjs(c.expiresAt).valueOf()
  return wire.credits
    .filter((c) => c.status === 'available' && c.is_supported_by_plan)
    .map(toCredit)
    .sort((a, b) => expiryOf(a) - expiryOf(b))
}

interface CodexCall {
  subAccountId: string
  headers: Record<string, string>
}

// The account, its fresh token, and the headers wham expects. The token is
// rotated through the shared codex-auth path first, like every other wham
// call, rather than spending the request on a guaranteed 401.
async function codexCallFor(subAccountId: string, prisma: PrismaClient): Promise<CodexCall> {
  const account = await getSubAccountTokenById(subAccountId, prisma)
  if (account === null) throw new ResetCreditError(404, 'No such subscription account')
  if (account.kind !== 'codex') {
    throw new ResetCreditError(409, 'Banked resets are a Codex feature; this account is not a Codex account')
  }
  const { info } = account
  const token = await ensureFreshCodexAccessToken({
    subAccountId: info.subAccountId,
    accessToken: info.accessToken,
    refreshToken: info.refreshToken,
    expiresAt: info.expiresAt
  })
  return {
    subAccountId,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(info.accountId ? { 'chatgpt-account-id': info.accountId } : {})
    }
  }
}

// The vendor's own words for a refusal, when its body carries any.
const vendorMessage = (body: unknown, fallback: string): string => {
  if (body === null || typeof body !== 'object') return fallback
  if ('detail' in body && typeof body.detail === 'string' && body.detail.length > 0) return body.detail
  if ('error' in body && body.error !== null && typeof body.error === 'object' && 'message' in body.error) {
    const message = body.error.message
    if (typeof message === 'string' && message.length > 0) return message
  }
  return fallback
}

const readJson = async (res: Response): Promise<unknown> => {
  const text = await res.text().catch(() => '')
  try {
    return JSON.parse(text)
  } catch {
    return text.slice(0, 4096)
  }
}

async function fetchCredits(call: CodexCall): Promise<ResetCredit[]> {
  const res = await fetch(`${WHAM}/rate-limit-reset-credits`, { headers: call.headers }).catch((err: unknown) => {
    logger.warn({ err, subAccountId: call.subAccountId }, '[codex-reset] credit list unreachable')
    return null
  })
  if (res === null) throw new ResetCreditError(502, 'Could not reach OpenAI to read the reset credits')
  const body = await readJson(res)
  if (!res.ok) {
    logger.warn({ status: res.status, body, subAccountId: call.subAccountId }, '[codex-reset] credit list refused')
    throw new ResetCreditError(502, vendorMessage(body, `OpenAI answered ${res.status} for the reset credits`))
  }
  const parsed = CodexResetCreditsWireSchema.safeParse(body)
  if (!parsed.success) {
    logger.warn({ subAccountId: call.subAccountId }, '[codex-reset] credit list did not match the expected shape')
    throw new ResetCreditError(502, 'OpenAI returned reset credits in a shape Rialto does not recognise')
  }
  return spendableCredits(parsed.data)
}

// How many credits the vendor would accept now, from the last usage poll.
const applicableFor = async (subAccountId: string, prisma: PrismaClient): Promise<number | null> => {
  const quota = await prisma.subAccountQuota.findUnique({
    where: { subAccountId },
    select: { resetCreditsApplicable: true }
  })
  return quota === null ? null : quota.resetCreditsApplicable
}

/** The account's spendable credits, read from the vendor now, plus how many apply. */
export async function listResetCredits(
  subAccountId: string,
  prisma: PrismaClient = getPrismaClient()
): Promise<ResetCreditsView> {
  const call = await codexCallFor(subAccountId, prisma)
  const [credits, applicable] = await Promise.all([fetchCredits(call), applicableFor(subAccountId, prisma)])
  return { credits, applicable }
}

/**
 * Spend the credit closest to lapsing, then make routing see the reset.
 *
 * The list is read fresh rather than trusted from the last poll: a credit
 * may have been spent from the Codex app, or lapsed, since. The
 * idempotency key means a retried request cannot spend two.
 */
export async function spendResetCredit(
  subAccountId: string,
  prisma: PrismaClient = getPrismaClient()
): Promise<UseResetResult> {
  const call = await codexCallFor(subAccountId, prisma)
  const credits = await fetchCredits(call)
  const [credit] = credits
  if (credit === undefined) throw new ResetCreditError(409, 'This account has no reset credit to spend')

  const redeemRequestId = randomUUID()
  const res = await fetch(`${WHAM}/rate-limit-reset-credits/consume`, {
    method: 'POST',
    headers: call.headers,
    body: JSON.stringify({ credit_id: credit.id, redeem_request_id: redeemRequestId })
  }).catch((err: unknown) => {
    logger.warn({ err, subAccountId }, '[codex-reset] consume unreachable')
    return null
  })
  if (res === null) throw new ResetCreditError(502, 'Could not reach OpenAI to spend the reset')
  const body = await readJson(res)
  // Logged in full on either outcome: the consume response is not
  // documented anywhere, and this line is what documents it.
  logger.info({ status: res.status, body, subAccountId, creditId: credit.id }, '[codex-reset] consume answered')
  if (!res.ok) {
    const status = res.status >= 500 ? 502 : 409
    throw new ResetCreditError(status, vendorMessage(body, `OpenAI refused the reset (${res.status})`))
  }

  const failed = await refreshAccountUsage([subAccountId], prisma)
  return { spentCreditId: credit.id, remaining: credits.length - 1, refreshed: failed.length === 0 }
}
