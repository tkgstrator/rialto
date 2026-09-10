import 'dotenv/config'
import { OpenAPIHono } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import { ZodError } from 'zod'
import { accessCheckRoute } from './api/access-check/route'
import { accessLog } from './api/access-log'
import { accessTokensRoute } from './api/access-tokens/route'
import { adminAuth, inboundProxyAuth } from './api/api-key-auth'
import { catalogRoute } from './api/catalog/route'
import { configRoute } from './api/config/route'
import { healthRoute } from './api/health/route'
import { identityRoute } from './api/identity/route'
import { inboundSurfacesRoute } from './api/inbound-surfaces/route'
import { logsRoute } from './api/logs/route'
import { modelsRoute } from './api/models/route'
import { modelTestRoute } from './api/models/test/route'
import { modelTestAllRoute } from './api/models/test-all/route'
import { oauthRoute } from './api/oauth/route'
import { overviewRoute } from './api/overview/route'
import { providerModelRoute } from './api/providers/[name]/models/[model]/route'
import { providerByNameRoute } from './api/providers/[name]/route'
import { providersRoute } from './api/providers/route'
import { providersTestRoute } from './api/providers/test/route'
import { refreshModelsRoute } from './api/refresh-models/route'
import { requestLogsRoute } from './api/request-logs/route'
import { routerPreferencesRoute } from './api/router-preferences/route'
import { routerUtilizationRoute } from './api/router-utilization/route'
import { routingSchedulerStateRoute } from './api/routing-scheduler-state/route'
import { scrapePricesRoute } from './api/scrape-prices/[vendor]/route'
import { solverInputRoute } from './api/solver-input/route'
import { storageRoute } from './api/storage/route'
import { subscriptionsRoute } from './api/subscriptions/route'
import { transformersRoute } from './api/transformers/route'
import { updateCheckRoute } from './api/update/check/route'
import { updatePerformRoute } from './api/update/perform/route'
import { usageCostHistoryRoute } from './api/usage/cost/history/route'
import { usageCostRoute } from './api/usage/cost/route'
import { usageHistoryRoute } from './api/usage/history/route'
import { usageRoute } from './api/usage/route'
import { countTokensRoute } from './api/v1/count-tokens'
import { v1ModelsRoute } from './api/v1/models-list'
import { v1Route } from './api/v1/route'
import { INBOUND_MOUNT_PREFIXES } from './llms/inbound/surfaces'
import { logger, syncLoggerFromEnv } from './logger'
import { startAuthHealthCheck } from './services/auth-health-job'
import { readAccessConfig } from './services/cloudflare-access'
import { initConfig, initDir } from './services/config/envelope'
import { migrateHomeDir } from './services/config/migrate-home-dir'
import { ensureInboundSurfaces } from './services/inbound-surface-service'
import { startRoutingScheduler } from './services/routing-scheduler'
import { startUsageCapture } from './services/usage-job'
import { HOME_DIR } from './shared/constants'
import { APP_VERSION } from './version'

// Hono root. Backend routes live under src/api/<path>/route.ts (one
// Hono sub-app per file, Next.js-style) and are mounted here. The
// /v1/* LLM proxy is served natively by v1Route, which drives the
// absorbed llms router + transformer pipeline directly (no Fastify).
//
// Single entry for both dev and prod: in dev, @hono/vite-dev-server
// imports this module and only forwards /api/* + /v1/* to app.fetch
// (everything else is Vite-served). In prod, Bun runs this file
// directly and consumes the default export's { port, fetch, idleTimeout }.
// The SPA + static-asset handlers below are registered only when
// ./dist/index.html exists, so dev (no build output) skips them safely.
//
// DB schema + first-run seed rows are NOT created here — that's the
// job of `prisma migrate deploy` + `prisma db seed`, which entrypoint.sh
// runs before exec'ing this process (or `bun db:migrate` locally).

