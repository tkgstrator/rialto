/**
 * Authorized apps: apps whose installs may register themselves with Apple
 * App Attest and be handed a token each.
 *
 * The rows here are apps, not installs. An app's installs are counted on
 * its row and listed, searchably and a page at a time, on its own page —
 * there can be thousands, and they never appear on the Tokens list.
 */

import { getPrismaClient } from '../db/client'
import dayjs from '../lib/dayjs'
import { invalidateTokenCache } from './access-token-service'
import { spendByToken } from './access-token-spend'

export interface AuthorizedAppRow {
  id: string
  name: string
  /** `<Team ID>.<bundle id>`. */
  appleAppId: string
  allowDevelopment: boolean
  enabled: boolean
  /** The plan a new install's token is put on. */
  plan: { id: string; name: string }
  deviceCount: number
  /** Installs whose token was used in the last 7 days. */
  activeDevices: number
  /** Completion requests counted against caps today (UTC). */
  requestsToday: number
  /** USD over the spend window, or null when none of it could be priced. */
  costUsd: number | null
  createdAt: string
  updatedAt: string
}

export interface AppInput {
  name: string
  appleAppId: string
  planId: string
  allowDevelopment: boolean
}

export type AppRefusal = 'invalid' | 'duplicate' | 'unknown-plan' | 'not-found'

export type AppResult = { ok: true; app: AuthorizedAppRow } | { ok: false; reason: AppRefusal; message: string }

// Team IDs are ten uppercase alphanumerics; the bundle id after the dot is
// reverse-DNS. Checked so a typo is refused here rather than turning into
// "every registration fails" with nothing to say why.
const APPLE_APP_ID = /^[A-Z0-9]{10}\.[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/

const ACTIVE_WINDOW_DAYS = 7
const DEVICE_PAGE_MAX = 200

const todayUtc = (): string => dayjs().toDate().toISOString().slice(0, 10)

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2002'

interface AppRecord {
  id: string
  name: string
  appleAppId: string
  allowDevelopment: boolean
  enabled: boolean
  createdAt: Date
  updatedAt: Date
  plan: { id: string; name: string }
}

/** Counts and spend for a set of apps, computed in a handful of queries rather than per row. */
async function withStats(apps: AppRecord[]): Promise<AuthorizedAppRow[]> {
  if (apps.length === 0) return []
  const prisma = getPrismaClient()
  const ids = apps.map((app) => app.id)
  const since = dayjs().subtract(ACTIVE_WINDOW_DAYS, 'day').toDate()
  const [devices, usage, spend] = await Promise.all([
    prisma.appDevice.findMany({
      where: { authorizedAppId: { in: ids } },
      select: { authorizedAppId: true, accessTokenId: true, accessToken: { select: { lastUsedAt: true } } }
    }),
    prisma.accessTokenDailyUsage.findMany({
      where: { day: todayUtc(), accessToken: { device: { is: { authorizedAppId: { in: ids } } } } },
      select: { requests: true, accessToken: { select: { device: { select: { authorizedAppId: true } } } } }
    }),
    spendByToken()
  ])
  return apps.map((app) => {
    const mine = devices.filter((device) => device.authorizedAppId === app.id)
    const costs = mine
      .map((device) => spend.get(device.accessTokenId))
      .map((totals) => (totals === undefined ? null : totals.costUsd))
      .filter((cost): cost is number => cost !== null)
    return {
      id: app.id,
      name: app.name,
      appleAppId: app.appleAppId,
      allowDevelopment: app.allowDevelopment,
      enabled: app.enabled,
      plan: app.plan,
      deviceCount: mine.length,
      activeDevices: mine.filter(
        (device) => device.accessToken.lastUsedAt !== null && device.accessToken.lastUsedAt >= since
      ).length,
      requestsToday: usage
        .filter((row) => row.accessToken.device !== null && row.accessToken.device.authorizedAppId === app.id)
        .reduce((sum, row) => sum + row.requests, 0),
      costUsd: costs.length === 0 ? null : costs.reduce((sum, cost) => sum + cost, 0),
      createdAt: app.createdAt.toISOString(),
      updatedAt: app.updatedAt.toISOString()
    }
  })
}

const APP_INCLUDE = { plan: { select: { id: true, name: true } } } as const

export async function listApps(): Promise<AuthorizedAppRow[]> {
  const apps = await getPrismaClient().authorizedApp.findMany({ orderBy: { createdAt: 'asc' }, include: APP_INCLUDE })
  return withStats(apps)
}

export async function getApp(id: string): Promise<AuthorizedAppRow | null> {
  const app = await getPrismaClient()
    .authorizedApp.findUnique({ where: { id }, include: APP_INCLUDE })
    .catch(() => null)
  if (app === null) return null
  const [row] = await withStats([app])
  return row
}

function appProblem(input: Pick<AppInput, 'name' | 'appleAppId'>): string | null {
  if (input.name.trim().length === 0) return 'An app needs a name.'
  if (!APPLE_APP_ID.test(input.appleAppId)) {
    return 'The App ID is the ten-character Team ID and the bundle ID joined by a dot, like ABCDE12345.com.example.app.'
  }
  return null
}

async function planExists(planId: string): Promise<boolean> {
  const plan = await getPrismaClient()
    .plan.findUnique({ where: { id: planId }, select: { id: true } })
    .catch(() => null)
  return plan !== null
}

export async function createApp(input: AppInput): Promise<AppResult> {
  const problem = appProblem(input)
  if (problem !== null) return { ok: false, reason: 'invalid', message: problem }
  if (!(await planExists(input.planId))) return { ok: false, reason: 'unknown-plan', message: 'No such plan.' }
  try {
    const app = await getPrismaClient().authorizedApp.create({
      data: {
        name: input.name.trim(),
        appleAppId: input.appleAppId,
        planId: input.planId,
        allowDevelopment: input.allowDevelopment
      },
      include: APP_INCLUDE
    })
    const [row] = await withStats([app])
    return { ok: true, app: row }
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: 'duplicate', message: 'That App ID is already authorized.' }
    throw err
  }
}

