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
import { useEffect, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Pill, RButton } from '@/components/rialto/primitives'
import { fmtAgo } from '@/lib/rialto/format'
import type { CodexDeviceStartResponse } from '@/schemas/api/oauth'
import type { CatalogEntry } from './types'
import { vendorBrand, vendorLabel } from './vendor-labels'

export type OAuthKind = 'claude' | 'codex'

// Permission-gated and absent over plain http; a refused copy should leave
// the screen alone rather than throw into the render tree. Mirrors the
// same one-liner in routing/PassthroughPanel.tsx.
const copyText = (text: string): void => {
  navigator.clipboard?.writeText(text).catch(() => {})
}

// mm:ss for the device-code expiry. Distinct from fmtUntil in
// lib/rialto/format.ts on purpose: that one is a compact "14m" read for a
// table cell, where dropping to the second would be noise; this countdown
// IS the second hand — a code someone is mid-typing needs to see it tick.
const fmtCountdown = (msRemaining: number): string => {
  const totalSeconds = Math.max(0, Math.round(msRemaining / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

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

function ChoiceCard({
  icon,
  title,
  body,
  selected,
  disabled,
  onClick
}: {
  icon: string
  title: string
  body: React.ReactNode
  selected: boolean
  disabled: boolean
  onClick: () => void
}) {
  const { t } = useTranslation()
  return (
    <button
      type='button'
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'rounded-md px-4 py-3 text-left transition-colors',
        selected ? 'border-2 border-foreground/40 bg-muted/40' : 'border border-border hover:bg-muted/50',
        disabled ? 'opacity-45' : ''
      )}
    >
      <div className='flex items-center gap-2'>
        <i className={cn(icon, 'text-sm', selected ? '' : 'text-muted-foreground')} />
        <span className='text-xs font-medium'>{title}</span>
        {selected ? <Pill tone='ok'>{t('providers.connect.recommended')}</Pill> : null}
      </div>
      <p className='mt-1.5 text-[12px] leading-relaxed text-muted-foreground'>{body}</p>
    </button>
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

/**
 * Codex mid device-code sign-in. The code and the link are the whole
 * instruction, so they read largest; the countdown ticks its own second
 * hand locally (a `setInterval` bound to this component's lifetime) rather
 * than depending on the poll cadence, which honours a several-second
 * interval and would make the clock visibly stutter.
 */
function DeviceCodePane({ device }: { device: CodexDeviceStartResponse }) {
  const { t } = useTranslation()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className='px-6 py-5'>
      <div className='rounded-md border border-border px-4 py-4'>
        <div className='flex items-center gap-2'>
          <i className='ri-loader-4-line text-sm text-muted-foreground' />
          <span className='text-xs font-medium'>{t('providers.connect.deviceWaitingTitle')}</span>
          <span className='ml-auto font-mono text-[12px] tabular-nums text-muted-foreground'>
            {t('providers.connect.expiresIn', { time: fmtCountdown(device.expiresAt - now) })}
          </span>
        </div>
        <p className='mt-1.5 text-[12px] leading-relaxed text-muted-foreground'>
          {t('providers.connect.deviceWaitingBody')}
        </p>
        <div className='mt-3 space-y-2 rounded-md bg-muted/50 px-3 py-3'>
          <div className='flex items-center gap-3'>
            <span className='w-10 text-[12px] text-muted-foreground'>{t('providers.connect.deviceLinkLabel')}</span>
            <span className='min-w-0 flex-1 truncate font-mono text-xs'>{device.verificationUri}</span>
            <RButton
              variant='outline'
              icon='ri-external-link-line'
              onClick={() => window.open(device.verificationUri, '_blank', 'noopener,noreferrer')}
            >
              {t('providers.connect.deviceOpen')}
            </RButton>
          </div>
          <div className='flex items-center gap-3'>
            <span className='w-10 text-[12px] text-muted-foreground'>{t('providers.connect.deviceCodeLabel')}</span>
            <span className='min-w-0 flex-1 font-mono text-base font-semibold tracking-wider'>{device.userCode}</span>
            <RButton variant='outline' icon='ri-file-copy-line' onClick={() => copyText(device.userCode)}>
              {t('providers.connect.deviceCopy')}
            </RButton>
          </div>
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

function SubscriptionChoices({
  entry,
  oauthKind,
  busy,
  onSignIn,
  onStartDevice,
  onImport
}: {
  entry: CatalogEntry
  oauthKind: OAuthKind | null
  busy: boolean
  onSignIn: () => void
  onStartDevice: () => void
  onImport: (file: File) => void
}) {
  const { t } = useTranslation()
  const fileRef = useRef<HTMLInputElement>(null)
  const brand = vendorBrand(entry.name, entry.vendor)
  const credPath = entry.credentialsPath === null ? t('providers.connect.credentialsFile') : entry.credentialsPath
  // Codex offers no browser sign-in here at all (see the module comment in
  // useConnectFlow.ts / device-code.ts): its OAuth client only redirects to
  // localhost:1455 on the BROWSER's machine, which a remote or
  // containerised install never receives. The device code needs nothing to
  // reach back, so it is the primary card instead of a fallback.
  const isCodex = oauthKind === 'codex'
  return (
    <>
      <div className='px-6 pt-5 pb-2'>
        <h3 className='text-sm font-semibold'>{t('providers.connect.howToAuth')}</h3>
      </div>
      <div className='grid grid-cols-2 gap-3 px-6'>
        <ChoiceCard
          icon={isCodex ? 'ri-keyboard-line' : 'ri-external-link-line'}
          title={isCodex ? t('providers.connect.deviceCode') : t('providers.connect.signInWith', { brand })}
          selected={oauthKind !== null}
          disabled={busy || oauthKind === null}
          onClick={isCodex ? onStartDevice : onSignIn}
          body={
            oauthKind === null ? (
              t('providers.connect.noOauthExchange', { brand })
            ) : isCodex ? (
              <Trans i18nKey='providers.connect.deviceCodeBody' components={{ mono: <span className='font-mono' /> }} />
            ) : (
              <Trans
                i18nKey='providers.connect.opensBrowser'
                values={{ brand }}
                components={{ mono: <span className='font-mono' /> }}
              />
            )
          }
        />
        <ChoiceCard
          icon='ri-folder-open-line'
          title={t('providers.connect.importFrom', {
            cli: entry.cli === null ? t('providers.connect.theCli') : entry.cli
          })}
          selected={false}
          disabled={busy || oauthKind === null}
          onClick={() => fileRef.current?.click()}
          body={
            <Trans
              i18nKey='providers.connect.importBody'
              values={{ path: credPath }}
              components={{ mono: <span className='font-mono' /> }}
            />
          }
        />
      </div>
      <input
        ref={fileRef}
        type='file'
        accept='application/json,.json'
        className='hidden'
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) onImport(file)
          e.target.value = ''
        }}
      />
    </>
  )
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
