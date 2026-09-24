/**
 * Re-run the chain → scenario routes conversion for one profile.
 *
 *   bun run scripts/rebackfill-tier-routes.ts --profile <key>
 *   bun run db:seed
 *
 * For a rollback of the release that introduced tier routes: while the
 * previous image runs, Routing edits land only in the old chain, and a
 * profile already marked converted is never converted again. Before
 * rolling forward, this deletes the profile's tier routes and clears its
 * mark, so the next seed converts the edited chain. Aliases are left as
 * they are — the backfill never overwrites one.
 *
 * Remove together with the backfill once the old chain is dropped.
 */

import { getPrismaClient } from '../src/db/client'

const flag = process.argv.indexOf('--profile')
const key = flag >= 0 ? process.argv[flag + 1] : undefined
if (key === undefined || key.length === 0) {
  console.error('usage: bun run scripts/rebackfill-tier-routes.ts --profile <key>')
  process.exit(2)
}

const prisma = getPrismaClient()
const profile = await prisma.routerPreferenceProfile.findUnique({ where: { key }, select: { id: true } })
if (profile === null) {
  console.error(`no profile named "${key}"`)
  process.exit(1)
}
const { count } = await prisma.tierRoute.deleteMany({ where: { profileId: profile.id } })
await prisma.routerPreferenceProfile.update({ where: { id: profile.id }, data: { chainBackfilledAt: null } })
console.error(`"${key}": removed ${count} tier route(s) and cleared the mark; run \`bun run db:seed\` to convert it again`)
await prisma.$disconnect()
