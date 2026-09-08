/**
 * Issue form.
 *
 * Surface and profile are the reason per-client tokens exist at all — a
 * token pinned to `/v1/chat/completions` on `cost-first` is how one
 * client gets its own routing without a second config axis — so both are
 * first-class fields here rather than an advanced disclosure. Both lists
 * come from the server (`/api/inbound-surfaces`,
 * `/api/router-preferences/profiles`); nothing about them is hardcoded.
 */
import { useTranslation } from 'react-i18next'
import { RButton } from '@/components/rialto/primitives'
import { ANY, Picker, SurfacePicker } from '@/components/rialto/settings/access/pickers'
import { SettingsField } from '@/components/rialto/settings/SettingsLayout'
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

export function IssueTokenForm({
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
    <>
      <SettingsField label={t('settings.access.issueName')} hint={t('settings.access.issueNameHint')}>
        <input
          type='text'
          value={draft.name}
          placeholder={t('settings.access.issueNamePlaceholder')}
          onChange={(e) => set('name', e.target.value)}
          className='flex h-8 w-full max-w-md items-center rounded-md border border-border bg-transparent px-3 font-mono text-xs outline-none focus:border-foreground/40'
        />
      </SettingsField>

      <SettingsField label={t('settings.access.issueEndpoint')} hint={t('settings.access.issueEndpointHint')}>
        <SurfacePicker
          surfaces={surfaces}
          selected={draft.surfaces}
          onChange={(next) => set('surfaces', next)}
          allLabel={t('settings.access.allEndpoints')}
        />
      </SettingsField>

      <SettingsField label={t('settings.access.issueProfile')} hint={t('settings.access.issueProfileHint')}>
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
      </SettingsField>

      <SettingsField label={t('settings.access.issueExpires')} hint={t('settings.access.issueExpiresHint')}>
        <Picker label={t('settings.access.issueExpires')} value={draft.expiry} onChange={(v) => set('expiry', v)}>
          {EXPIRY_CHOICES.map((c) => (
            <option key={c.id} value={c.id}>
              {t(c.labelKey)}
            </option>
          ))}
        </Picker>
      </SettingsField>

      <div className='flex items-center gap-2 border-t border-border/60 px-6 py-4'>
        <span className='text-[12px] text-muted-foreground'>{t('settings.access.issueOnceNote')}</span>
        <div className='ml-auto flex gap-2'>
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
      </div>
    </>
  )
}
