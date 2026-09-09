import type { Dispatch, ReactNode, SetStateAction } from 'react'
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiUnreachableScreen } from '@/components/rialto/system/ApiUnreachable'
import { api } from '@/lib/api'
import { type RouteRule, RouteRuleSchema } from '@/schemas/domain/router'
import type { Config } from '@/types'

interface ConfigContextType {
  config: Config | null
  setConfig: Dispatch<SetStateAction<Config | null>>
  // Re-fetch /api/config and re-apply the same normalization the
  // provider does on mount (raw nulls -> '' / [] for the typed Config
  // the rest of the app consumes). Used by the JSON editor after a save
  // so other screens see a fresh, normalized config rather than the raw
  // (possibly-null) payload the editor itself displays.
  reloadConfig: () => Promise<void>
  error: Error | null
  // True once a request came back 401. ProtectedRoute reads this to send
  // the operator to /access-denied — including when the failure happened
  // before the shell mounted, which the 'unauthorized' event alone
  // cannot cover. (There is no login screen to send them to: Cloudflare
  // Access authenticates at the edge, and the old form was removed with
  // its route in Phase 3.5.)
  authFailed: boolean
}

const ConfigContext = createContext<ConfigContextType | undefined>(undefined)

// eslint-disable-next-line react-refresh/only-export-components
export function useConfig() {
  const context = useContext(ConfigContext)
  if (context === undefined) {
    throw new Error('useConfig must be used within a ConfigProvider')
  }
  return context
}

interface ConfigProviderProps {
  children: ReactNode
}

// Coerce the per-scenario fallback chains off the raw wire shape into
// the full { scenario: string[] } object the form expects. A missing /
// malformed list normalizes to an empty array.
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

// The UI-facing shape of one route target: catch-all primary + fallback
// chain, plus any predicated rules that survived a round-trip through
// the server. Rules are opaque to the current UI (Phase 4 will surface
// them); we preserve them verbatim so saving doesn't nuke a rule the
// migration or a future rule editor wrote.
type RouteTargetForm = { primary: string | null; fallbacks: string[]; rules: RouteRule[] }

// Coerce one route target's raw wire object into the shape the form
// binds to. Defensive against a partial / stale wire object. Rules pass
// through the same Zod schema the server writes so malformed entries
// are dropped rather than crashing the form binding.
function normalizeRouteTarget(raw: unknown): RouteTargetForm {
  const obj = raw !== null && typeof raw === 'object' ? raw : {}
  const primary = Reflect.get(obj, 'primary')
  const rawRules = Reflect.get(obj, 'rules')
  const rules: RouteRule[] = Array.isArray(rawRules)
    ? rawRules.flatMap((r) => {
        const parsed = RouteRuleSchema.safeParse(r)
        return parsed.success ? [parsed.data] : []
      })
    : []
  return {
    primary: typeof primary === 'string' && primary !== '' ? primary : null,
    fallbacks: asStringArray(Reflect.get(obj, 'fallbacks')),
    rules
  }
}

// Coerce one scenario's raw route into the nested { agent, subagent }
// shape (two route targets per scenario). Defensive against a partial /
// stale wire object — a missing agent/subagent route defaults to unset.
function normalizeScenario(raw: unknown): {
  agent: RouteTargetForm
  subagent: RouteTargetForm
} {
  const obj = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    agent: normalizeRouteTarget(Reflect.get(obj, 'agent')),
    subagent: normalizeRouteTarget(Reflect.get(obj, 'subagent'))
  }
}

// Longcontext threshold rides as `number | null` on the wire; null means
// "auto" (the runtime derives an effective value from the default
// agent primary's contextWindow). numberOrNull collapses anything that
// isn't a number to null so a missing/invalid field lands on auto
// rather than silently pinning 128k.
function numberOrNull(raw: unknown): number | null {
  return typeof raw === 'number' ? raw : null
}

