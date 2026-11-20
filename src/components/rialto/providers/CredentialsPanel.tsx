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
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RButton } from '@/components/rialto/primitives'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { isProviderBaseUrl } from '@/shared/provider-base-url'
import { maskKeyParts } from './derive'
import { ReplaceKeyDialog } from './ReplaceKeyDialog'
import type { Provider } from './types'
import { useProviderAccount } from './useProviderAccount'

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

function BaseUrlField({ url, onChange }: { url: string; onChange?: (url: string) => void }) {
  const { t } = useTranslation()
  const id = useId()
  const invalid = !isProviderBaseUrl(url.trim())
  if (onChange === undefined) {
    return (
      <Field className='gap-2'>
        <div className='text-xs font-medium'>{t('providers.credentials.baseUrl')}</div>
        <div className='flex h-8 min-w-0 items-center rounded-md border border-border px-3 font-mono text-xs'>
          <span className='truncate' title={url}>
            {url}
          </span>
        </div>
      </Field>
    )
  }
  return (
    <Field className='gap-2' data-invalid={invalid}>
      <FieldLabel htmlFor={id} className='text-xs'>
        {t('providers.credentials.baseUrl')}
      </FieldLabel>
      <Input
        id={id}
        type='url'
        className='h-8 font-mono text-xs md:text-xs'
        value={url}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${id}-error` : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {invalid ? <FieldError id={`${id}-error`}>{t('providers.credentials.invalidBaseUrl')}</FieldError> : null}
    </Field>
  )
}

export function CredentialsPanel({
  provider,
  editing,
  onReplace,
  onBaseUrlChange
}: {
  /** As Save would leave it, so a staged replacement shows here like a stored key. */
  provider: Provider
  editing: boolean
  /** Stages a replacement; nothing is written until the page's Save. */
  onReplace: (key: string) => void
  onBaseUrlChange?: (url: string) => void
}) {
  const { t } = useTranslation()
  const current = provider.api_key === null ? '' : provider.api_key
  const [revealed, setRevealed] = useState(false)
  const [replacing, setReplacing] = useState(false)
  const account = useProviderAccount(provider)

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
    // Divider and indent belong to the desktop two-column grid, as in
    // AccountsPanel.
    <div className='min-w-0 border-border md:border-r'>
      <div className='px-4 pt-5 pb-2 md:px-6'>
        <h3 className='text-sm font-semibold'>{t('providers.credentials.title')}</h3>
      </div>
      <div className='space-y-3 px-4 pb-5 md:px-6'>
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
                key field keeps its width when Edit is pressed. Absent on a
                phone, which never enters Edit and needs the width. */}
            <RButton
              variant='outline'
              icon='ri-refresh-line'
              onClick={() => setReplacing(true)}
              className={editing ? undefined : 'invisible max-md:hidden'}
            >
              {current === '' ? t('providers.credentials.setKey') : t('providers.credentials.replace')}
            </RButton>
          </div>
        </div>
        <BaseUrlField url={provider.api_base_url} onChange={editing ? onBaseUrlChange : undefined} />
        {account.workspaceId || account.organizationId || account.projectId ? (
          <dl className='space-y-2 break-all text-xs'>
            {account.projectId ? (
              <div>
                <dt className='text-muted-foreground'>{t('providers.credentials.projectId')}</dt>
                <dd className='font-mono'>{account.projectId}</dd>
              </div>
            ) : null}
            {account.workspaceId ? (
              <div>
                <dt className='text-muted-foreground'>{t('providers.credentials.workspaceId')}</dt>
                <dd className='font-mono'>{account.workspaceId}</dd>
              </div>
            ) : null}
            {account.organizationId ? (
              <div>
                <dt className='text-muted-foreground'>{t('providers.credentials.organizationId')}</dt>
                <dd className='font-mono'>{account.organizationId}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
      </div>
      <ReplaceKeyDialog open={replacing} current={current} onOpenChange={setReplacing} onReplace={replace} />
    </div>
  )
}
