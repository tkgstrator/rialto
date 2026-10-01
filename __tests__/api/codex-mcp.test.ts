import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ServerNotification } from '@modelcontextprotocol/sdk/types.js'
import { Hono } from 'hono'
import { outputText } from '../../src/api/codex-mcp/ask'
import { __clearFilesForTests, getFile, putFile, sniffImageType } from '../../src/api/codex-mcp/files'
import { codexMcpRoute } from '../../src/api/codex-mcp/route'
import { __clearThreadsForTests, readThread, saveThread } from '../../src/api/codex-mcp/threads'
import { withHeartbeat } from '../../src/api/codex-mcp/tool-context'
import { getPrismaClient } from '../../src/db/client'
import dayjs from '../../src/lib/dayjs'
import { resetLlmsContext } from '../../src/llms/context'
import { invalidateTokenCache, issueAccessToken } from '../../src/services/access-token-service'
import { clearAccountExhaustion } from '../../src/services/failover-state'
import { invalidateSurfaceCache } from '../../src/services/inbound-surface-service'
import { setModelProviderPriorities } from '../../src/services/model-provider-preference'
import { encryptionKey, encryptString } from '../../src/services/subscription-account-sync/crypto'
import { HAS_DB, resetDbTables, teardownPrisma } from '../db/helpers'

// ─── Pure pieces (no database) ─────────────────────────────────────────

describe('codex-mcp stores', () => {
  beforeEach(() => {
    __clearFilesForTests()
    __clearThreadsForTests()
  })

  test('a stored file is found by its key and nothing else', () => {
    const key = putFile(new Uint8Array([1, 2, 3]), 'image/png')
    expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(getFile(key)?.mimeType).toBe('image/png')
    // The last base64url character of 16 bytes is one of A, Q, g, w, so a
    // fixed replacement would equal the key a quarter of the time.
    expect(getFile(`${key.slice(0, 21)}${key.endsWith('A') ? 'Q' : 'A'}`)).toBeNull()
    expect(getFile('../../etc/passwd')).toBeNull()
  })

  test('image type is read from the bytes', () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUg==', 'base64')
    expect(sniffImageType(png)).toBe('image/png')
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
  })

  test('a thread is readable only by the token that started it', () => {
    saveThread('t1', 'owner', 'be terse', [{ role: 'user', text: 'hi' }])
    expect(readThread('t1', 'owner')?.instructions).toBe('be terse')
    expect(readThread('t1', 'someone-else')).toBeNull()
    expect(readThread('missing', 'owner')).toBeNull()
  })

  test('a slow call sends progress when asked for it, a log line otherwise, and stops when done', async () => {
    const sent: ServerNotification[] = []
    const extraWith = (meta: { progressToken: string } | undefined) => ({
      ...(meta === undefined ? {} : { _meta: meta }),
      sendNotification: async (n: ServerNotification) => {
        sent.push(n)
      }
    })
    expect(
      await withHeartbeat(extraWith({ progressToken: 'p1' }), 'thinking', () => Bun.sleep(35).then(() => 'x'), 10)
    ).toBe('x')
    expect(sent.length).toBeGreaterThan(0)
    expect(sent.every((n) => n.method === 'notifications/progress')).toBe(true)

    sent.length = 0
    await withHeartbeat(extraWith(undefined), 'thinking', () => Bun.sleep(35), 10)
    expect(sent.length).toBeGreaterThan(0)
    expect(sent.every((n) => n.method === 'notifications/message')).toBe(true)

    const after = sent.length
    await Bun.sleep(30)
    expect(sent.length).toBe(after)
  })

  test('outputText joins every output_text block of every message', () => {
    const payload = {
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'message', content: [{ type: 'output_text', text: 'Looks ' }] },
        { type: 'message', content: [{ type: 'refusal' }, { type: 'output_text', text: 'good' }] }
      ]
    }
    expect(outputText(payload)).toBe('Looks good')
    expect(outputText({ output: 'nope' })).toBe('')
    expect(outputText(null)).toBe('')
  })
})

// ─── The server, end to end (database) ─────────────────────────────────

const BASE = 'https://chatgpt.com/backend-api/codex'
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUg=='
const ORIGINAL_FETCH = globalThis.fetch
const ORIGINAL_KEY = process.env.RIALTO_ACCOUNT_ENCRYPTION_KEY
const ORIGINAL_CAPTURE = process.env.CAPTURE_REQUESTS

