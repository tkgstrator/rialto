import { cn } from 'cn'
import { useEffect, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Pill, RButton } from '@/components/rialto/primitives'
import type { CodexDeviceStartResponse } from '@/schemas/api/oauth'
import type { OAuthKind } from './ConnectAuthStep'
import type { CatalogEntry } from './types'
import { vendorBrand } from './vendor-labels'

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
/**
 * Codex mid device-code sign-in. The code and the link are the whole
 * instruction, so they read largest; the countdown ticks its own second
 * hand locally (a `setInterval` bound to this component's lifetime) rather
 * than depending on the poll cadence, which honours a several-second
 * interval and would make the clock visibly stutter.
 */
export function DeviceCodePane({ device }: { device: CodexDeviceStartResponse }) {
  const { t } = useTranslation()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className='px-4 md:px-6 py-5'>
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
export function SubscriptionChoices({
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
      <div className='px-4 md:px-6 pt-5 pb-2'>
        <h3 className='text-sm font-semibold'>{t('providers.connect.howToAuth')}</h3>
      </div>
      <div className='grid grid-cols-1 gap-3 px-4 md:grid-cols-2 md:px-6'>
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
