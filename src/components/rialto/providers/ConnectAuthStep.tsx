/**
 * Step 2 of the add-provider flow: prove we may call the vendor.
 *
 * Two ways in for a subscription vendor. Browser OAuth is the happy path;
 * importing the CLI's existing credentials is the escape hatch for
 * headless boxes where no browser can reach the loopback callback. The
 * failure state is rendered inline rather than as a toast because this
 * flow fails often enough — expired refresh token, wrong account, no Code
 * Assist onboarding — that the reason is the only actionable part.
 */

import { cn } from 'cn'
import { Trans, useTranslation } from 'react-i18next'
import { Pill, RButton } from '@/components/rialto/primitives'
import { fmtAgo } from '@/lib/rialto/format'
import type { CodexDeviceStartResponse } from '@/schemas/api/oauth'
import { DeviceCodePane, SubscriptionChoices } from './SubscriptionAuthChoices'
import type { CatalogEntry } from './types'
import { vendorBrand, vendorLabel } from './vendor-labels'

export type OAuthKind = 'claude' | 'codex'

function VendorIntro({ entry }: { entry: CatalogEntry }) {
  const { t } = useTranslation()
  const subscription = entry.authMode === 'subscription'
  const brand = vendorBrand(entry.name, entry.vendor)
  return (
    <div className='border-b border-border px-6 py-4'>
      <div className='flex items-center gap-2'>
        <h2 className='text-sm font-semibold'>{vendorLabel(entry.name, entry.displayName)}</h2>
        {subscription ? (
          <Pill tone='info'>{t('providers.connect.pillSubscription')}</Pill>
        ) : (
          <Pill tone='mute'>{t('providers.connect.pillApiKey')}</Pill>
        )}
      </div>
      <p className='mt-1 text-[12px] leading-relaxed text-muted-foreground'>
        {subscription
          ? t('providers.connect.introSubscription', { brand })
          : t('providers.connect.introApiKey', { url: entry.apiBaseUrl, brand })}
      </p>
    </div>
  )
}

// Claude only now: Codex's equivalent "waiting" state is DeviceCodePane
// below. Codex used to share this card (browser OAuth + a manual-paste
// fallback for its pinned localhost:1455 redirect_uri), but a device code
// needs nothing pasted back — the operator types it at auth.openai.com,
// not into Rialto.
function WaitingCard({
  brand,
  manualUrl,
  onManualUrlChange,
  onSubmitManual,
  busy
}: {
  brand: string
  manualUrl: string
  onManualUrlChange: (v: string) => void
  onSubmitManual: () => void
  busy: boolean
}) {
  const { t } = useTranslation()
  return (
    <div className='px-6 py-5'>
      <div className='rounded-md border border-border px-4 py-4'>
        <div className='flex items-center gap-2'>
          <i className='ri-loader-4-line text-sm text-muted-foreground' />
          <span className='text-xs font-medium'>{t('providers.connect.waitingTitle', { brand })}</span>
        </div>
        <p className='mt-1.5 text-[12px] leading-relaxed text-muted-foreground'>{t('providers.connect.waitingBody')}</p>
        <div className='mt-3 rounded-md bg-muted/50 px-3 py-2'>
          <div className='text-[12px] text-muted-foreground'>{t('providers.connect.pasteRedirect')}</div>
          <div className='mt-1.5 flex items-center gap-2'>
            <input
              value={manualUrl}
              onChange={(e) => onManualUrlChange(e.target.value)}
              placeholder={t('providers.connect.redirectPlaceholder')}
              spellCheck={false}
              className='h-8 flex-1 rounded-md border border-border bg-background px-3 font-mono text-[12px] text-muted-foreground outline-none focus:text-foreground'
            />
            <RButton variant='outline' onClick={onSubmitManual} disabled={busy || manualUrl.trim() === ''}>
              {t('providers.connect.submit')}
            </RButton>
          </div>
          <p className='mt-1.5 text-[12px] leading-relaxed text-muted-foreground'>
            {t('providers.connect.pasteRedirectHint')}
          </p>
        </div>
      </div>
    </div>
  )
}

export interface AuthFailure {
  message: string
  /** ISO instant, or null for an error raised in this session. */
  at: string | null
}

