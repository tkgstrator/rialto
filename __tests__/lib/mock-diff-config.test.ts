/**
 * The Mock Diff Viewer's config is generated from mocks/mocks.json and
 * committed, because the viewer reads it from the workspace as it sits.
 * A mock added to mocks.json without `bun run mocks:config` would simply
 * be missing from the viewer, with nothing saying why — so the committed
 * file is held to what the registry generates.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  buildMockDiffConfig,
  CONFIG_PATH,
  RegistrySchema,
  readRegistry,
  renderMockDiffConfig
} from '../../scripts/build-mock-diff-config'

describe('mock-diff config', () => {
  test('the committed mocks/mock-diff.yaml matches mocks.json — run `bun run mocks:config`', async () => {
    const registry = await readRegistry()
    expect(readFileSync(CONFIG_PATH, 'utf8')).toBe(renderMockDiffConfig(registry))
  })

  test('a mock state chosen by its query string loads through the relay, a plain mock as a file', () => {
    const registry = RegistrySchema.parse({
      baseUrl: 'http://localhost:16175',
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      themes: ['light', 'dark'],
      screens: [
        { name: 'routing', mock: 'routing.html', route: '/routing', group: 'Routing' },
        { name: 'routing-edit', mock: 'routing.html?edit', route: null }
      ]
    })
    const [plain, state] = buildMockDiffConfig(registry).screens
    expect(plain.devices[0].versions.mock).toEqual({ type: 'html', path: 'mocks/routing.html' })
    expect(plain.devices[0]).toMatchObject({ actual: { type: 'url', url: 'http://localhost:16175/routing' } })
    expect(state.devices[0].versions.mock).toEqual({
      type: 'url',
      url: 'http://localhost:16175/mock-diff/api/workspace/mocks/routing.html?edit'
    })
    // Not implemented yet: nothing to compare the mock against.
    expect(state.devices[0]).not.toHaveProperty('actual')
    expect(state).not.toHaveProperty('category')
  })
})
