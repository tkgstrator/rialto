/**
 * Shared helpers for DB-backed tests. Tests opt out cleanly when there
 * is no DATABASE_URL or when CI sets RIALTO_SKIP_DB_TESTS=1 — mirroring
 * the RIALTO_SKIP_LIVE_TESTS gate that the provider integration tests use.
 */

import { __resetPrismaClientForTests, getPrismaClient } from '../../src/db/client'

export const HAS_DB = Boolean(process.env.DATABASE_URL) && process.env.RIALTO_SKIP_DB_TESTS !== '1'

/**
 * Wipe every mutable table so each test starts from a known empty
 * state. Cheaper than transactional rollback and works with Prisma's
 * connection model. RESTART IDENTITY + CASCADE resets the FK chain and
 * any sequences (we use cuids but this is still the cleanest hammer).
 *
 * Listed table-by-table on purpose: missing one (SubAccount used to be
 * absent) leaks state across tests and made suites order-dependent.
 */
export async function resetDbTables(): Promise<void> {
  if (!HAS_DB) return
  const prisma = getPrismaClient()
  await prisma.$executeRawUnsafe(
    'TRUNCATE "RequestLog","Session","UsageSnapshot","RoutingWeightChange","RouterPreferenceProfile","InboundSurfaceConfig","SubAccount","Model","Provider" RESTART IDENTITY CASCADE'
  )
}

export function teardownPrisma(): Promise<void> {
  __resetPrismaClientForTests()
  return Promise.resolve()
}