// Build the nested Config['Router'] from the raw wire object. Each
// scenario nests its agent + subagent routes (primary + fallback chain);
// the sole scenario-scoped knob (threshold on longContext) rides on its
// owning scenario.
function normalizeRouter(raw: unknown): Config['Router'] {
  const obj = raw !== null && typeof raw === 'object' ? raw : {}
  const get = (k: string): unknown => Reflect.get(obj, k)
  const longContextRaw = get('longContext')
  const lcObj = longContextRaw !== null && typeof longContextRaw === 'object' ? longContextRaw : {}
  const persona = get('persona')
  return {
    default: normalizeScenario(get('default')),
    think: normalizeScenario(get('think')),
    longContext: { ...normalizeScenario(longContextRaw), threshold: numberOrNull(Reflect.get(lcObj, 'threshold')) },
    webSearch: normalizeScenario(get('webSearch')),
    image: normalizeScenario(get('image')),
    persona: typeof persona === 'string' && persona !== '' ? persona : undefined
  }
}

// Coerce the raw /api/config wire shape (which now carries explicit
// nulls for unset api_key / path scalars / router slots) into the typed
// Config the app's controlled inputs expect (non-null strings, arrays).
// Centralized so both the mount fetch and reloadConfig stay in sync.
function normalizeConfig(data: Config): Config {
  return {
    LOG: typeof data.LOG === 'boolean' ? data.LOG : false,
    LOG_LEVEL: typeof data.LOG_LEVEL === 'string' && data.LOG_LEVEL !== '' ? data.LOG_LEVEL : 'info',
    CLAUDE_PATH: typeof data.CLAUDE_PATH === 'string' ? data.CLAUDE_PATH : '',
    HOST: typeof data.HOST === 'string' ? data.HOST : '127.0.0.1',
    PORT: typeof data.PORT === 'number' ? data.PORT : 3456,
    APIKEY: typeof data.APIKEY === 'string' ? data.APIKEY : '',
    API_TIMEOUT_MS: typeof data.API_TIMEOUT_MS === 'number' ? data.API_TIMEOUT_MS : 600000,
    PROXY_URL: typeof data.PROXY_URL === 'string' ? data.PROXY_URL : '',
    Providers: Array.isArray(data.Providers) ? data.Providers : [],
    StatusLine:
      data.StatusLine && typeof data.StatusLine === 'object'
        ? {
            enabled: typeof data.StatusLine.enabled === 'boolean' ? data.StatusLine.enabled : false,
            currentStyle: typeof data.StatusLine.currentStyle === 'string' ? data.StatusLine.currentStyle : 'default',
            default:
              data.StatusLine.default &&
              typeof data.StatusLine.default === 'object' &&
              Array.isArray(data.StatusLine.default.modules)
                ? data.StatusLine.default
                : { modules: [] },
            powerline:
              data.StatusLine.powerline &&
              typeof data.StatusLine.powerline === 'object' &&
              Array.isArray(data.StatusLine.powerline.modules)
                ? data.StatusLine.powerline
                : { modules: [] }
          }
        : {
            enabled: false,
            currentStyle: 'default',
            default: { modules: [] },
            powerline: { modules: [] }
          },
    Router: normalizeRouter(data.Router),
    CUSTOM_ROUTER_PATH: typeof data.CUSTOM_ROUTER_PATH === 'string' ? data.CUSTOM_ROUTER_PATH : '',
    // Envelope scalars edited from the Settings page. Optional on the
    // wire (Config schema) — leave them undefined when absent so the
    // form's default-value fallback decides the initial UI value.
    // Copying them through here is what makes save-then-reload actually
    // round-trip; without this the wire value gets dropped and the form
    // always re-initialises to the default.
    CROSS_PROVIDER_FALLBACK: data.CROSS_PROVIDER_FALLBACK,
    LiveRoutingName: data.LiveRoutingName,
    // Guarantee every persona carries a stable uuid `id` (the key the URL
    // and Router.persona reference). The server's boot migration backfills
    // ids on disk; this is the defensive UI mirror for any persona that
    // still arrives without one.
    Personas: Array.isArray(data.Personas)
      ? data.Personas.map((persona) => ({
          id: typeof persona.id === 'string' && persona.id !== '' ? persona.id : crypto.randomUUID(),
          name: persona.name,
          prompt: persona.prompt
        }))
      : []
  }
}

// A fresh, unassigned route target for the empty-config literal.
const emptyRouteTarget = (): RouteTargetForm => ({ primary: null, fallbacks: [], rules: [] })