function FailureCard({ failure, now, flush }: { failure: AuthFailure; now: number; flush: boolean }) {
  const { t } = useTranslation()
  return (
    // The mock only draws this card under the waiting card, whose py-5 is
    // the gap between them. `flush` is the other case — straight under the
    // choice grid, which ends with no padding — so the card brings its own.
    <div className={cn('px-6 pb-6', flush ? 'pt-5' : '')}>
      <div className='rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3'>
        <div className='flex items-center gap-2'>
          <i className='ri-error-warning-line text-sm text-destructive' />
          <span className='text-xs font-medium'>{t('providers.connect.failureTitle')}</span>
          {failure.at === null ? null : (
            <span className='ml-auto text-[12px] text-muted-foreground'>
              {t('providers.connect.failureAgo', { ago: fmtAgo(failure.at, now) })}
            </span>
          )}
        </div>
        <p className='mt-1.5 font-mono text-[12px] leading-relaxed text-muted-foreground'>{failure.message}</p>
      </div>
    </div>
  )
}

function ApiKeyForm({
  entry,
  value,
  onChange,
  onSave,
  busy
}: {
  entry: CatalogEntry
  value: string
  onChange: (v: string) => void
  onSave: () => void
  busy: boolean
}) {
  const { t } = useTranslation()
  return (
    <>
      <div className='px-6 pt-5 pb-2'>
        <h3 className='text-sm font-semibold'>{t('providers.connect.howToAuth')}</h3>
      </div>
      <div className='space-y-3 px-6 pb-5'>
        <div>
          <div className='mb-1 text-[12px] text-muted-foreground'>{t('providers.credentials.apiKey')}</div>
          <div className='flex items-center gap-2'>
            <input
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder={t('providers.connect.keyFor', { brand: vendorBrand(entry.name, entry.vendor) })}
              spellCheck={false}
              autoComplete='off'
              className='h-8 flex-1 rounded-md border border-border bg-transparent px-3 font-mono text-xs outline-none focus:border-foreground/40'
            />
            <RButton variant='primary' icon='ri-check-line' onClick={onSave} disabled={busy || value.trim() === ''}>
              {t('providers.connect.saveKey')}
            </RButton>
          </div>
        </div>
        <div>
          <div className='mb-1 text-[12px] text-muted-foreground'>{t('providers.credentials.baseUrl')}</div>
          <div className='flex h-8 items-center rounded-md border border-border px-3 font-mono text-xs'>
            {entry.apiBaseUrl}
          </div>
        </div>
        <p className='text-[12px] leading-relaxed text-muted-foreground'>
          <Trans
            i18nKey='providers.credentials.interpolationNote'
            components={{ mono: <span className='font-mono' /> }}
          />
        </p>
      </div>
    </>
  )
}

export interface ConnectAuthStepProps {
  entry: CatalogEntry
  /** Which OAuth exchange the server can run for this vendor; null when none. */
  oauthKind: OAuthKind | null
  pending: boolean
  /** Codex's device-code flow, while one is outstanding; null otherwise. */
  device: CodexDeviceStartResponse | null
  busy: boolean
  failure: AuthFailure | null
  now: number
  manualUrl: string
  apiKeyDraft: string
  onSignIn: () => void
  onStartDevice: () => void
  onImport: (file: File) => void
  onManualUrlChange: (v: string) => void
  onSubmitManual: () => void
  onApiKeyChange: (v: string) => void
  onSaveApiKey: () => void
}

export function ConnectAuthStep(props: ConnectAuthStepProps) {
  const { entry, oauthKind, failure } = props
  const subscription = entry.authMode === 'subscription'
  // Named rather than "the vendor": WaitingCard is the one line an operator
  // reads while a browser tab is off doing the actual sign-in, and every
  // other status text in this step (signInWith, keyFor, the toasts) already
  // names the brand — leaving this one generic read as a placeholder nobody
  // filled in.
  const brand = vendorBrand(entry.name, entry.vendor)
  const waiting = props.pending && oauthKind === 'claude'
  const deviceShown = oauthKind === 'codex' && props.device !== null
  return (
    <div className='min-w-0 overflow-y-auto'>
      <VendorIntro entry={entry} />
      {subscription ? (
        <SubscriptionChoices
          entry={entry}
          oauthKind={oauthKind}
          busy={props.busy}
          onSignIn={props.onSignIn}
          onStartDevice={props.onStartDevice}
          onImport={props.onImport}
        />
      ) : (
        <ApiKeyForm
          entry={entry}
          value={props.apiKeyDraft}
          onChange={props.onApiKeyChange}
          onSave={props.onSaveApiKey}
          busy={props.busy}
        />
      )}
      {waiting ? (
        <WaitingCard
          brand={brand}
          manualUrl={props.manualUrl}
          onManualUrlChange={props.onManualUrlChange}
          onSubmitManual={props.onSubmitManual}
          busy={props.busy}
        />
      ) : null}
      {props.device !== null && deviceShown ? <DeviceCodePane device={props.device} /> : null}
      {failure === null ? null : (
        <FailureCard failure={failure} now={props.now} flush={subscription && !waiting && !deviceShown} />
      )}
      <div className='h-6' />
    </div>
  )
}