export interface AppPatch {
  name?: string
  planId?: string
  allowDevelopment?: boolean
  enabled?: boolean
}

/**
 * Edit an app. The App ID is not editable: it is what the app's installs
 * attested as, so a different one is a different app.
 */
export async function updateApp(id: string, patch: AppPatch): Promise<AppResult> {
  const prisma = getPrismaClient()
  const current = await prisma.authorizedApp.findUnique({ where: { id } }).catch(() => null)
  if (current === null) return { ok: false, reason: 'not-found', message: 'No such app.' }
  if (patch.name !== undefined && patch.name.trim().length === 0) {
    return { ok: false, reason: 'invalid', message: 'An app needs a name.' }
  }
  if (patch.planId !== undefined && !(await planExists(patch.planId))) {
    return { ok: false, reason: 'unknown-plan', message: 'No such plan.' }
  }
  const app = await prisma.authorizedApp.update({
    where: { id },
    data: {
      ...(patch.name === undefined ? {} : { name: patch.name.trim() }),
      ...(patch.planId === undefined ? {} : { planId: patch.planId }),
      ...(patch.allowDevelopment === undefined ? {} : { allowDevelopment: patch.allowDevelopment }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled })
    },
    include: APP_INCLUDE
  })
  // Switching an app off has to stop its tokens now, not when the
  // resolver cache happens to expire.
  if (patch.enabled !== undefined) invalidateTokenCache()
  const [row] = await withStats([app])
  return { ok: true, app: row }
}

export interface DeviceRow {
  /** The access token this install presents; its own page is where it is revoked. */
  tokenId: string
  /** First characters of the App Attest key id — enough to find one, not to forge one. */
  keyPrefix: string
  environment: string
  plan: { id: string; name: string } | null
  requestsToday: number
  dailyRequestLimit: number | null
  costUsd: number | null
  lastUsedAt: string | null
  registeredAt: string
  revokedAt: string | null
}

export interface DeviceQuery {
  /** Matches the start of the key id. */
  query?: string
  offset?: number
  limit?: number
}

/** One page of an app's installs, most recently used first. */
export async function listDevices(
  appId: string,
  { query, offset = 0, limit = 50 }: DeviceQuery = {}
): Promise<{ total: number; devices: DeviceRow[] }> {
  const prisma = getPrismaClient()
  const where = {
    authorizedAppId: appId,
    ...(query === undefined || query.length === 0 ? {} : { keyId: { startsWith: query } })
  }
  const take = Math.min(Math.max(1, limit), DEVICE_PAGE_MAX)
  const [total, rows, spend] = await Promise.all([
    prisma.appDevice.count({ where }),
    prisma.appDevice.findMany({
      where,
      orderBy: [{ accessToken: { lastUsedAt: { sort: 'desc', nulls: 'last' } } }, { createdAt: 'desc' }],
      skip: Math.max(0, offset),
      take,
      include: {
        accessToken: {
          select: {
            id: true,
            lastUsedAt: true,
            revokedAt: true,
            plan: { select: { id: true, name: true, dailyRequestLimit: true } },
            dailyUsage: { where: { day: todayUtc() }, select: { requests: true } }
          }
        }
      }
    }),
    spendByToken()
  ])
  return {
    total,
    devices: rows.map((row) => {
      const token = row.accessToken
      const totals = spend.get(token.id)
      return {
        tokenId: token.id,
        keyPrefix: row.keyId.slice(0, 8),
        environment: row.environment,
        plan: token.plan === null ? null : { id: token.plan.id, name: token.plan.name },
        requestsToday: token.dailyUsage.reduce((sum, usage) => sum + usage.requests, 0),
        dailyRequestLimit: token.plan === null ? null : token.plan.dailyRequestLimit,
        costUsd: totals === undefined ? null : totals.costUsd,
        lastUsedAt: token.lastUsedAt === null ? null : token.lastUsedAt.toISOString(),
        registeredAt: row.createdAt.toISOString(),
        revokedAt: token.revokedAt === null ? null : token.revokedAt.toISOString()
      }
    })
  }
}
