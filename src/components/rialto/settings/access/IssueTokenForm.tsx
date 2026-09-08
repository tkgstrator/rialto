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
import { SettingsField } from '@/components/rialto/settings/SettingsLayout'
import type { InboundSurfaceWire } from '@/lib/api'
import { EXPIRY_CHOICES } from '@/lib/rialto/settings/access-tokens'

export interface IssueDraft {
  name: string
  surface: string
  profileKey: string
  expiry: string
}

/** Sentinel for the "not scoped" option — the wire sends null for these. */
export const ANY = ''

export const emptyDraft = (): IssueDraft => ({ name: '', surface: ANY, profileKey: ANY, expiry: 'never' })

const SELECT_CLASS =
  'inline-flex h-8 w-full max-w-md appearance-none items-center rounded-md border border-border bg-transparent pl-3 pr-8 font-mono text-xs transition-colors hover:bg-muted/60'

function Picker({
  label,
  value,
  onChange,
  children
}: {
  label: string
  value: string
  onChange: (next: string) => void
  children: React.ReactNode
}) {
  return (
    <div className='relative inline-flex w-full max-w-md'>
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className={SELECT_CLASS}>
        {children}
      </select>
      <i className='ri-arrow-down-s-line pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground' />
    </div>
  )
}

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
        <Picker label={t('settings.access.issueEndpoint')} value={draft.surface} onChange={(v) => set('surface', v)}>
          <option value={ANY}>{t('settings.access.allEndpoints')}</option>
          {surfaces.map((s) => (
            <option key={s.id} value={s.id}>
              {s.path}
            </option>
          ))}
        </Picker>
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