const app = new Hono()
app.route('/', codexMcpRoute)

const upstream: Array<{ url: string; body: Record<string, unknown> }> = []

const sse = (events: Array<Record<string, unknown>>): Response =>
  new Response(events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  })

const answer = (text: string): Response => {
  const item = { id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }
  return sse([
    { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.5', output: [], usage: null } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', item_id: 'm1', output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id: 'resp_1',
        model: 'gpt-5.5',
        status: 'completed',
        output: [item],
        usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 }
      }
    }
  ])
}

const stubUpstream = () => {
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(BASE)) throw new Error(`unexpected upstream: ${url}`)
    upstream.push({ url, body: JSON.parse(String(init?.body)) })
    if (url === `${BASE}/images/generations`) {
      return new Response(JSON.stringify({ created: 1, data: [{ b64_json: PNG_B64 }] }), {
        headers: { 'content-type': 'application/json' }
      })
    }
    return answer('Looks good')
  }
  globalThis.fetch = Object.assign(fake, { preconnect: ORIGINAL_FETCH.preconnect })
}

const seedCodex = async () => {
  const db = getPrismaClient()
  const provider = await db.provider.create({
    data: { name: 'codex', apiBaseUrl: BASE, authMode: 'subscription', apiStyle: 'openai_responses', enabled: true }
  })
  await db.model.createMany({
    data: [
      { providerId: provider.id, name: 'gpt-5.5', enabled: true },
      { providerId: provider.id, name: 'gpt-image-2.5-flare', enabled: true }
    ]
  })
  const account = await db.subAccount.create({
    data: {
      providerId: provider.id,
      label: 'main',
      plan: 'pro',
      sourcePath: 'oauth:test:main',
      accountId: 'account-main',
      accessTokenEnc: encryptString('oauth-main', encryptionKey()),
      expiresAt: dayjs('2099-01-01T00:00:00Z').toDate()
    }
  })
  resetLlmsContext()
  return account.id
}

const headers = (token: string, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  ...extra
})

const rpc = (token: string, method: string, params: Record<string, unknown> = {}, extra = {}): Promise<Response> =>
  app.fetch(
    new Request('http://local/codex', {
      method: 'POST',
      headers: headers(token, extra),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    })
  )

/** The JSON-RPC result out of an SSE or JSON response. */
async function resultOf(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text()
  const lines = text.startsWith('{') ? [text] : text.split('\n').filter((l) => l.startsWith('data: '))
  const messages = lines.map((l) => JSON.parse(l.startsWith('data: ') ? l.slice(6) : l))
  const reply = messages.find((m) => m.id === 1)
  if (reply === undefined) throw new Error(`no reply in ${text}`)
  if (reply.error !== undefined) throw new Error(JSON.stringify(reply.error))
  return reply.result
}

type ToolResult = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: true }

async function callTool(token: string, name: string, args: Record<string, unknown>, extra = {}): Promise<ToolResult> {
  const res = await rpc(token, 'tools/call', { name, arguments: args }, extra)
  expect(res.status).toBe(200)
  const result = await resultOf(res)
  return { content: Reflect.get(result, 'content'), ...(result.isError === true ? { isError: true } : {}) }
}

const textOf = (r: ToolResult): string => r.content.map((c) => (c.text === undefined ? '' : c.text)).join('\n')

/** The request log row for a token, once the fire-and-forget capture has written it. */
async function logRowFor(accessTokenId: string) {
  for (let i = 0; i < 50; i++) {
    const row = await getPrismaClient().requestLog.findFirst({ where: { accessTokenId } })
    if (row !== null) return row
    await Bun.sleep(20)
  }
  return null
}

const issue = async (surfaces: string[], planId?: string) =>
  issueAccessToken({ name: `t-${surfaces.join('+')}-${Math.random()}`, surfaces, ...(planId ? { planId } : {}) })