// Carry a pre-rename ~/.claude-code-router over to ~/.rialto before
// anything reads or creates the new home. This has to be the first
// statement: the migration is idempotent by "the destination already
// exists", so any earlier mkdir of ~/.rialto — initDir(), or the
// logger's first file write — would make the copy a permanent no-op and
// silently start the operator on an empty configuration.
//
// Skipped when RIALTO_HOME_DIR pins the home elsewhere: ~/.rialto is
// then not the directory being read, so moving into it would only
// litter the operator's home.
if (process.env.RIALTO_HOME_DIR === undefined) {
  await migrateHomeDir()
}
await initDir()
const envelope = await initConfig()
// Re-apply LOG_LEVEL to the already-initialised logger: the pino
// instance is constructed at import time before initConfig() has
// mirrored config.json's LOG_LEVEL onto process.env.
syncLoggerFromEnv()
// Nothing can reach /api/* when the local exemption is switched off and
// Cloudflare Access is not configured: there is no admin secret to fall
// back on. Said once at boot, because the UI itself can only answer 401.
if (process.env.RIALTO_TRUST_LOCAL === 'false' && readAccessConfig() === null) {
  logger.warn(
    'RIALTO_TRUST_LOCAL=false and Cloudflare Access is not configured — nothing can reach /api/*. Set ACCESS_TEAM_DOMAIN and ACCESS_AUD, or unset RIALTO_TRUST_LOCAL.'
  )
}
// Give every inbound surface an explicit stored routing mode, so no
// read has to fall back to a per-surface default.
await ensureInboundSurfaces()
// Fire-and-forget: never block server boot on Redis. The job setup
// is resilient and registers the BullMQ schedule once Redis is reachable;
// it has its own per-process guard so HMR re-evaluation is a no-op.
void startUsageCapture()
// Same pattern: periodically re-probe each subscription account and
// persist its authStatus so the UI can flag accounts that need
// re-authentication.
void startAuthHealthCheck()
// Routing scheduler. It computes the weights the chain routes on — the
// operator picks the models and their order, this decides how much of
// the traffic each one takes. The chain is the only selector, so the
// scheduler always has a consumer and always runs.
startRoutingScheduler()

const app = new OpenAPIHono()

// Gate everything that hits the paid subscriptions or mutates config.
// /api/* admits a browser on this machine or a verified Cloudflare Access
// assertion, and nothing else; /v1/* admits issued access tokens only.
// The static SPA at `/` stays open so a refused browser can still load
// /access-denied and read why.
//
// The OAuth callback lives at the root path `/callback` (not under
// /api/*) because Anthropic's OAuth client only whitelists the
// loopback `http://localhost:<port>/callback` pattern. It is therefore
// naturally outside this gate; CSRF protection lives on the single-use
// `state` issued at POST /api/oauth/initiate/* (still gated).
// Access log runs BEFORE the auth gates so 401s from them are
// visible too — otherwise a wrong-key probe leaves no trace at all.
// GET /health mounts BEFORE the auth middleware and BEFORE the SPA
// catch-all so uptime probes hit a machine-readable JSON body without
// carrying a credential. Registered here (not inside the /api/* tree) so
// the outer accessLog / auth gates don't apply to it.
app.route('/', healthRoute)

app.use('/api/*', accessLog)
app.use('/api/*', adminAuth)
// Proxy front door. The prefixes and the credential convention behind
// each path both come from the inbound-surface registry, so adding a
// surface does not mean remembering to name its path here — which is
// exactly the omission that used to leave a new surface either
// unauthenticated or authenticated by the wrong convention.
for (const prefix of INBOUND_MOUNT_PREFIXES) {
  app.use(prefix, accessLog)
  app.use(prefix, inboundProxyAuth)
}

app.onError((err, c) => {
  if (err instanceof ZodError) {
    return c.json({ success: false as const, error: { type: 'validation_error' as const, issues: err.issues } }, 400)
  }
  if (err instanceof HTTPException) {
    return err.getResponse()
  }
  logger.error({ err }, 'unhandled route error')
  return c.json(
    {
      success: false as const,
      error: { type: 'internal_error', message: err.message }
    },
    500
  )
})

