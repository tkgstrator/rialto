#!/usr/bin/env bun
/**
 * Dev-only: fill an install with demo data so all five screens have
 * something to render — providers and models, routing chains and slots,
 * saved presets, scheduler weight history, subscription quota, access
 * tokens, and a month of traffic behind Activity and Overview.
 *
 * NOT wired into `prisma db seed`: running that in production must stay
 * side-effect free. Invoke explicitly:
 *
 *   bun run db:seed:demo                  # seed (replaces previous demo rows)
 *   bun run db:seed:demo -- --clean       # remove demo rows and stop
 *   bun run db:seed:demo -- --days=7 --sessions=25
 *
 * Two rules govern what it touches:
 *
 *   - Rows in tables that also hold real data carry a `demo-` id, so a
 *     re-run replaces exactly its own output and `--clean` removes it.
 *   - Live configuration that cannot carry a marker (RouterSlot, the
 *     `live` preference chain, surface routing modes, an account's quota)
 *     is written ONLY while still unset. Running this against a
 *     configured install adds traffic without re-pointing anything.
 */

import 'dotenv/config'
import { getPrismaClient } from '../src/db/client'
import { seedAccounts } from './seed-demo/accounts'
import { cleanDemoRows } from './seed-demo/demo-rows'
import { createRandom } from './seed-demo/random'
import {
  buildChains,
  seedPreferences,
  seedRouterSlots,
  seedRoutingPresets,
  seedSurfaceModes,
  seedWeightChanges
} from './seed-demo/routing'
import { resolveTargets } from './seed-demo/targets'
import { seedAccessTokens } from './seed-demo/tokens'
import { seedTraffic } from './seed-demo/traffic'

interface Options {
  clean: boolean
  days: number
  sessions: number
  seed: number
}

const numericFlag = (args: string[], name: string, fallback: number): number => {
  const raw = args.find((a) => a.startsWith(`--${name}=`))
  if (raw === undefined) return fallback
  const parsed = Number(raw.slice(name.length + 3))
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

const parseOptions = (args: string[]): Options => ({
  clean: args.includes('--clean'),
  // 30 days so Overview's month tile and its previous-period delta both
  // have data; the week and today tiles are slices of the same set.
  days: numericFlag(args, 'days', 30),
  sessions: numericFlag(args, 'sessions', 60),
  seed: numericFlag(args, 'seed', 20260907)
})

const line = (label: string, value: string | number): void => {
  console.error(`  ${label.padEnd(26)} ${value}`)
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))
  const prisma = getPrismaClient()
  const random = createRandom(options.seed)
  const now = Date.now()

  const removed = await cleanDemoRows(prisma)
  const removedTotal = Object.values(removed).reduce((a, b) => a + b, 0)

  if (options.clean) {
    console.error(`removed ${removedTotal} demo rows`)
    for (const [table, count] of Object.entries(removed)) {
      if (count > 0) line(table, count)
    }
    console.error('\nRouterSlot bindings, the `live` preference chain and surface modes are left as they are —')
    console.error('the seed only ever writes those while unset, so it has nothing of its own to take back.')
    await prisma.$disconnect()
    return
  }

  const { targets, registeredVendors } = await resolveTargets(prisma)
  if (targets.length === 0) {
    console.error('no routable models: every provider is disabled and the fallback catalog could not be written')
    process.exitCode = 1
    await prisma.$disconnect()
    return
  }

  const chains = buildChains(targets)
  const slots = await seedRouterSlots(prisma, chains)
  const preferences = await seedPreferences(prisma, targets)
  const presets = await seedRoutingPresets(prisma, targets)
  const weights = await seedWeightChanges(prisma, targets, random, now)
  const surfaces = await seedSurfaceModes(prisma)
  const accounts = await seedAccounts(prisma, random, now)
  const accessTokenIds = await seedAccessTokens(prisma, random, now)
  const traffic = await seedTraffic(prisma, chains, random, now, {
    days: options.days,
    sessions: options.sessions,
    accessTokenIds
  })

  console.error(`demo data seeded (replaced ${removedTotal} rows from a previous run)\n`)
  line('routable targets', `${targets.length}${registeredVendors ? ' (fallback catalog registered)' : ''}`)
  line('router slots', `${slots.written.length} written, ${slots.skipped.length} already configured`)
  line('preference chains', `live: ${preferences.live}, ${preferences.demoProfile}: written`)
  line('routing presets', presets)
  line('weight changes', weights)
  line('surface modes', `${surfaces.updated.length} set, ${surfaces.skipped.length} left as configured`)
  line('subscription accounts', `${accounts.createdAccounts} created`)
  line('quota rows', `${accounts.createdQuotas} quota, ${accounts.createdUsageRows} per-metric`)
  line('usage history', `${accounts.usageSnapshots} samples`)
  line('access tokens', accessTokenIds.length + 1)
  line('sessions', `${traffic.sessions} (${traffic.archived} archived)`)
  line('request logs', traffic.requestLogs)
  line('chat messages', traffic.messages)

  for (const warning of preferences.warnings) console.error(`  warning: ${warning}`)
  console.error('\nOpen http://localhost:16175/ — Overview, Routing, Providers, Activity and Settings are populated.')

  await prisma.$disconnect()
}

await main()
