/**
 * Preload for `bun test`. Loaded via --preload before any test or
 * source module imports, so by the time anything reads HOME or
 * DATABASE_URL the values point at safe targets.
 *
 * Two pollutants this script defangs:
 *  1. CONFIG_FILE / HOME_DIR are derived from os.homedir() at module
 *     load time (src/shared/constants.ts). Tests that write or unlink
 *     CONFIG_FILE (services/config/envelope.test.ts, db/migrateFromJson.test.ts)
 *     would otherwise clobber the developer's real
 *     ~/.rialto/config.json.
 *  2. DB-backed tests TRUNCATE Provider/Model/RouterPreferenceProfile/... in
 *     whatever DATABASE_URL points to. Routing them through
 *     TEST_DATABASE_URL keeps the dev DB intact; if TEST_DATABASE_URL
 *     is unset we drop DATABASE_URL entirely so HAS_DB evaluates false
 *     and DB suites skip cleanly rather than truncating the dev DB.
 */

import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// RIALTO_HOME_DIR is honoured by src/shared/constants.ts in place of
// os.homedir() + '/.rialto'. os.homedir() reads /etc/passwd (not $HOME)
// under bun, so overriding $HOME at preload time would be too late —
// the override lives behind its own env var instead. The pre-rename
// CCR_HOME_DIR still works (see shared/constants.test.ts); it is not
// set here so the suite exercises the current name.
const TMP_HOME = join(tmpdir(), `rialto-test-home-${process.pid}`, '.rialto')
mkdirSync(TMP_HOME, { recursive: true })
process.env.RIALTO_HOME_DIR = TMP_HOME

const devUrl = process.env.DATABASE_URL
const testUrl = process.env.TEST_DATABASE_URL

if (testUrl && testUrl.length > 0) {
  if (testUrl === devUrl) {
    throw new Error('TEST_DATABASE_URL must differ from DATABASE_URL — refusing to run tests against the dev DB.')
  }
  // Defensive: require the database name to contain "test" so a typo
  // in TEST_DATABASE_URL can't silently nuke a real DB.
  const dbName = (testUrl.split('?', 1)[0] ?? '').split('/').pop() ?? ''
  if (!/test/i.test(dbName)) {
    throw new Error(
      `TEST_DATABASE_URL database name "${dbName}" must contain "test" — refusing to run tests against a non-test DB.`
    )
  }
  process.env.DATABASE_URL = testUrl
} else {
  // No test DB configured: drop DATABASE_URL so HAS_DB evaluates false
  // and DB-backed suites skip instead of writing to the dev database.
  delete process.env.DATABASE_URL
}
