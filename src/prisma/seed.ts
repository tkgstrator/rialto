/**
 * Prisma seed entry — wired via package.json's `"prisma": { "seed": ... }`.
 * Runs automatically on `prisma migrate dev` / `migrate reset` / `db seed`,
 * and explicitly from entrypoint.sh after `prisma migrate deploy` in
 * production. All operations below are idempotent so re-runs are no-ops.
 *
 * Empty-first Providers: this seed no longer creates placeholder
 * Provider rows. The Providers page reads the static catalog
 * (VENDOR_DEFAULTS + SUBSCRIPTION_PRESETS + OFFICIAL_VENDOR_PRICES) via
 * /api/catalog and only writes to the Provider / Model tables when the
 * user enables a vendor. The default preference profile ships
 * pre-created so every surface has a chain row to point at, empty
 * until the operator fills it in.
 */

import { logger } from '../logger'
import { ensurePreferenceProfile } from '../services/config/seed'

async function main(): Promise<void> {
  await ensurePreferenceProfile()
  logger.info('prisma seed complete')
}

await main()
