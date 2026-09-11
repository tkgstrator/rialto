/**
 * Add provider — one three-step page.
 *
 * Absorbs ConnectChoiceDialog + ProviderConnectFlow + ImportCredentialsDialog
 * + ManualCallbackDialog + ManageProvidersDialog: four dialogs that chained
 * into each other, which is the wrong shape for a flow that branches and
 * that fails often enough to need its failure on screen.
 */
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { RButton } from '@/components/rialto/primitives'
import { Screen } from '@/components/rialto/Screen'
import { enableAllModels, setModelEffort, setModelTier, testModels, toggleModel } from './actions'
import { ConnectAuthStep } from './ConnectAuthStep'
import { ConnectModelsStep } from './ConnectModelsStep'
import { ConnectStepBar } from './ConnectStepBar'
import { ConnectVendorRail } from './ConnectVendorRail'
import { enableProvider } from './connect-actions'
import { accountLabel, disabledModelsOf, listedModelsOf } from './derive'
import { type ConnectFlow, type ConnectStep, useConnectFlow } from './useConnectFlow'
import { useProvidersData } from './useProvidersData'
import { vendorLabel } from './vendor-labels'

const NEXT_STEP: Record<ConnectStep, ConnectStep> = { 1: 2, 2: 3, 3: 3 }
const PREV_STEP: Record<ConnectStep, ConnectStep> = { 1: 1, 2: 1, 3: 2 }

/**
 * Step 3's writes sit outside `useConnectFlow`'s guard, so they have no
 * inline failure card to land in — the card belongs to the auth step. A
 * toast is the only surface left, and it is needed: both actions here fail
 * by leaving the screen exactly as it was.
 */
const fail = (err: unknown): void => {
  toast.error(err instanceof Error ? err.message : String(err))
}

function ConnectPane({ flow, now, reload }: { flow: ConnectFlow; now: number; reload: () => Promise<void> }) {
  const { t } = useTranslation()
  const { entry, provider } = flow
  // Local to step 3: Enable all and Test all are each one write (or a
  // sequential run of them for Test all), and disabling the two buttons
  // for that stretch is enough to stop a double-click from overlapping two
  // runs. Nothing else on this step needs it — the per-row toggle / tier /
  // effort writes are small enough to leave unguarded, same as before.
  const [bulkBusy, setBulkBusy] = useState(false)
  if (entry === undefined) {
    return <div className='min-w-0 px-6 py-6 text-xs text-muted-foreground'>{t('providers.connect.pickVendor')}</div>
  }
  if (flow.step === 3) {
    // A live account over any other: the pill and the confirmation line
    // are meant to say "this is who you just signed in as", and a `live`
    // probe is the strongest evidence of that this step has.
    const accounts = flow.subscription === undefined ? [] : flow.subscription.accounts
    const liveAccount = accounts.find((a) => a.authStatus === 'live')
    const account = liveAccount === undefined ? accounts[0] : liveAccount
    const connectedAccount = account === undefined ? null : accountLabel(account)
    return (
      <ConnectModelsStep
        entry={entry}
        provider={provider}
        connectedAccount={connectedAccount}
        busy={bulkBusy}
        onToggle={(model, next) => {
          if (provider === undefined) return
          toggleModel(provider, model, next).then(reload).catch(fail)
        }}
        onTier={(model, next) => {
          if (provider === undefined) return
          setModelTier(provider, model, next).then(reload).catch(fail)
        }}
        onEffort={(model, next) => {
          if (provider === undefined) return
          setModelEffort(provider, model, next).then(reload).catch(fail)
        }}
        onEnableAll={() => {
          if (provider === undefined) return
          setBulkBusy(true)
          enableAllModels(provider)
            .then(reload)
            .catch(fail)
            .finally(() => setBulkBusy(false))
        }}
        onTestAll={() => {
          if (provider === undefined) return
          const disabled = new Set(disabledModelsOf(provider))
          const enabledModels = listedModelsOf(provider).filter((m) => !disabled.has(m))
          setBulkBusy(true)
          testModels(provider.name, enabledModels)
            .then(reload)
            .catch(fail)
            .finally(() => setBulkBusy(false))
        }}
      />
    )
  }
  return (
    <ConnectAuthStep
      entry={entry}
      oauthKind={flow.oauthKind}
      pending={flow.pending}
      device={flow.device}
      busy={flow.busy}
      failure={flow.failure}
      now={now}
      manualUrl={flow.manualUrl}
      apiKeyDraft={flow.apiKeyDraft}
      onSignIn={flow.signIn}
      onStartDevice={flow.startDevice}
      onImport={flow.importFile}
      onManualUrlChange={flow.setManualUrl}
      onSubmitManual={flow.submitManual}
      onApiKeyChange={flow.setApiKeyDraft}
      onSaveApiKey={flow.saveApiKey}
    />
  )
}

/** Step 1 needs a vendor; step 3 needs the row the earlier steps created. */
const canAdvance = (flow: ConnectFlow): boolean => {
  if (flow.step === 1) return flow.entry !== undefined
  if (flow.step === 3) return flow.provider !== undefined
  return true
}

export function AddProviderScreen() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { data, error, reload } = useProvidersData()
  const flow = useConnectFlow(data, reload)
  const { step, setStep, provider } = flow

  const cancel = useCallback(() => navigate('/providers'), [navigate])

  const back = useCallback(() => {
    if (step === 1) cancel()
    else setStep(PREV_STEP[step])
  }, [step, setStep, cancel])

  // Step 3's Continue is the only one that commits: the provider row has
  // existed since step 2 (the OAuth callback needs it) but stays switched
  // off until the operator has said which models it may serve.
  const advance = useCallback(async () => {
    if (step !== 3) {
      setStep(NEXT_STEP[step])
      return
    }
    if (provider === undefined) return
    try {
      await enableProvider(provider)
    } catch (err: unknown) {
      fail(err)
      return
    }
    navigate(`/providers/${encodeURIComponent(provider.name)}`)
  }, [step, setStep, provider, navigate])

  const subtitle =
    flow.entry === undefined
      ? t('providers.connect.stepOf', { step })
      : t('providers.connect.stepOfVendor', {
          step,
          vendor: vendorLabel(flow.entry.name, flow.entry.displayName)
        })

  return (
    <Screen
      crumbs={[{ label: t('providers.connect.title') }]}
      subtitle={subtitle}
      actions={
        <>
          <RButton variant='ghost' icon='ri-arrow-left-line' onClick={back}>
            {t('common.back')}
          </RButton>
          <RButton
            variant='primary'
            icon='ri-arrow-right-line'
            onClick={advance}
            disabled={!canAdvance(flow) || flow.busy}
          >
            {t(step === 3 ? 'providers.connect.finish' : 'common.continue')}
          </RButton>
        </>
      }
    >
      <ConnectStepBar current={step} onCancel={cancel} />
      {error !== null ? (
        <div className='px-6 py-6 text-xs text-destructive'>{error}</div>
      ) : data === null ? (
        <div className='px-6 py-6 text-xs text-muted-foreground'>{t('common.loading')}</div>
      ) : (
        <div className='grid h-full grid-cols-[22rem_1fr]'>
          <ConnectVendorRail
            entries={data.catalog}
            selectedName={flow.entry === undefined ? null : flow.entry.name}
            onSelect={flow.selectVendor}
          />
          <ConnectPane flow={flow} now={data.now} reload={reload} />
        </div>
      )}
    </Screen>
  )
}
