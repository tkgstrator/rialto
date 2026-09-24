/**
 * Write the Mock Diff Viewer's workspace config from mocks/mocks.json.
 *
 *   bun run mocks:config
 *
 * mocks.json stays the one registry of screens: the ui-mock-diff scripts
 * read it, and this turns it into the viewer's `mock-diff.yaml`, so adding
 * a mock is still one entry in one file. `__tests__/lib/mock-diff-config.test.ts`
 * fails when the committed yaml no longer matches mocks.json.
 *
 * The viewer runs as the `mock-diff` sidecar (.devcontainer/compose.yaml),
 * which shares the app container's network, so `localhost` below is the
 * same machine for the viewer, the dev server and the browser behind the
 * forwarded port. Its workspace is the repo's mocks/ and node_modules/, so
 * paths are relative to the repo root.
 *
 * Each screen is one device at the registry's viewport and scale, in both
 * themes. The mock is the only candidate; the implementation, when the
 * screen has a route, is the page on the running dev server.
 *
 * `mock-diff.adopted.yaml` records which candidate each screen chose. The
 * viewer writes it; this only seeds it, once, choosing the mock for every
 * screen — a mock under mocks/ is the approved design by definition.
 */

import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { stringify } from 'yaml'
import { z } from 'zod'

const ROOT = resolve(import.meta.dir, '..')
const REGISTRY = join(ROOT, 'mocks/mocks.json')
export const CONFIG_PATH = join(ROOT, 'mocks/mock-diff.yaml')
const ADOPTED_PATH = join(ROOT, 'mocks/mock-diff.adopted.yaml')

const ScreenSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  mock: z.string().nonempty(),
  route: z.string().nonempty().nullable(),
  group: z.string().nonempty().optional()
})

export const RegistrySchema = z.object({
  baseUrl: z.url(),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  deviceScaleFactor: z.number().positive(),
  themes: z.array(z.enum(['light', 'dark'])).nonempty(),
  screens: z.array(ScreenSchema).nonempty()
})

type Registry = z.infer<typeof RegistrySchema>
type Screen = z.infer<typeof ScreenSchema>

// A mock state such as `routing.html?edit&add` is chosen by its query
// string, which an `html` source cannot carry: the viewer encodes the path
// segment by segment, `?` included. Those are loaded as a URL instead,
// through the same /mock-diff/ relay the browser uses, so the live preview
// opens in the browser as well as in the viewer's own capture.
const mockSource = (screen: Screen, baseUrl: string) =>
  screen.mock.includes('?')
    ? { type: 'url', url: `${baseUrl}/mock-diff/api/workspace/mocks/${screen.mock}` }
    : { type: 'html', path: `mocks/${screen.mock}` }

export function buildMockDiffConfig(registry: Registry) {
  return {
    screens: registry.screens.map((screen) => ({
      id: screen.name,
      ...(screen.group === undefined ? {} : { category: screen.group }),
      devices: [
        {
          id: 'desktop',
          viewport: { ...registry.viewport, deviceScaleFactor: registry.deviceScaleFactor },
          // A copy per screen: a shared array would come out as a YAML alias.
          colorSchemes: [...registry.themes],
          versions: { mock: mockSource(screen, registry.baseUrl) },
          ...(screen.route === null ? {} : { actual: { type: 'url', url: `${registry.baseUrl}${screen.route}` } })
        }
      ]
    }))
  }
}

const HEADER = '# Generated from mocks/mocks.json by `bun run mocks:config`. Edit that, then regenerate.\n'

export function renderMockDiffConfig(registry: Registry): string {
  return `${HEADER}${stringify(buildMockDiffConfig(registry))}`
}

export async function readRegistry(): Promise<Registry> {
  return RegistrySchema.parse(JSON.parse(await readFile(REGISTRY, 'utf8')))
}

if (import.meta.main) {
  const registry = await readRegistry()
  await writeFile(CONFIG_PATH, renderMockDiffConfig(registry))
  console.log(`[mocks:config] mocks/mock-diff.yaml — ${registry.screens.length} screens`)
  if (!existsSync(ADOPTED_PATH)) {
    const adopted = Object.fromEntries(registry.screens.map((screen) => [screen.name, 'mock']))
    await writeFile(ADOPTED_PATH, stringify({ adopted }))
    console.log('[mocks:config] mocks/mock-diff.adopted.yaml — seeded, the mock chosen for every screen')
  }
}
