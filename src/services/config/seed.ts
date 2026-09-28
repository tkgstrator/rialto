/**
 * Database seeding: ensure the default preference profile exists.
 *
 * Providers and their models are never seeded: a provider is created when
 * the operator adds it, and its models come from the vendor, switched off.
 */

import { getPrismaClient } from '../../db/client'
import type { PrismaClient } from '../../generated/prisma/client'

// Seed the default preference profile (docs/plan/quota-aware-preference-router.md
// §6.3). Idempotent — upserts by the unique `key = 'live'` discriminator.
// `constraints` stays NULL until the user (or a migration) populates it;
// the schema layer treats missing constraints as "all defaults", so a
// null constraint blob is the safe zero-config starting state.
export async function ensurePreferenceProfile(prisma: PrismaClient = getPrismaClient()): Promise<void> {
  await prisma.routerPreferenceProfile.upsert({
    where: { key: 'live' },
    update: {},
    create: { key: 'live' }
  })
}
