import { describe, expect, test } from 'bun:test'
import { preferredProviderOrder, resolvePreferredProvider } from '../../src/services/model-provider-preference'

describe('unambiguous model provider selection', () => {
  test('no eligible provider is unavailable', async () => {
    expect(await preferredProviderOrder('same', [])).toEqual({ status: 'unavailable' })
    expect(await resolvePreferredProvider('same', [])).toEqual({ status: 'unavailable' })
  })

  test('one eligible provider does not need stored preferences', async () => {
    expect(await preferredProviderOrder('same', ['alpha'])).toEqual({ status: 'preferred', providers: ['alpha'] })
    expect(await resolvePreferredProvider('same', ['alpha'])).toEqual({ status: 'preferred', provider: 'alpha' })
  })

  test('repeated candidates still name one provider', async () => {
    expect(await preferredProviderOrder('same', ['alpha', 'alpha'])).toEqual({
      status: 'preferred',
      providers: ['alpha']
    })
  })

  test('plan restrictions can leave a single eligible provider', async () => {
    expect(await preferredProviderOrder('same', ['alpha', 'beta'], ['beta'])).toEqual({
      status: 'preferred',
      providers: ['beta']
    })
    expect(await resolvePreferredProvider('same', ['alpha', 'beta'], ['beta'])).toEqual({
      status: 'preferred',
      provider: 'beta'
    })
  })

  test('a plan with no eligible provider is unavailable', async () => {
    expect(await preferredProviderOrder('same', ['alpha'], ['beta'])).toEqual({ status: 'unavailable' })
    expect(await resolvePreferredProvider('same', ['alpha'], ['beta'])).toEqual({ status: 'unavailable' })
  })

  test('without Postgres, only genuine collisions require the database', () => {
    // A fresh process prevents a Prisma singleton created by another suite
    // from hiding eager client acquisition, even in DB-enabled test runs.
    const child = Bun.spawnSync({
      cmd: [
        'bun',
        '-e',
        `delete process.env.DATABASE_URL
         const { preferredProviderOrder, resolvePreferredProvider } = await import('./src/services/model-provider-preference')
         const results = [
           await preferredProviderOrder('same', []),
           await preferredProviderOrder('same', ['alpha']),
           await preferredProviderOrder('same', ['alpha', 'beta'], ['beta']),
           await resolvePreferredProvider('same', ['alpha']),
           await preferredProviderOrder('same', ['alpha', 'beta']).then(
             () => 'unexpected resolution',
             (error) => error.message.startsWith('DATABASE_URL is not set.') ? 'database required' : error.message
           )
         ]
         console.log(JSON.stringify(results))`
      ],
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: '', TEST_DATABASE_URL: '' },
      stdout: 'pipe',
      stderr: 'pipe'
    })
    expect(child.exitCode).toBe(0)
    expect(JSON.parse(child.stdout.toString())).toEqual([
      { status: 'unavailable' },
      { status: 'preferred', providers: ['alpha'] },
      { status: 'preferred', providers: ['beta'] },
      { status: 'preferred', provider: 'alpha' },
      'database required'
    ])
  })
})