describe.skipIf(!HAS_DB)('Codex MCP server at /codex', () => {
  beforeEach(async () => {
    process.env.RIALTO_ACCOUNT_ENCRYPTION_KEY = 'ab'.repeat(32)
    delete process.env.CAPTURE_REQUESTS
    await resetDbTables()
    await getPrismaClient().$executeRawUnsafe(
      'TRUNCATE "AccessTokenUsageWindow","AccessToken","Plan" RESTART IDENTITY CASCADE'
    )
    invalidateTokenCache()
    invalidateSurfaceCache()
    __clearFilesForTests()
    __clearThreadsForTests()
    upstream.length = 0
    stubUpstream()
  })

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
    if (ORIGINAL_KEY === undefined) delete process.env.RIALTO_ACCOUNT_ENCRYPTION_KEY
    else process.env.RIALTO_ACCOUNT_ENCRYPTION_KEY = ORIGINAL_KEY
    if (ORIGINAL_CAPTURE === undefined) delete process.env.CAPTURE_REQUESTS
    else process.env.CAPTURE_REQUESTS = ORIGINAL_CAPTURE
    resetLlmsContext()
  })

  afterAll(teardownPrisma)

  test('admits only a token that names the codex-mcp scope', async () => {
    const unscoped = (await issue([])).plaintext
    const responsesOnly = (await issue(['openai-responses'])).plaintext
    const mcp = (await issue(['codex-mcp'])).plaintext

    const missing = await rpc('not-a-token', 'initialize')
    expect(missing.status).toBe(401)
    expect(missing.headers.get('www-authenticate')).toBeNull()
    expect((await rpc(unscoped, 'initialize')).status).toBe(403)
    expect((await rpc(responsesOnly, 'initialize')).status).toBe(403)

    const init = await rpc(mcp, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' }
    })
    expect(init.status).toBe(200)
    const result = await resultOf(init)
    expect(Reflect.get(Reflect.get(result, 'serverInfo'), 'name')).toBe('codex')
    expect(String(result.instructions)).toContain('Codex')

    const tools = await resultOf(await rpc(mcp, 'tools/list'))
    expect(Reflect.get(tools, 'tools').map((t: { name: string }) => t.name)).toEqual([
      'ask',
      'generate_image',
      'status'
    ])

    const get = await app.fetch(new Request('http://local/codex', { headers: headers(mcp) }))
    expect(get.status).toBe(405)
  })

  test('an MCP SDK client connects, lists the tools and calls one', async () => {
    await seedCodex()
    const mcp = (await issue(['codex-mcp'])).plaintext
    const transport = new StreamableHTTPClientTransport(new URL('http://local/codex'), {
      requestInit: { headers: { authorization: `Bearer ${mcp}` } },
      fetch: (input, init) => app.fetch(new Request(input, init))
    })
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(transport)
    expect(client.getServerVersion()?.name).toBe('codex')
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['ask', 'generate_image', 'status'])
    const result = await client.callTool({ name: 'ask', arguments: { prompt: 'Review this' } })
    expect(result.isError).toBeFalsy()
    await client.close()
  })

  test('accepts a protocol version newer than the SDK knows', async () => {
    const mcp = (await issue(['codex-mcp'])).plaintext
    const res = await rpc(mcp, 'tools/list', {}, { 'mcp-protocol-version': '2099-01-01' })
    expect(res.status).toBe(200)
  })

  test('ask answers from Codex, records the call as codex-mcp, and continues a thread', async () => {
    await seedCodex()
    const issued = await issue(['codex-mcp'])

    const first = await callTool(issued.plaintext, 'ask', { prompt: 'Review this diff', instructions: 'Be terse' })
    expect(first.isError).toBeUndefined()
    expect(first.content[0].text).toBe('Looks good')
    const threadId = /thread_id: (\S+)/.exec(textOf(first))?.[1]
    expect(threadId).toBeDefined()
    expect(textOf(first)).toContain('model: gpt-5.5')

    expect(upstream).toHaveLength(1)
    expect(upstream[0].url).toBe(`${BASE}/responses`)
    // An ask's instructions are a role for Codex to take, which the Codex
    // CLI sends as developer instructions: the first input message.
    expect(upstream[0].body.input).toContainEqual({
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: 'Be terse' }]
    })

    const row = await logRowFor(issued.id)
    expect(row?.surface).toBe('codex-mcp')
    expect(row?.provider).toBe('codex')
    expect(row?.sessionId).toBe(threadId)

    const second = await callTool(issued.plaintext, 'ask', { prompt: 'And the tests?', thread_id: threadId })
    expect(second.isError).toBeUndefined()
    const input = upstream[1].body.input
    expect(Array.isArray(input) ? input.map((m: { role: string }) => m.role) : input).toEqual([
      'developer',
      'user',
      'assistant',
      'user'
    ])
    // The thread's instructions carry over without being sent again.
    expect(Array.isArray(input) ? input[0].content : input).toEqual([{ type: 'input_text', text: 'Be terse' }])

    const stranger = await issue(['codex-mcp'])
    const refused = await callTool(stranger.plaintext, 'ask', { prompt: 'hi', thread_id: threadId })
    expect(refused.isError).toBe(true)
    expect(upstream).toHaveLength(2)
  })

  test('ask with no model uses the newest enabled one, not the first by name', async () => {
    await seedCodex()
    const db = getPrismaClient()
    const provider = await db.provider.findUniqueOrThrow({ where: { name: 'codex' } })
    await db.model.create({ data: { providerId: provider.id, name: 'gpt-5.2', enabled: true } })
    const mcp = (await issue(['codex-mcp'])).plaintext
    const result = await callTool(mcp, 'ask', { prompt: 'hi' })
    expect(result.isError).toBeUndefined()
    expect(textOf(result)).toContain('model: gpt-5.5')
  })

  test('ask refuses a model Codex does not have without calling upstream', async () => {
    await seedCodex()
    const mcp = (await issue(['codex-mcp'])).plaintext
    const result = await callTool(mcp, 'ask', { prompt: 'hi', model: 'claude-opus-5' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('Available: gpt-5.5')
    expect(upstream).toHaveLength(0)
  })

  test('a plan limit is spent by work, not by the MCP handshake or status', async () => {
    await seedCodex()
    const plan = await getPrismaClient().plan.create({
      data: { name: 'one-per-5h', models: ['codex,gpt-5.5'], defaultModel: 'codex,gpt-5.5', fiveHourRequestLimit: 1 }
    })
    const limited = await issue(['codex-mcp'], plan.id)
    const capped = limited.plaintext

    for (const method of ['initialize', 'tools/list', 'tools/list']) {
      expect((await rpc(capped, method, method === 'initialize' ? { protocolVersion: '2025-06-18' } : {})).status).toBe(
        200
      )
    }
    const before = JSON.parse(textOf(await callTool(capped, 'status', {}))).yourToken
    expect(before.windows).toEqual([
      {
        window: '5h',
        startedAt: null,
        resetsAt: null,
        requests: 0,
        requestLimit: 1,
        costUsd: 0,
        spendLimitUsd: null
      },
      {
        window: '7d',
        startedAt: null,
        resetsAt: null,
        requests: 0,
        requestLimit: null,
        costUsd: 0,
        spendLimitUsd: null
      }
    ])

    expect((await callTool(capped, 'ask', { prompt: 'one' })).isError).toBeUndefined()
    const second = await callTool(capped, 'ask', { prompt: 'two' })
    expect(second.isError).toBe(true)
    expect(textOf(second)).toContain('5-hour request limit')
    expect(upstream).toHaveLength(1)

    const after = JSON.parse(textOf(await callTool(capped, 'status', {}))).yourToken
    const fiveHour = after.windows[0]
    expect(fiveHour.requests).toBe(1)
    expect(textOf(second)).toContain(fiveHour.resetsAt)
    expect(dayjs(fiveHour.resetsAt).diff(dayjs(fiveHour.startedAt), 'hour')).toBe(5)
    // Both windows count the call; only the 5-hour one has a limit.
    expect(after.windows[1].requests).toBe(1)
  })

  test('status reports no windows for a token whose plan sets no limit', async () => {
    const plan = await getPrismaClient().plan.create({
      data: { name: 'open', models: ['codex,gpt-5.5'], defaultModel: 'codex,gpt-5.5' }
    })
    const token = (await issue(['codex-mcp'], plan.id)).plaintext
    expect(JSON.parse(textOf(await callTool(token, 'status', {}))).yourToken).toBeUndefined()
  })

  test("a plan that does not list the model refuses rather than answering with the plan's default", async () => {
    await seedCodex()
    const plan = await getPrismaClient().plan.create({
      data: {
        name: 'other',
        models: ['anthropic,claude-x'],
        defaultModel: 'anthropic,claude-x'
      }
    })
    const token = (await issue(['codex-mcp'], plan.id)).plaintext
    const result = await callTool(token, 'ask', { prompt: 'hi' })
    expect(result.isError).toBe(true)
    expect(upstream).toHaveLength(0)
    const report = JSON.parse(textOf(await callTool(token, 'status', {})))
    expect(report.models).toEqual([])
    expect(report.imageModels).toEqual([])
  })

  test('generate_image returns the image and a link that downloads it', async () => {
    await seedCodex()
    const issued = await issue(['codex-mcp'])
    const result = await callTool(
      issued.plaintext,
      'generate_image',
      { prompt: 'A paper lantern' },
      { 'x-forwarded-proto': 'https' }
    )
    expect(result.isError).toBeUndefined()
    expect(result.content[0]).toEqual({ type: 'image', data: PNG_B64, mimeType: 'image/png' })
    const url = /(https:\/\/local\/codex\/files\/[A-Za-z0-9_-]{22})/.exec(textOf(result))?.[1]
    expect(url).toBeDefined()

    const download = await app.fetch(new Request(String(url).replace('https:', 'http:')))
    expect(download.status).toBe(200)
    expect(download.headers.get('content-type')).toBe('image/png')
    expect(download.headers.get('cache-control')).toBe('private, no-store')
    expect(Buffer.from(await download.arrayBuffer()).toString('base64')).toBe(PNG_B64)

    const row = await logRowFor(issued.id)
    expect(row?.surface).toBe('codex-mcp')
    expect(row?.model).toBe('gpt-image-2.5-flare')

    const linkOnly = await callTool(issued.plaintext, 'generate_image', { prompt: 'again', include_image: false })
    expect(linkOnly.content.map((c) => c.type)).toEqual(['text'])

    expect((await app.fetch(new Request('http://local/codex/files/AAAAAAAAAAAAAAAAAAAAAA'))).status).toBe(404)
  })

  test('duplicate Codex models need a priority and remain bare in status', async () => {
    await seedCodex()
    const db = getPrismaClient()
    const provider = await db.provider.create({
      data: {
        name: 'codex-alt',
        apiBaseUrl: BASE,
        authMode: 'subscription',
        apiStyle: 'openai_responses',
        enabled: true
      }
    })
    await db.model.create({ data: { providerId: provider.id, name: 'gpt-5.5', enabled: true } })
    await db.subAccount.create({
      data: {
        providerId: provider.id,
        label: 'second',
        plan: 'pro',
        sourcePath: 'oauth:test:second',
        accountId: 'account-second',
        accessTokenEnc: encryptString('oauth-second', encryptionKey()),
        expiresAt: dayjs('2099-01-01T00:00:00Z').toDate()
      }
    })
    resetLlmsContext()
    const mcp = (await issue(['codex-mcp'])).plaintext
    const report = JSON.parse(textOf(await callTool(mcp, 'status', {})))
    expect(report.models).toEqual([])
    expect(textOf(await callTool(mcp, 'ask', { prompt: 'hi', model: 'gpt-5.5' }))).toContain('configure their priority')
    await setModelProviderPriorities('gpt-5.5', ['codex-alt', 'codex'])
    const configured = JSON.parse(textOf(await callTool(mcp, 'status', {})))
    expect(configured.models).toMatchObject([{ model: 'gpt-5.5', provider: 'codex-alt' }])
    expect((await callTool(mcp, 'ask', { prompt: 'hi', model: 'gpt-5.5' })).isError).toBeUndefined()
  })

  test('status reports the Codex accounts, their windows, and the models', async () => {
    const accountId = await seedCodex()
    clearAccountExhaustion(accountId)
    await getPrismaClient().subAccountQuota.create({
      data: {
        subAccountId: accountId,
        fiveHourUsed: 42,
        fiveHourLimit: 100,
        fiveHourResetAt: dayjs('2099-01-01T05:00:00Z').toDate(),
        weeklyUsed: 7,
        weeklyLimit: 100,
        weeklyResetAt: dayjs('2099-01-07T00:00:00Z').toDate(),
        resetCreditsAvailable: 2,
        quotaRefreshedAt: dayjs('2099-01-01T00:00:00Z').toDate()
      }
    })
    const mcp = (await issue(['codex-mcp'])).plaintext
    const report = JSON.parse(textOf(await callTool(mcp, 'status', {})))
    expect(report.accounts).toHaveLength(1)
    expect(report.accounts[0]).toMatchObject({
      provider: 'codex',
      account: 'main',
      enabled: true,
      rateLimited: false,
      fiveHour: { usedPercent: 42, resetsAt: '2099-01-01T05:00:00.000Z' },
      weekly: { usedPercent: 7 },
      bankedResets: 2
    })
    expect(report.models).toMatchObject([{ model: 'gpt-5.5', provider: 'codex' }])
    expect(report.imageModels).toEqual(['gpt-image-2.5-flare'])
    expect(report.yourToken).toBeUndefined()
    expect(upstream).toHaveLength(0)
  })
})