// Each sub-app declares its own absolute /api/... paths, so mount them
// at root. OpenAPIHono.route() also merges their OpenAPI registries.
app.route('/', configRoute)
app.route('/', logsRoute)
app.route('/', transformersRoute)
app.route('/', subscriptionsRoute)
app.route('/', usageRoute)
app.route('/', usageHistoryRoute)
app.route('/', usageCostRoute)
app.route('/', usageCostHistoryRoute)
app.route('/', updateCheckRoute)
app.route('/', updatePerformRoute)
app.route('/', catalogRoute)
app.route('/', refreshModelsRoute)
app.route('/', providersRoute)
app.route('/', providerByNameRoute)
app.route('/', providerModelRoute)
app.route('/', providersTestRoute)
app.route('/', modelsRoute)
app.route('/', modelTestRoute)
app.route('/', modelTestAllRoute)
app.route('/', scrapePricesRoute)
app.route('/', requestLogsRoute)
app.route('/', routerPreferencesRoute)
app.route('/', routerUtilizationRoute)
app.route('/', routingSchedulerStateRoute)
app.route('/', solverInputRoute)
app.route('/', overviewRoute)
app.route('/', inboundSurfacesRoute)
app.route('/', identityRoute)
app.route('/', accessTokensRoute)
app.route('/', accessCheckRoute)
app.route('/', storageRoute)
app.route('/', oauthRoute)

// OpenAI-compat GET /v1/models — mounted BEFORE v1Route so the wildcard
// POST handler inside v1Route never has a chance to swallow it.
app.route('/', v1ModelsRoute)
// Anthropic POST /v1/messages/count_tokens — same ordering requirement:
// v1Route's `/v1/*` fail-closed lane would answer 404 for it otherwise.
app.route('/', countTokensRoute)
// Native /v1/* LLM proxy — drives the llms pipeline without Fastify.
app.route('/', v1Route)

// OpenAPI spec endpoint — useful for tooling and the generated docs.
app.doc('/api/openapi.json', {
  openapi: '3.1.0',
  info: { title: 'Rialto API', version: APP_VERSION }
})

// SPA + static fallback for production runs (Bun serving the built
// single-file index.html). Vite handles the SPA in dev, and dist/
// doesn't exist there, so we skip registration entirely when the build
// output is missing. Registration order matters: this is attached
// AFTER every API route, so it can never shadow them or strip auth.
//
// Gated on `typeof Bun !== 'undefined'` because @hono/vite-dev-server
// imports this module in Vite's Node-based SSR runtime, where the Bun
// global is missing and `hono/bun`'s SSG submodule throws at evaluation
// time. The dynamic import keeps that submodule out of the Node load path.
if (typeof Bun !== 'undefined') {
  const indexHtmlFile = Bun.file('./dist/index.html')
  if (await indexHtmlFile.exists()) {
    const { serveStatic } = await import('hono/bun')
    app.use('/*', serveStatic({ root: './dist' }))
    const indexHtml = await indexHtmlFile.text()
    app.get('/*', (c) => c.html(indexHtml))
  }
}

// Bun's per-request idle timeout defaults to 10s and kills any socket
// that goes quiet for that long. LLM calls routinely think for far
// longer than 10s before the first token, so the default makes Bun
// abort live requests with "request timed out after 10 seconds". 255
// is Bun's maximum; lower values just reintroduce the cutoff. The
// envelope key is in ms — convert to seconds and clamp to 1..255.
const idleTimeout = envelope.API_TIMEOUT_MS
  ? Math.min(Math.max(1, Math.round(envelope.API_TIMEOUT_MS / 1000)), 255)
  : 255

// Bun auto-serves a default export of `{ port, fetch }`. Vite's
// dev-server only looks at `.fetch`, so the extra fields are harmless
// in dev. PORT comes from the schema-parsed envelope (default 3456),
// so any in-app feature that builds a self URL from it matches the
// port Bun actually bound.
export default {
  port: envelope.PORT,
  idleTimeout,
  fetch: app.fetch
}
