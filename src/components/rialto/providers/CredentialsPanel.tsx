/**
 * Outbound credentials for an api_key provider.
 *
 * The field is masked until the operator asks for it and only becomes
 * editable once revealed — a screenshot of this page should never carry a
 * working key, and an accidental keystroke should never silently replace
 * one either.
 */
import { useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { RButton } from '@/components/rialto/primitives'
import { maskKey } from './derive'
import type { Provider } from './types'

export function CredentialsPanel({
  provider,
  label,
  onSave
}: {
  provider: Provider
  label: string
  onSave: (key: string) => void
}) {
  const { t } = useTranslation()
  const stored = provider.api_key === null ? '' : provider.api_key
  const [revealed, setRevealed] = useState(false)
  const [draft, setDraft] = useState(stored)

  // Switching providers must not carry the previous provider's key (or a
  // half-typed edit) into the new field.
  useEffect(() => {
    setRevealed(false)
    setDraft(stored)
  }, [stored])

  const dirty = draft !== stored
  return (
    <div className='min-w-0 border-r border-border'>
      <div className='px-6 pt-5 pb-2'>
        <h3 className='text-sm font-semibold'>{t('providers.credentials.title')}</h3>
      </div>
      <div className='space-y-3 px-6 pb-5'>
        <div>
          <div className='mb-1 text-[12px] text-muted-foreground'>{t('providers.credentials.apiKey')}</div>
          <div className='flex items-center gap-2'>
            {revealed ? (
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                autoComplete='off'
                className='h-8 w-full min-w-0 flex-1 rounded-md border border-border bg-transparent px-3 font-mono text-xs outline-none focus:border-foreground/40'
              />
            ) : (
              <div className='flex h-8 min-w-0 flex-1 items-center rounded-md border border-border px-3 font-mono text-xs'>
                <span className='truncate'>{stored === '' ? t('providers.credentials.notSet') : maskKey(stored)}</span>
              </div>
            )}
            <RButton
              variant='ghost'
              icon={revealed ? 'ri-eye-off-line' : 'ri-eye-line'}
              onClick={() => setRevealed(!revealed)}
            >
              {revealed ? t('providers.credentials.hide') : t('providers.credentials.reveal')}
            </RButton>
            {dirty ? (
              <RButton variant='primary' icon='ri-check-line' onClick={() => onSave(draft)}>
                {t('common.save')}
              </RButton>
            ) : null}
          </div>
        </div>
        <div>
          <div className='mb-1 text-[12px] text-muted-foreground'>{t('providers.credentials.baseUrl')}</div>
          {/* A long base URL must not wrap out of the h-8 box or widen the
              column: clip it and keep the whole value on hover. */}
          <div className='flex h-8 min-w-0 items-center rounded-md border border-border px-3 font-mono text-xs'>
            <span className='truncate' title={provider.api_base_url}>
              {provider.api_base_url}
            </span>
          </div>
        </div>
        <p className='text-[12px] leading-relaxed text-muted-foreground'>
          <Trans
            i18nKey='providers.credentials.interpolationNote'
            components={{ mono: <span className='font-mono' /> }}
          />
        </p>
        <p className='text-[12px] leading-relaxed text-muted-foreground'>
          <Trans
            i18nKey='providers.credentials.outboundNote'
            values={{ label }}
            components={{
              strong: <span className='font-medium text-foreground' />,
              tokens: <Link to='/settings/access' className='underline underline-offset-2' />
            }}
          />
        </p>
      </div>
    </div>
  )
}
