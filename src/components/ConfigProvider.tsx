import type { Dispatch, ReactNode, SetStateAction } from 'react'
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiUnreachableScreen } from '@/components/rialto/system/ApiUnreachable'
import { api } from '@/lib/api'
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

// Coerce the raw /api/config wire shape (which carries explicit nulls
// for unset api_key / path scalars / the active persona) into the typed
// Config the app's controlled inputs expect (non-null strings, arrays).
// Centralized so both the mount fetch and reloadConfig stay in sync.
function normalizeConfig(data: Config): Config {
  return {
    LOG: typeof data.LOG === 'boolean' ? data.LOG : false,
    LOG_LEVEL: typeof data.LOG_LEVEL === 'string' && data.LOG_LEVEL !== '' ? data.LOG_LEVEL : 'info',
    CLAUDE_PATH: typeof data.CLAUDE_PATH === 'string' ? data.CLAUDE_PATH : '',
    HOST: typeof data.HOST === 'string' ? data.HOST : '127.0.0.1',
    PORT: typeof data.PORT === 'number' ? data.PORT : 3456,
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
    // The active persona's id. Null is the wire's "none"; an empty string
    // collapses to the same so the Personas screen's Active switch never
    // has to tell the two apart.
    ActivePersona: typeof data.ActivePersona === 'string' && data.ActivePersona !== '' ? data.ActivePersona : null,
    // Guarantee every persona carries a stable uuid `id` (the key the URL
    // and ActivePersona reference). The server's boot migration backfills
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

const emptyConfig = (): Config => ({
  LOG: false,
  LOG_LEVEL: 'info',
  CLAUDE_PATH: '',
  HOST: '127.0.0.1',
  PORT: 3456,
  API_TIMEOUT_MS: 600000,
  PROXY_URL: '',
  Providers: [],
  StatusLine: undefined,
  ActivePersona: null,
  Personas: []
})

export function ConfigProvider({ children }: ConfigProviderProps) {
  const { t } = useTranslation()
  const [config, setConfig] = useState<Config | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [hasFetched, setHasFetched] = useState<boolean>(false)
  const [authFailed, setAuthFailed] = useState<boolean>(false)

  // api.ts emits this on an auth failure. The 401 path never resolves the
  // fetch (config stays null), so this is what releases the loading gate
  // below and lets the router show /access-denied.
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
  }, [hasFetched, reloadConfig])

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
