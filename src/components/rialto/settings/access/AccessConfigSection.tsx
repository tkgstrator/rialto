/**
 * The two settings that turn Cloudflare Access on — and the dry run that
 * has to pass before they can be saved.
 *
 * Saving a wrong team domain or AUD rejects every browser request,
 * including the one that would let you fix it, so `POST /api/access-check`
 * is a deliberate step in this flow rather than a background call. The
 * verdict is rendered verbatim; the three outcomes it distinguishes are
 * genuinely different and flattening them to pass/fail would lose the
 * one that matters most (domain fine, audience not yet provable).
 */
import { useTranslation } from 'react-i18next'
import { Pill, RButton } from '@/components/rialto/primitives'
import { SettingsField } from '@/components/rialto/settings/SettingsLayout'
import {
  type AccessCheckResponse,
  type AccessInput,
  type CheckTone,
  checkTone
} from '@/lib/rialto/settings/access-config'

const TONE_LABEL_KEYS: Record<CheckTone, string> = {
  ok: 'settings.access.toneVerified',
  warn: 'settings.access.toneUnconfirmed',
  bad: 'settings.access.toneLockout'
}

const INPUT_CLASS =
  'flex h-8 w-full max-w-md items-center rounded-md border border-border bg-transparent px-3 font-mono text-xs outline-none focus:border-foreground/40'

function Verdict({ check }: { check: AccessCheckResponse }) {
  const { t } = useTranslation()
  const tone = checkTone(check)
  return (
    <div className='space-y-1.5'>
      <div className='flex items-center gap-2'>
        <Pill tone={tone}>{t(TONE_LABEL_KEYS[tone])}</Pill>
        {check.jwksReachable ? (
          <span className='font-mono text-[12px] text-muted-foreground'>
            {t('settings.access.signingKeys', { n: check.keyCount })}
          </span>
        ) : null}
        {check.email === null ? null : <span className='font-mono text-[12px]'>{check.email}</span>}
      </div>
      <p className='text-[12px] leading-relaxed text-muted-foreground'>{check.detail}</p>
    </div>
  )
}

export function AccessConfigSection({
  draft,
  onChange,
  check,
  checking,
  onCheck,
  stale
}: {
  draft: AccessInput
  onChange: (next: AccessInput) => void
  check: AccessCheckResponse | null
  checking: boolean
  onCheck: () => void
  /** True when the draft has moved on from what `check` was run against. */
  stale: boolean
}) {
  const { t } = useTranslation()
  const incomplete = draft.teamDomain.trim().length === 0 || draft.aud.trim().length === 0

  return (
    <>
      <SettingsField label={t('settings.access.teamDomain')} hint={t('settings.access.teamDomainHint')}>
        <input
          type='text'
          value={draft.teamDomain}
          placeholder={t('settings.access.teamDomainPlaceholder')}
          onChange={(e) => onChange({ ...draft, teamDomain: e.target.value })}
          className={INPUT_CLASS}
        />
      </SettingsField>

      <SettingsField label={t('settings.access.applicationAud')} hint={t('settings.access.applicationAudHint')}>
        <input
          type='text'
          value={draft.aud}
          placeholder={t('settings.access.audPlaceholder')}
          onChange={(e) => onChange({ ...draft, aud: e.target.value })}
          className={INPUT_CLASS}
        />
      </SettingsField>

      <SettingsField label={t('settings.access.verify')} hint={t('settings.access.verifyHint')}>
        <div className='space-y-2'>
          <div className='flex items-center gap-2'>
            <RButton variant='outline' icon='ri-shield-check-line' onClick={onCheck} disabled={checking || incomplete}>
              {t(checking ? 'settings.access.checking' : 'settings.access.checkSettings')}
            </RButton>
            {check !== null && stale ? (
              <span className='text-[12px] text-amber-600 dark:text-amber-400'>{t('settings.access.checkStale')}</span>
            ) : null}
          </div>
          {check === null ? null : <Verdict check={check} />}
        </div>
      </SettingsField>
    </>
  )
}
