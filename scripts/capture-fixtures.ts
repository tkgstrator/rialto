#!/usr/bin/env bun
/**
 * Capture live Rialto responses so provider tests can replay offline
 * without paying upstream LLM costs.
 *
 *   bun run scripts/capture-fixtures.ts            # skip existing fixtures
 *   FORCE=1 bun run scripts/capture-fixtures.ts    # overwrite existing fixtures
 *   bun run scripts/capture-fixtures.ts -- openai  # only slugs starting with "openai"
 *
 * Requires a running Rialto server. Override RIALTO_TEST_URL (default
 * http://127.0.0.1:16173) and RIALTO_TEST_APIKEY (default "test").
 * Each __tests__/providers/__fixtures__/<slug>.<hash> directory contains
 * request.json, response.json and response.body. The hash is the replay
 * lookup key; the slug is only for humans browsing the directory.
 */
import { join } from 'node:path'
import { injectApiKeys, loadSubscriptionMatrix, restoreApiKeys } from './capture-fixtures/config'
import { capture, errorMessage } from './capture-fixtures/record'
import { buildScenarioSpecs } from './capture-fixtures/scenarios'
import { buildSmokeSpecs, buildSubscriptionSpecs } from './capture-fixtures/smokes'
import type { RequestSpec } from './capture-fixtures/types'

const base = process.env.RIALTO_TEST_URL === undefined ? 'http://127.0.0.1:16173' : process.env.RIALTO_TEST_URL
const apiKey = process.env.RIALTO_TEST_APIKEY === undefined ? 'test' : process.env.RIALTO_TEST_APIKEY
const connection = { configUrl: `${base}/api/config`, apiKey }
const options = {
  fixturesDir: join(import.meta.dir, '..', '__tests__', 'providers', '__fixtures__'),
  apiKey,
  force: Boolean(process.env.FORCE)
}
const filter = process.argv.slice(2).filter((a) => !a.startsWith('-'))[0]
const messagesUrl = `${base}/v1/messages`

// Keep matrix discovery ahead of injection, as in the original capture path.
const matrix = await loadSubscriptionMatrix(connection)
const specs: RequestSpec[] = [
  { label: 'GET /api/config', slug: 'api-config', method: 'GET', url: connection.configUrl },
  ...buildSmokeSpecs(messagesUrl),
  ...buildSubscriptionSpecs(messagesUrl, matrix),
  ...buildScenarioSpecs(messagesUrl)
]
const matching = filter ? specs.filter((spec) => spec.slug.startsWith(filter)) : specs
if (filter) console.log(`filter: ${filter} (${matching.length}/${specs.length} specs)`)

const injection = await injectApiKeys(connection).catch((error: unknown) => {
  console.error(`inject failed: ${errorMessage(error)}`)
  process.exit(1)
})
const counts = { recorded: 0, skipped: 0, failed: 0 }
try {
  for (const spec of matching) {
    const result = await capture(spec, options)
    counts[result]++
  }
} finally {
  if (injection) {
    try {
      await restoreApiKeys(connection, injection)
    } catch (error) {
      console.error(
        `restore failed: ${errorMessage(error)} — re-run with NO_INJECT=1 once the keys are cleared manually`
      )
    }
  }
}
console.log(`\nDone: ${counts.recorded} recorded, ${counts.skipped} skipped, ${counts.failed} failed`)
if (counts.failed > 0) process.exit(1)
