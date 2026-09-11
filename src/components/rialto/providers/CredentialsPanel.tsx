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
 *
 * Replace only exists while the page is in Edit, and what it takes is
 * staged with the rest of the edit: Save writes the key, Revert drops it.
 */
import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { RButton } from '@/components/rialto/primitives'
import { maskKeyParts } from './derive'
import { ReplaceKeyDialog } from './ReplaceKeyDialog'
import type { Provider } from './types'

/** The masked key, clipped in the middle rather than at the end. */
function MaskedKey({ value }: { value: string }) {
  const { head, bullets, tail } = maskKeyParts(value)
  return (
    <span className='flex min-w-0 items-center'>
      <span className='shrink-0'>{head}</span>
      <span className='min-w-0 overflow-hidden text-ellipsis'>{bullets}</span>
      <span className='shrink-0'>{tail}</span>
    </span>
  )
}

export function CredentialsPanel({
  provider,
  label,
  editing,
  onReplace
}: {
  /** As Save would leave it, so a staged replacement shows here like a stored key. */
  provider: Provider
  label: string
  editing: boolean
  /** Stages a replacement; nothing is written until the page's Save. */
  onReplace: (key: string) => void
}) {
  const { t } = useTranslation()
  const current = provider.api_key === null ? '' : provider.api_key
  const [revealed, setRevealed] = useState(false)
  const [replacing, setReplacing] = useState(false)

  // Re-mask after a replacement: whatever the operator was looking at is
  // not the key any more, and leaving the box open would show the new one
  // without anybody asking for it. Switching providers is already covered
  // upstream — ProviderDetail keys this component on the provider name, so
  // a different provider is a different mount.
  const replace = (key: string) => {
    setRevealed(false)
    onReplace(key)
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
              {current === '' ? (
                <span className='truncate'>{t('providers.credentials.notSet')}</span>
              ) : revealed ? (
                <span className='truncate'>{current}</span>
              ) : (
                // The bullets are the only part that can be dropped: the
                // prefix and the last four characters are what tell two
                // keys apart, and a plain `truncate` eats the tail first.
                <MaskedKey value={current} />
              )}
            </div>
            <RButton
              variant='ghost'
              icon={revealed ? 'ri-eye-off-line' : 'ri-eye-line'}
              onClick={() => setRevealed(!revealed)}
              disabled={current === ''}
            >
              {revealed ? t('providers.credentials.hide') : t('providers.credentials.reveal')}
            </RButton>
            {/* Invisible rather than absent while the page reads, so the
                key field keeps its width when Edit is pressed. */}
            <RButton
              variant='outline'
              icon='ri-refresh-line'
              onClick={() => setReplacing(true)}
              className={editing ? undefined : 'invisible'}
            >
              {current === '' ? t('providers.credentials.setKey') : t('providers.credentials.replace')}
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
              tokens: <Link to='/access-tokens' className='underline underline-offset-2' />
            }}
          />
        </p>
      </div>
      <ReplaceKeyDialog open={replacing} current={current} onOpenChange={setReplacing} onReplace={replace} />
    </div>
  )
}
