/**
 * Send the (already request-chain-transformed) body to the provider.
 *
 * Owns the bypass-mode auth hook, header assembly, request/response
 * logging, upstream error surfacing, and kicking off the best-effort
 * usage / chat-view message capture on cloned response streams.
 */

import { randomUUID } from 'node:crypto'
import { HTTPException } from 'hono/http-exception'
import type { Logger } from 'pino'
import {
  isTransformerHookResult,
  type TransformerConfig,
  type TransformerContext,
  viewPipelineBody
} from '@/schemas/domain/pipeline'
import { fetchProvider } from '../provider-fetch'
import type { ResolvedProvider } from '../registry/provider'
import type { Transformer } from '../transformers/base'
import { captureSafeguardResultMetadata, hasSafeguards } from './classifier-diagnostics'
import { captureAssistantMessage, extractLastUserContent } from './message-capture'
import { shouldStripInboundHeader } from './request-chain'
import { resolveSessionId } from './session-id'
import type { PipelineDeps } from './types'
import { captureUsage } from './usage-extraction'

export async function sendToProvider(
  requestBody: unknown,
  config: TransformerConfig,
  provider: ResolvedProvider,
  transformer: Transformer,
  bypass: boolean,
  context: TransformerContext,
  deps: PipelineDeps
): Promise<Response> {
  const { body, outConfig } = await applyBypassAuth(requestBody, config, provider, transformer, bypass, context)
  const url = outConfig.url !== undefined ? outConfig.url : new URL(provider.api_base_url)

  // One id per upstream send. LogViewer groups a request's lines by
  // reqId — bind it on a child logger so request body / response /
  // error all carry the same id.
  const reqId = randomUUID()
  const reqLog = deps.log.child({ reqId })
  const startedAt = Date.now()

  // Info-level heartbeat when a transformer rewrote `config.url` away
  // from the provider's declared api_base_url — the exact gap that lets
  // an outbound request land on a different host than the operator sees
  // in /api/config. Silent when the two match. Query-stripped both sides
  // so a Gemini `?key=` never leaks into logs.
  if (outConfig.url !== undefined) {
    const declared = stripUrlSecrets(provider.api_base_url)
    const actual = stripUrlSecrets(url)
    if (declared !== actual) {
      reqLog.info(
        { provider: provider.name, declared, actual },
        `[upstream_url_rewritten] ${provider.name}: ${declared} → ${actual}`
      )
    }
  }

  const headers = buildRequestHeaders(provider, outConfig)

  logRequest(reqLog, provider, body, url, bypass)
  const signals = context.req?.classifierSignals
  const diagnostic = signals?.safeguardsPresent || signals?.suspectedClassifier || hasSafeguards(body)
  if (diagnostic) {
    reqLog.info(
      {
        event: 'classifier_diagnostic',
        phase: 'upstream_request',
        safeguardsPresent: signals?.safeguardsPresent ?? false,
        safeguardsForwarded: hasSafeguards(body),
        suspectedClassifier: signals?.suspectedClassifier ?? false,
        provider: provider.name,
        model: context.req?.model,
        requestedModel: context.req?.requestedModel,
        route: context.req?.route,
        bypass
      },
      'classifier diagnostic: upstream request signals'
    )
  }

  // Capture the user turn before we send. Anthropic's message array is
  // the same in bypass and unified paths, so pulling the last user block
  // works in both. Fire-and-forget: message capture must never delay
  // the upstream call or fail it.
  if (deps.recordMessages) {
    const sessionId = resolveSessionId(context)
    const userContent = extractLastUserContent(body)
    if (userContent !== null) {
      void deps.recordMessages([{ sessionId, role: 'user', content: userContent }]).catch(() => {})
    }
  }

  const response = await fetchProvider(url, body, { headers, httpsProxy: deps.httpsProxy }, { reqId }, reqLog)
  const durationMs = Date.now() - startedAt

  if (diagnostic) {
    reqLog.info(
      {
        event: 'classifier_diagnostic',
        phase: 'upstream_response',
        provider: provider.name,
        status: response.status,
        durationMs
      },
      'classifier diagnostic: upstream response status'
    )
    if (response.ok) captureSafeguardResultMetadata(response, reqLog)
  }
  if (!response.ok) {
    await handleProviderError(response, provider, transformer, body, durationMs, url, reqLog)
  }

  logResponse(reqLog, provider, body, response.status, durationMs)

  // Best-effort usage capture from a cloned stream so the completion
  // log carries token + cache stats. Never blocks the response.
  if (deps.recordUsage && typeof response.clone === 'function') {
    const clone = response.clone()
    void captureUsage(clone, context, provider, body, response.status, durationMs, deps).catch(() => {})
  }

  // Best-effort assistant-content capture from a second clone. Parses
  // the Anthropic SSE stream into text / tool_use blocks. Independent
  // from usage capture so a parse failure in one doesn't kill the other.
  if (deps.recordMessages && response.ok && typeof response.clone === 'function') {
    const clone = response.clone()
    const sessionId = resolveSessionId(context)
    void captureAssistantMessage(clone, sessionId, deps).catch(() => {})
  }

  return response
}

