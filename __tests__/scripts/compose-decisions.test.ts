import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'

// The optional Jeff CPU sidecar must never change an ordinary
// `docker compose up`. These pin that, by reading compose.yaml and the
// Dockerfile as text. They start nothing: no Docker, no network.
const ROOT = join(import.meta.dir, '..', '..')
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')

// Lists default to empty rather than being optional: compose.yaml omits a key
// when it has nothing to say, and "no ports" is an empty list, not a missing one.
const Text = z.string().nonempty()
const ComposeSchema = z.object({
  services: z.record(
    Text,
    z.object({
      profiles: z.array(Text).default([]),
      ports: z.array(z.unknown()).default([]),
      depends_on: z.union([z.array(Text), z.record(Text, z.unknown())]).default([]),
      // Values may legitimately be empty (JEFF_URL defaults to ''), so Text is wrong here.
      environment: z.record(Text, z.union([z.string().max(200), z.number(), z.boolean(), z.null()])).default({}),
      volumes: z.array(Text).default([]),
      build: z.object({ context: Text }).nullable().default(null),
      healthcheck: z
        .object({ test: z.array(Text), start_period: Text.nullable().default(null) })
        .nullable()
        .default(null)
    })
  ),
  volumes: z.record(Text, z.unknown())
})

const parsed = ComposeSchema.safeParse(parse(read('compose.yaml')))
if (!parsed.success) throw new Error(`compose.yaml no longer matches the expected shape: ${parsed.error.message}`)
const { services, volumes } = parsed.data
const jeff = services.jeff
const rialto = services.rialto
if (jeff === undefined || rialto === undefined) throw new Error('compose.yaml must define rialto and jeff')

describe('Jeff CPU sidecar in compose.yaml', () => {
  test('is opt-in through the decisions profile only', () => {
    expect(jeff.profiles).toEqual(['decisions'])
    // Every other service starts by default; only the sidecar is gated.
    for (const [name, service] of Object.entries(services)) {
      if (name !== 'jeff') expect(service.profiles).toEqual([])
    }
  })

  test('is internal: no published ports', () => {
    expect(jeff.ports).toEqual([])
  })

  test('rialto does not depend on it, so a normal start is unchanged', () => {
    const dependsOn = rialto.depends_on
    const names = Array.isArray(dependsOn) ? dependsOn : Object.keys(dependsOn)
    expect(names).not.toContain('jeff')
    expect(names.sort()).toEqual(['postgres', 'redis'])
  })

  test('passes JEFF_URL empty by default, which the app reads as not configured', () => {
    // Compose's own default syntax: an unset JEFF_URL becomes an empty string.
    expect(rialto.environment.JEFF_URL).toBe(['$', '{JEFF_URL:-}'].join(''))
    expect(rialto.environment.JEFF_SHADOW_ENABLED).toBe(['$', '{JEFF_SHADOW_ENABLED:-false}'].join(''))
  })

  test('keeps the checkpoint on a named volume and does not enable Jeff authentication', () => {
    expect(jeff.volumes).toEqual(['jeff_models:/models'])
    expect(Object.keys(volumes)).toContain('jeff_models')
    expect(Object.keys(jeff.environment)).not.toContain('JEFF_API_KEY')
  })

  test('is healthy only once Jeff reports ready, with time for the first download', () => {
    const health = jeff.healthcheck
    if (health === null) throw new Error('jeff has no healthcheck')
    expect(health.test.join(' ')).toContain('/health')
    expect(health.test.join(' ')).toContain("'ready'")
    expect(health.start_period).toBe('600s')
  })
})

describe('Jeff Dockerfile', () => {
  const dockerfile = read('docker/jeff/Dockerfile')
  const entrypoint = read('docker/jeff/entrypoint.sh')

  test('builds the pinned upstream v1.1 commit, not a moving ref', () => {
    expect(dockerfile).toContain('ARG JEFF_REF=f0397f3785d93f73a01411d785d2ed026f53181d')
    expect(dockerfile).not.toMatch(/JEFF_REF=(main|master|latest)/)
  })

  test('installs the CPU dependencies Jeff documents, with no CUDA or MLX extra', () => {
    expect(dockerfile).toContain('uv sync --no-default-groups --frozen')
    expect(dockerfile).not.toContain('--extra')
  })

  test('sets only variables Jeff reads, binding all interfaces for the Compose network', () => {
    for (const line of ['JEFF_HOST=0.0.0.0', 'PORT=8765', 'JEFF_BACKEND=pytorch', 'JEFF_DEVICE=cpu']) {
      expect(dockerfile).toContain(line)
    }
    expect(dockerfile).toContain('JEFF_CHECKPOINT=/models/jeff-0.8b')
    expect(dockerfile).not.toContain('JEFF_API_KEY')
  })

  test('serves only after the download finished, using the documented commands', () => {
    expect(entrypoint).toContain('hf download "$REPO" --local-dir "$CHECKPOINT"')
    expect(entrypoint.indexOf('touch "$MARKER"')).toBeGreaterThan(entrypoint.indexOf('hf download'))
    expect(entrypoint).toContain('exec uv run --no-default-groups jeff-serve')
  })
})
