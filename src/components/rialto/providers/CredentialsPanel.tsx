/**
 * Outbound credentials for an api_key provider.
 *
 * Read-only, which is the whole design: a screenshot of this page should
 * never carry a working key, and no keystroke landing on this screen
 * should ever replace one. Reveal shows the value and nothing more.
 *
 * The field used to turn into an editable input the moment it was
 * revealed, so "let me check which key is configured" and "let me change
 * the key" were the same control one keystroke apart. Changing a key is
 * rare and consequential — it now goes through ReplaceKeyDialog, which
 * cannot be entered by accident and states what it is about to do.
 */
import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { RButton } from '@/components/rialto/primitives'
import { maskKey } from './derive'
import { ReplaceKeyDialog } from './ReplaceKeyDialog'
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
  const [replacing, setReplacing] = useState(false)

  // Re-mask after a replacement: whatever the operator was looking at is
  // not the stored key any more, and leaving the box open would show the
  // new one without anybody asking for it. Switching providers is
  // already covered upstream — ProviderDetail keys this component on the
  // provider name, so a different provider is a different mount.
  const replace = (key: string) => {
    setRevealed(false)
    onSave(key)
  }

  return (
    <div className='min-w-0 border-r border-border'>
      <div className='px-6 pt-5 pb-2'>
        <h3 className='text-sm font-semibold'>{t('providers.credentials.title')}</h3>
      </div>
      <div className='space-y-3 px-6 pb-5'>
        <div>
          <div className='mb-1 text-[12px] text-muted-foreground'>{t('providers.credentials.apiKey')}</div>
          <div className='flex items-center gap-2'>
            <div className='flex h-8 min-w-0 flex-1 items-center rounded-md border border-border px-3 font-mono text-xs'>
              <span className='truncate'>
                {stored === '' ? t('providers.credentials.notSet') : revealed ? stored : maskKey(stored)}
              </span>
            </div>
            <RButton
              variant='ghost'
              icon={revealed ? 'ri-eye-off-line' : 'ri-eye-line'}
              onClick={() => setRevealed(!revealed)}
              disabled={stored === ''}
            >
              {revealed ? t('providers.credentials.hide') : t('providers.credentials.reveal')}
            </RButton>
            <RButton variant='outline' icon='ri-refresh-line' onClick={() => setReplacing(true)}>
              {stored === '' ? t('providers.credentials.setKey') : t('providers.credentials.replace')}
            </RButton>
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
      <ReplaceKeyDialog open={replacing} current={stored} onOpenChange={setReplacing} onReplace={replace} />
    </div>
  )
}
