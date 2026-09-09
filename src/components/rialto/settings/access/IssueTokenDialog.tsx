/**
 * Issue form, as a dialog over the list.
 *
 * A dialog rather than the inline panel this used to be: naming a token
 * is a decision made against the ones that already exist — "MacBook —
 * Claude Code" being taken is exactly what you need to see while typing
 * it — and an inline form pushed that list off the page to ask. Issuing
 * is also discrete and cancellable, which is what a modal is for; the
 * rest of the screen is not what you are answering.
 *
 * Surface and profile are the reason per-client tokens exist at all — a
 * token pinned to `/v1/chat/completions` on `cost-first` is how one
 * client gets its own routing without a second config axis — so both are
 * first-class fields here rather than an advanced disclosure. Both lists
 * come from the server (`/api/inbound-surfaces`,
 * `/api/router-preferences/profiles`); nothing about them is hardcoded.
 */
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { RButton } from '@/components/rialto/primitives'
import { ANY, Picker, SurfacePicker } from '@/components/rialto/settings/access/pickers'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { InboundSurfaceWire } from '@/lib/api'
import { EXPIRY_CHOICES } from '@/lib/rialto/settings/access-tokens'

export interface IssueDraft {
  name: string
  /** Empty selects every surface, which is what the wire's empty list means. */
  surfaces: string[]
  profileKey: string
  expiry: string
}

export const emptyDraft = (): IssueDraft => ({ name: '', surfaces: [], profileKey: ANY, expiry: 'never' })

/**
 * A labelled field, stacked.
 *
 * `SettingsField`'s 14rem/1fr grid cannot survive a 28rem panel, and it
 * was never the dialog's shape anyway — the same stack ReplaceKeyDialog
 * already uses, so the two dialogs in this app agree on what a field
 * looks like.
 */
function Field({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div>
      <div className='mb-1 text-[12px] text-muted-foreground'>{label}</div>
      {children}
      <p className='mt-1 text-[12px] leading-snug text-muted-foreground'>{hint}</p>
    </div>
  )
}

export function IssueTokenDialog({
  draft,
  surfaces,
  profiles,
  issuing,
  onChange,
  onSubmit,
  onCancel
}: {
  draft: IssueDraft
  surfaces: InboundSurfaceWire[]
  profiles: { key: string }[]
  issuing: boolean
  onChange: (next: IssueDraft) => void
  onSubmit: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const set = <K extends keyof IssueDraft>(key: K, value: IssueDraft[K]) => onChange({ ...draft, [key]: value })

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <DialogContent className='max-h-[calc(100vh-4rem)] overflow-y-auto sm:max-w-md'>
        <DialogHeader>
          <DialogTitle className='text-sm'>{t('settings.access.issueTitle')}</DialogTitle>
        </DialogHeader>

        <div className='space-y-3'>
          <Field label={t('settings.access.issueName')} hint={t('settings.access.issueNameHint')}>
            {/* The dialog exists to take this one value first, so the
                caret belongs here on open rather than on Radix's close
                button. */}
            <input
              autoFocus
              type='text'
              value={draft.name}
              placeholder={t('settings.access.issueNamePlaceholder')}
              onChange={(e) => set('name', e.target.value)}
              className='flex h-8 w-full items-center rounded-md border border-border bg-transparent px-3 font-mono text-xs outline-none focus:border-foreground/40'
            />
          </Field>

          <Field label={t('settings.access.issueEndpoint')} hint={t('settings.access.issueEndpointHint')}>
            <SurfacePicker
              surfaces={surfaces}
              selected={draft.surfaces}
              onChange={(next) => set('surfaces', next)}
              allLabel={t('settings.access.allEndpoints')}
            />
          </Field>

          <Field label={t('settings.access.issueProfile')} hint={t('settings.access.issueProfileHint')}>
            <Picker
              label={t('settings.access.issueProfile')}
              value={draft.profileKey}
              onChange={(v) => set('profileKey', v)}
            >
              <option value={ANY}>{t('settings.access.followEndpoint')}</option>
              {profiles.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.key}
                </option>
              ))}
            </Picker>
          </Field>

          <Field label={t('settings.access.issueExpires')} hint={t('settings.access.issueExpiresHint')}>
            <Picker label={t('settings.access.issueExpires')} value={draft.expiry} onChange={(v) => set('expiry', v)}>
              {EXPIRY_CHOICES.map((c) => (
                <option key={c.id} value={c.id}>
                  {t(c.labelKey)}
                </option>
              ))}
            </Picker>
          </Field>

          {/* Said before the button rather than after the reveal: the
              next screen is the only chance to copy the secret, and a
              warning that arrives with it is a warning that arrives too
              late to prepare for. */}
          <p className='text-[12px] leading-relaxed text-muted-foreground'>
            <i className='ri-information-line mr-1 align-[-1px]' />
            {t('settings.access.issueOnceNote')}
          </p>
        </div>

        <div className='flex flex-col-reverse gap-2 sm:flex-row sm:justify-end'>
          <RButton variant='ghost' onClick={onCancel}>
            {t('common.cancel')}
          </RButton>
          <RButton
            variant='primary'
            icon='ri-key-2-line'
            onClick={onSubmit}
            disabled={issuing || draft.name.trim().length === 0}
          >
            {t('settings.access.issueToken')}
          </RButton>
        </div>
      </DialogContent>
    </Dialog>
  )
}