const emptyConfig = (): Config => ({
  LOG: false,
  LOG_LEVEL: 'info',
  CLAUDE_PATH: '',
  HOST: '127.0.0.1',
  PORT: 3456,
  APIKEY: '',
  API_TIMEOUT_MS: 600000,
  PROXY_URL: '',
  Providers: [],
  StatusLine: undefined,
  Router: {
    default: { agent: emptyRouteTarget(), subagent: emptyRouteTarget() },
    think: { agent: emptyRouteTarget(), subagent: emptyRouteTarget() },
    longContext: { agent: emptyRouteTarget(), subagent: emptyRouteTarget(), threshold: null },
    webSearch: { agent: emptyRouteTarget(), subagent: emptyRouteTarget() },
    image: { agent: emptyRouteTarget(), subagent: emptyRouteTarget() },
    persona: undefined
  },
  CUSTOM_ROUTER_PATH: '',
  Personas: []
})

export function ConfigProvider({ children }: ConfigProviderProps) {
  const { t } = useTranslation()
  const [config, setConfig] = useState<Config | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [hasFetched, setHasFetched] = useState<boolean>(false)
  const [authFailed, setAuthFailed] = useState<boolean>(false)
  const [apiKey, setApiKey] = useState<string | null>(localStorage.getItem('apiKey'))

  // Listen for localStorage changes
  useEffect(() => {
    const handleStorageChange = () => {
      setApiKey(localStorage.getItem('apiKey'))
    }

    window.addEventListener('storage', handleStorageChange)
    return () => {
      window.removeEventListener('storage', handleStorageChange)
    }
  }, [])

  useEffect(() => {
    // Nothing here is async — this only resets fetch state so the effect
    // below re-runs for the new key. It used to be wrapped in an async
    // function and called as a floating promise, which read as if it
    // awaited something.
    setHasFetched(false)
    setConfig(null)
    setError(null)
    setAuthFailed(false)
  }, [apiKey])

  // api.ts strips the stored key and emits this on an auth failure.
  // The 401 path never resolves the fetch (config stays null), so this
  // is what releases the loading gate below and lets the router show
  // /access-denied.
  useEffect(() => {
    const onUnauthorized = () => setAuthFailed(true)
    window.addEventListener('unauthorized', onUnauthorized)
    return () => window.removeEventListener('unauthorized', onUnauthorized)
  }, [])

  const reloadConfig = useCallback(async () => {
    try {
      const data = await api.getConfig()
      setConfig(normalizeConfig(data))
      setError(null)
    } catch (err: unknown) {
      console.error('Failed to fetch config:', err)
      // A 401 is handled by the 'unauthorized' event below, which flips
      // authFailed so ProtectedRoute can route to /access-denied. Anything
      // else is a real failure worth showing, so it lands in `error` with
      // an empty config behind it rather than leaving the app on the
      // loading gate forever.
      const failure = err instanceof Error ? err : new Error(String(err))
      if (failure.message !== 'Unauthorized') {
        setConfig(emptyConfig())
        setError(failure)
      }
    }
  }, [])

  useEffect(() => {
    const fetchConfig = async () => {
      // Prevent duplicate API calls in React StrictMode
      // Skip if we've already fetched
      if (hasFetched) {
        return
      }
      setHasFetched(true)
      await reloadConfig()
    }

    // Deliberately not awaited: an effect cannot be async, and this cannot
    // reject — reloadConfig catches everything and reports through `error`
    // / `authFailed`. `void` says that rather than leaving a bare call that
    // reads like an oversight.
    void fetchConfig()
  }, [hasFetched, apiKey, reloadConfig])

  // Hold the whole app on a single loading screen until the first
  // config fetch settles, so no page ever renders against a null or
  // half-loaded config. On auth failure authFailed flips (above) so
  // the router can still reach /access-denied.
  if (config === null && error === null && !authFailed) {
    return (
      <div className='h-screen bg-background font-sans flex items-center justify-center'>
        <div className='text-muted-foreground'>{t('common.loading')}</div>
      </div>
    )
  }

  // The config fetch failed for a reason that is not authentication —
  // the server is down, or the browser cannot reach it. Every screen
  // below would render an empty shell and blame itself, so show the
  // state that explains it instead. It keeps probing, so the app comes
  // back on its own once the server does.
  if (error !== null && !authFailed) {
    // The screen polls /health and calls this once the server answers, so
    // the app comes back on its own instead of stopping at green dots.
    return <ApiUnreachableScreen onRecovered={() => void reloadConfig()} />
  }

  return (
    <ConfigContext.Provider value={{ config, setConfig, reloadConfig, error, authFailed }}>
      {children}
    </ConfigContext.Provider>
  )
}
