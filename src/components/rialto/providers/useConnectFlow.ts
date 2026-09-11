/**
 * State machine behind the add-provider flow.
 *
 * The OAuth half finishes in a DIFFERENT browser tab — the vendor
 * redirects there, and the server completes the exchange without telling
 * this page. So the page watches for the account to appear instead: it
 * snapshots the provider's account ids before opening the tab and polls
 * /subscriptions until an unfamiliar one shows up. That is what lets the
 * step advance "on its own" rather than asking the operator to refresh.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import dayjs from '@/lib/dayjs'
import type { CodexDeviceStartResponse } from '@/schemas/api/oauth'
import type { AuthFailure } from './ConnectAuthStep'
import {
  ensureProvider,
  importCredentials,
  oauthKindOf,
  pollCodexDevice,
  saveNewApiKey,
  startCodexDevice,
  startOAuth,
  submitManualCallback
} from './connect-actions'
import type { CatalogEntry } from './types'
import type { ProvidersData } from './useProvidersData'
import { vendorBrand } from './vendor-labels'

const POLL_MS = 3_000

export type ConnectStep = 1 | 2 | 3

export type ConnectFlow = ReturnType<typeof useConnectFlow>

export function useConnectFlow(data: ProvidersData | null, reload: () => Promise<void>) {
  const { t } = useTranslation()
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [step, setStep] = useState<ConnectStep>(1)
  const [pending, setPending] = useState(false)
  const [baseline, setBaseline] = useState<ReadonlySet<string>>(new Set())
  const [manualUrl, setManualUrl] = useState('')
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [device, setDevice] = useState<CodexDeviceStartResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [sessionError, setSessionError] = useState<string | null>(null)

  const entry = data === null || selectedName === null ? undefined : data.catalog.find((e) => e.name === selectedName)
  const provider =
    data === null || selectedName === null ? undefined : data.providers.find((p) => p.name === selectedName)
  const subscription = data === null || selectedName === null ? undefined : data.subscriptions.get(selectedName)
  const oauthKind = entry === undefined ? null : oauthKindOf(entry)
  // Brand name for the success notices. Falls back to the catalog name so
  // a vendor this build has no label for still names itself rather than
  // announcing an empty string.
  const brand = entry !== undefined ? vendorBrand(entry.name, entry.vendor) : selectedName === null ? '' : selectedName

  // Re-read while an exchange is outstanding; the completing tab has no
  // channel back to this one.
  useEffect(() => {
    if (!pending) return
    const timer = setInterval(() => {
      reload().catch(() => {
        // A dropped poll is not a flow failure — the next tick retries.
      })
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [pending, reload])

  useEffect(() => {
    if (!pending || subscription === undefined) return
    if (subscription.accounts.some((a) => !baseline.has(a.id))) {
      setPending(false)
      setStep(3)
      // The exchange finished in a DIFFERENT tab, so this poll is the only
      // moment this page can say it worked. The step bar advancing is easy
      // to miss when the operator's eye is still on the tab that just
      // closed — which is how a successful sign-in reads as a silent one.
      toast.success(t('providers.connect.connected', { brand }))
    }
  }, [pending, subscription, baseline, brand, t])

  // Client-driven polling of an outstanding Codex device-code flow. Each
  // tick makes at most one request to the server, which itself makes at
  // most one upstream poll per flow interval (device-flow-store.ts) — this
  // effect just has to honour the SAME interval on its own side so a tab
  // polling faster never happens. The timer is scoped to `device`, so it
  // clears itself the moment the flow ends (connected / expired / error)
  // or the tab navigates away — no orphan timer outlives the component.
  useEffect(() => {
    if (device === null) return
    // A poll can outlast the interval (the server stores the account before
    // it answers `connected`), so a tick never starts while one is on the
    // wire, and nothing a poll answers is applied once the effect is gone.
    const inFlight = { current: false }
    const live = { current: true }
    const connected = async (): Promise<void> => {
      setDevice(null)
      await reload().catch(() => {
        // The account is connected either way; a dropped reload here
        // just means step 3 renders once the next one lands.
      })
      setStep(3)
      toast.success(t('providers.connect.connected', { brand }))
    }
    const ended = (message: string): void => {
      setDevice(null)
      setSessionError(message)
    }
    const tick = async (): Promise<void> => {
      const result = await pollCodexDevice(device.flowId).catch((e: unknown) => {
        if (live.current) ended(e instanceof Error ? e.message : t('providers.connect.errorRequest'))
        return null
      })
      if (result === null || !live.current || result.status === 'pending') return
      if (result.status === 'expired') ended(t('providers.connect.deviceExpired'))
      else await connected()
    }
    const timer = setInterval(() => {
      if (inFlight.current) return
      inFlight.current = true
      tick()
        .catch(() => {
          // tick() handles its own errors; this only guards setInterval
          // against seeing a rejected promise.
        })
        .finally(() => {
          inFlight.current = false
        })
    }, device.intervalSeconds * 1000)
    return () => {
      live.current = false
      clearInterval(timer)
    }
  }, [device, reload, brand, t])

  const guard = useCallback(
    async (work: () => Promise<void>) => {
      setBusy(true)
      setSessionError(null)
      try {
        await work()
      } catch (e) {
        setSessionError(e instanceof Error ? e.message : t('providers.connect.errorRequest'))
      } finally {
        setBusy(false)
      }
    },
    [t]
  )

  const selectVendor = useCallback((next: CatalogEntry) => {
    setSelectedName(next.name)
    setStep(2)
    setPending(false)
    setManualUrl('')
    setApiKeyDraft('')
    setDevice(null)
    setSessionError(null)
  }, [])

  const signIn = useCallback(() => {
    if (entry === undefined || oauthKind === null) return
    guard(async () => {
      // The row has to exist first, or the callback drops the account.
      await ensureProvider(entry)
      await reload()
      setBaseline(new Set(subscription === undefined ? [] : subscription.accounts.map((a) => a.id)))
      await startOAuth(oauthKind, t)
      setPending(true)
    })
  }, [entry, oauthKind, guard, reload, subscription, t])

  // Codex's OAuth choice card: no browser tab, no loopback — ask the
  // server for a code and let the poll effect above take it from there.
  const startDevice = useCallback(() => {
    if (entry === undefined || oauthKind !== 'codex') return
    guard(async () => {
      // The row has to exist first, same reason as signIn: connecting the
      // account needs a matching Provider row to attach to.
      await ensureProvider(entry)
      const started = await startCodexDevice()
      setDevice(started)
    })
  }, [entry, oauthKind, guard])

  const importFile = useCallback(
    (file: File) => {
      if (entry === undefined || oauthKind === null) return
      guard(async () => {
        await ensureProvider(entry)
        await importCredentials(oauthKind, file, t)
        // Closed BEFORE the reload lands, not after: the poll effect above
        // announces any account it has not seen before, and reload()
        // resolves its own state update first — leaving `pending` true
        // across that render would toast the same success twice.
        setPending(false)
        setDevice(null)
        await reload()
        setStep(3)
        toast.success(t('providers.connect.connected', { brand }))
      })
    },
    [entry, oauthKind, guard, reload, brand, t]
  )

  const submitManual = useCallback(() => {
    guard(async () => {
      await submitManualCallback(manualUrl, t)
      // Same ordering as importFile, for the same reason.
      setPending(false)
      await reload()
      setManualUrl('')
      setStep(3)
      toast.success(t('providers.connect.connected', { brand }))
    })
  }, [manualUrl, guard, reload, brand, t])

  const saveApiKey = useCallback(() => {
    if (entry === undefined) return
    guard(async () => {
      await saveNewApiKey(entry, apiKeyDraft)
      await reload()
      setStep(3)
      toast.success(t('providers.connect.apiKeySaved', { brand }))
    })
  }, [entry, apiKeyDraft, guard, reload, brand, t])

  // An error raised in this session outranks the stored one: it describes
  // the attempt the operator just made.
  const storedFailure = ((): AuthFailure | null => {
    if (subscription === undefined) return null
    const failed = subscription.accounts.find((a) => a.authError !== null)
    if (failed === undefined || failed.authError === null) return null
    return {
      message: failed.authError,
      at: failed.authCheckedAt === null ? null : dayjs(failed.authCheckedAt).toISOString()
    }
  })()
  const failure = sessionError === null ? storedFailure : { message: sessionError, at: null }

  return {
    entry,
    provider,
    subscription,
    oauthKind,
    step,
    setStep,
    pending,
    device,
    busy,
    failure,
    manualUrl,
    setManualUrl,
    apiKeyDraft,
    setApiKeyDraft,
    selectVendor,
    signIn,
    startDevice,
    importFile,
    submitManual,
    saveApiKey
  }
}