/**
 * Bypass-mode auth hook (subscription OAuth flows live here). When the
 * hook returns `{ body, config }`, merge upstream headers in case-safe
 * order; otherwise the hook may return a plain body replacement.
 */
async function applyBypassAuth(
  body: unknown,
  config: TransformerConfig,
  provider: ResolvedProvider,
  transformer: Transformer,
  bypass: boolean,
  context: TransformerContext
): Promise<{ body: unknown; outConfig: TransformerConfig }> {
  if (!bypass) return { body, outConfig: config }

  const auth = await transformer.auth(body, provider, context)
  if (!isTransformerHookResult(auth)) {
    return { body: auth, outConfig: config }
  }

  const inboundHeaders: Record<string, string | undefined> = config.headers !== undefined ? { ...config.headers } : {}
  if (auth.config?.headers) {
    // Drop inbound headers that must not reach the upstream (client
    // auth, Cloudflare / proxy trail, host, hop-by-hop) before merging
    // the transformer's upstream auth. Reuses the same predicate the
    // request-chain bypass path uses so the two entry points can't
    // silently drift on which headers get through.
    for (const k of Object.keys(inboundHeaders)) {
      if (shouldStripInboundHeader(k)) delete inboundHeaders[k]
    }
    Object.assign(inboundHeaders, auth.config.headers)
    delete inboundHeaders.host
  }
  return { body: auth.body, outConfig: { ...config, ...auth.config, headers: inboundHeaders } }
}

function buildRequestHeaders(
  provider: ResolvedProvider,
  outConfig: TransformerConfig
): Record<string, string | undefined> {
  // Build header set: provider Bearer (overwritten by transformer auth
  // headers, if any), then merge transformer-provided headers.
  const merged: Record<string, string | undefined> = {
    Authorization: `Bearer ${provider.api_key}`,
    ...(outConfig.headers !== undefined ? outConfig.headers : {})
  }
  for (const k of Object.keys(merged)) {
    const v = merged[k]
    if (v === 'undefined') delete merged[k]
    else if (k.toLowerCase() === 'authorization' && typeof v === 'string' && v.includes('undefined')) delete merged[k]
  }
  return merged
}

function logRequest(log: Logger, provider: ResolvedProvider, body: unknown, url: URL | string, bypass: boolean): void {
  const view = viewPipelineBody(body)
  log.debug(
    {
      type: 'request body',
      data: {
        provider: provider.name,
        model: view.model,
        url: String(url),
        stream: view.stream === true,
        bypass,
        messages: view.messages !== undefined ? view.messages.length : undefined,
        tools: view.tools !== undefined ? view.tools.length : undefined
      }
    },
    'llm request'
  )
}

