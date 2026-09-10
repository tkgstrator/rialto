/**
 * Ownership marker for demo rows.
 *
 * Every row this seed writes into a table that also holds real data gets
 * an explicit id prefixed with `demo-`, so a re-run (and `--clean`) can
 * delete exactly what it wrote and nothing else. Prisma's `@default(cuid())`
 * only applies when the id is omitted, so supplying one is free.
 *
 * Configuration rows that are singletons per key — the `live` preference
 * profile, InboundSurfaceConfig — cannot carry a marker. Those are
 * written only when they are still unset, and are left alone by
 * `--clean`; see seed-demo/routing.ts.
 */

import type { PrismaClient } from '../../src/generated/prisma/client'

export const DEMO_PREFIX = 'demo-'

/** The demo-owned preference profile, offered next to `live` in Routing. */
export const DEMO_PROFILE_KEY = 'cost-first'

export const demoId = (kind: string, n: number): string => `${DEMO_PREFIX}${kind}-${String(n).padStart(5, '0')}`

/** A session id shaped like the real thing (a client-supplied uuid), still marked. */
export const demoSessionId = (uuidish: string): string => `${DEMO_PREFIX}${uuidish}`

const startsWithDemo = { startsWith: DEMO_PREFIX }

export interface CleanCounts {
  message: number
  requestLog: number
  session: number
  routingWeightChange: number
  accessToken: number
  usageSnapshot: number
  subAccount: number
  preferenceProfile: number
}

/**
 * Remove every demo-owned row. Safe to run against a database with real
 * traffic in it: the id prefix is the only thing it matches on.
 */
export async function cleanDemoRows(prisma: PrismaClient): Promise<CleanCounts> {
  // RequestLog's `session` relation declares no onDelete, so Prisma
  // restricts the parent delete — logs have to go before their sessions.
  const message = await prisma.message.deleteMany({ where: { id: startsWithDemo } })
  const requestLog = await prisma.requestLog.deleteMany({ where: { id: startsWithDemo } })
  const session = await prisma.session.deleteMany({ where: { id: startsWithDemo } })
  const routingWeightChange = await prisma.routingWeightChange.deleteMany({ where: { id: startsWithDemo } })
  const accessToken = await prisma.accessToken.deleteMany({ where: { id: startsWithDemo } })
  const usageSnapshot = await prisma.usageSnapshot.deleteMany({ where: { id: startsWithDemo } })
  // Usage / quota children cascade from the account.
  const subAccount = await prisma.subAccount.deleteMany({ where: { id: startsWithDemo } })
  // The demo profile is keyed, not id-prefixed: its key is reserved for
  // the seed, and its entries cascade.
  const preferenceProfile = await prisma.routerPreferenceProfile.deleteMany({ where: { key: DEMO_PROFILE_KEY } })

  return {
    message: message.count,
    requestLog: requestLog.count,
    session: session.count,
    routingWeightChange: routingWeightChange.count,
    accessToken: accessToken.count,
    usageSnapshot: usageSnapshot.count,
    subAccount: subAccount.count,
    preferenceProfile: preferenceProfile.count
  }
}