// Parse upstream error bodies so pino logs them as nested objects
// instead of an escape-laden string. Anything that isn't valid JSON
// (HTML error pages, plain text) is returned verbatim so the raw bytes
// still reach the log.
function tryParseJson(text: string): unknown {
  if (text.length === 0) return text
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function logResponse(log: Logger, provider: ResolvedProvider, body: unknown, status: number, durationMs: number): void {
  const view = viewPipelineBody(body)
  log.debug(
    {
      type: 'response',
      provider: provider.name,
      model: view.model,
      status,
      durationMs
    },
    `${provider.name}/${view.model} ${status} ${durationMs}ms`
  )
}

// Symbol key used to attach the resolved outbound URL to an HTTPException
// so `forwardUpstreamError` can surface it back to the client as
// `x-rialto-upstream-url`. Symbol-keyed (not a plain field) so a caller
// enumerating the exception's own keys never sees it.
export const UPSTREAM_URL_SYMBOL = Symbol.for('rialto.upstreamUrl')

// Strip query params from an outbound URL before it lands in logs or a
// response header. Gemini authenticates via `?key=<apiKey>` on the URL,
// so echoing the search string would leak the api key onto every 4xx
// response. Path + host is the diagnostic bit — the query never is.
export function stripUrlSecrets(url: URL | string): string {
  try {
    const u = typeof url === 'string' ? new URL(url) : url
    return `${u.origin}${u.pathname}`
  } catch {
    // Malformed input — return the original string sans anything past
    // the first '?' so we don't leak a key even in the degenerate path.
    const s = String(url)
    const q = s.indexOf('?')
    return q >= 0 ? s.slice(0, q) : s
  }
}

async function handleProviderError(
  response: Response,
  provider: ResolvedProvider,
  transformer: Transformer,
  body: unknown,
  durationMs: number,
  url: URL | string,
  log: Logger
): Promise<never> {
  const errorText = await response.text()
  const isSubscription = transformer.name.endsWith('-oauth')
  const view = viewPipelineBody(body)
  const model = view.model !== undefined ? view.model : 'unknown'
  const safeUrl = stripUrlSecrets(url)

  // KEEP this message byte-for-byte: v1/route.ts has a regex
  // (PROVIDER_ERR_RE) that parses "Error from provider(<name>,<model>:
  // <status>): <rawBody>" to forward the genuine upstream error to
  // Claude Code verbatim.
  const message = `Error from provider(${provider.name},${model}: ${response.status}): ${errorText}`
  // Include the actual outbound URL in the error log so operators can
  // distinguish provider.api_base_url (what the config says) from the
  // URL Rialto really posted to (which a custom transformer or overlay may
  // have rewritten via config.url).
  log.error(
    {
      type: 'response',
      provider: provider.name,
      model,
      status: response.status,
      durationMs,
      url: safeUrl,
      body: tryParseJson(errorText)
    },
    `[provider_response_error] ${message}`
  )

  if ((response.status === 401 || response.status === 403) && isSubscription) {
    log.error(
      { provider: provider.name, status: response.status },
      `Subscription auth rejected by '${provider.name}' (${response.status}). ` +
        'If the OAuth credentials are absent/expired, re-authenticate ' +
        'the underlying CLI (run `claude` and sign in for claude-code, ' +
        'or `codex login` for codex) to refresh the credentials file.'
    )
  }
  // biome-ignore plugin: HTTPException's status param is typed as a closed union of supported codes;
  // upstream returns arbitrary HTTP codes which we forward verbatim, so the cast is the only path.
  const exc = new HTTPException(response.status as never, { message })
  // Attach the safe outbound URL so forwardUpstreamError can echo it on
  // the client-facing response header. Symbol-keyed to keep it off the
  // exception's enumerable surface — matches the `via` provider tag
  // plumbing without changing the throw contract other callers depend on.
  ;(exc as unknown as Record<symbol, unknown>)[UPSTREAM_URL_SYMBOL] = safeUrl
  throw exc
}
