/**
 * Settings → Access. Who is allowed to reach Rialto, and with what.
 *
 * Two independent gates, and the screen's job is to make it obvious
 * which one is actually load-bearing:
 *
 *   /api/*  — Cloudflare Access when ACCESS_TEAM_DOMAIN + ACCESS_AUD are
 *             set (the assertion is verified against the team JWKS
 *             before any handler runs), otherwise the bootstrap token
 *             alone.
 *   /v1/*   — per-client access tokens, and only those: the bootstrap
 *             token is deliberately refused here, so a leaked master
 *             key cannot spend the subscription unattributably. This
 *             path has to be a Bypass app at the edge, because Claude
 *             Code, Codex and Gemini CLI cannot complete an interactive
 *             Access login. No tokens issued means no proxying at all.
 *
 * `accessConfigured: false` on a deployment reachable from the internet
 * means one shared secret is the only thing in front of the admin API,
 * so it is stated at the top of the page rather than inferred from a
 * missing pill.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Pill, RButton } from '@/components/rialto/primitives'
import { AccessConfigSection } from '@/components/rialto/settings/access/AccessConfigSection'
import { AccessTokensSection } from '@/components/rialto/settings/access/AccessTokensSection'
import { GuardsCard } from '@/components/rialto/settings/access/GuardsCard'
import { SectionHead } from '@/components/rialto/settings/fields'
import { SettingsField, SettingsLayout } from '@/components/rialto/settings/SettingsLayout'
import { api, type IdentityResponse, type InboundSurfaceWire } from '@/lib/api'
import {
  type AccessCheckResponse,
  type AccessInput,
  accessSaveGate,
  normalizeAccessInput,
  sameAccessInput
} from '@/lib/rialto/settings/access-config'
import { type EnvelopeWire, SECRET_MASK } from '@/lib/rialto/settings/envelope'

const ZERO_TRUST_URL = 'https://one.dash.cloudflare.com/'

// Three ways in, and they are not interchangeable. Reporting a local
// request as "bootstrap token" claimed a credential had been checked
// when none was presented at all.
const VIA = {
  cloudflare_access: {
    icon: 'ri-shield-check-line text-sm text-emerald-600 dark:text-emerald-400',
    fallbackKey: 'settings.access.viaVerifiedIdentity',
    pillTone: 'ok',
    pillKey: 'settings.access.pillVerified'
  },
  local: {
    icon: 'ri-computer-line text-sm text-muted-foreground',
    fallbackKey: 'settings.access.viaThisMachine',
    pillTone: 'mute',
    pillKey: 'settings.access.pillNoCredential'
  },
  token: {
    icon: 'ri-key-2-line text-sm text-muted-foreground',
    fallbackKey: 'settings.access.viaBootstrapToken',
    pillTone: 'mute',
    pillKey: 'settings.access.pillNoIdentity'
  }
} as const

function SignedInAs({ identity }: { identity: IdentityResponse | null }) {
  const { t } = useTranslation()
  if (identity === null)
    return <span className='text-[12px] text-muted-foreground'>{t('settings.access.checking')}</span>

  const via = VIA[identity.mode]
  return (
    <div className='flex items-center gap-2'>
      <i className={via.icon} />
      <span className='font-mono text-xs'>{identity.email === null ? t(via.fallbackKey) : identity.email}</span>
      <Pill tone={via.pillTone}>{t(via.pillKey)}</Pill>
    </div>
  )
}

/**
 * The exposure statement.
 *
 * One line by design: the mock has nothing in this position, so a block
 * here displaces the whole page. The sentence that earns the space is
 * "anyone holding it has full administrative control" — what that covers
 * is spelled out in the guards card below.
 */
function ExposureNotice({ identity }: { identity: IdentityResponse }) {
  if (identity.accessConfigured) return null
  return (
    <div className='px-6 pt-1 pb-3'>
      <div className='flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-2 text-[12px] leading-relaxed'>
        <i className='ri-alert-line shrink-0 text-sm text-amber-600 dark:text-amber-400' />
        <span>
          <Trans
            i18nKey='settings.access.exposureNotice'
            components={{ strong: <span className='font-medium' />, mono: <span className='font-mono' /> }}
          />
        </span>
      </div>
    </div>
  )
}

function BootstrapTokenSection({ apiKey }: { apiKey: string }) {
  const { t } = useTranslation()
  const [revealed, setRevealed] = useState(false)
  const present = apiKey.length > 0

  const copy = () => {
    navigator.clipboard
      .writeText(apiKey)
      .then(() => toast.success(t('settings.access.tokenCopied')))
      .catch(() => toast.error(t('settings.access.clipboardRefused')))
  }

  return (
    <>
      <SectionHead
        title={t('settings.access.bootstrapTitle')}
        lead={<Pill tone='mute'>{t('settings.access.envelope')}</Pill>}
        meta={t('settings.access.bootstrapMeta')}
      />
      <SettingsField label={t('settings.access.apikey')} hint={t('settings.access.apikeyHint')}>
        <div className='flex items-center gap-2'>
          <div className='flex h-8 max-w-md flex-1 items-center overflow-hidden rounded-md border border-border px-3 font-mono text-xs'>
            {!present ? t('providers.credentials.notSet') : revealed ? apiKey : SECRET_MASK}
          </div>
          <RButton
            variant='ghost'
            icon={revealed ? 'ri-eye-off-line' : 'ri-eye-line'}
            onClick={() => setRevealed(!revealed)}
            disabled={!present}
          >
            {revealed ? t('providers.credentials.hide') : t('providers.credentials.reveal')}
          </RButton>
          <RButton variant='ghost' icon='ri-file-copy-line' onClick={copy} disabled={!present}>
            {t('common.copy')}
          </RButton>
        </div>
      </SettingsField>
    </>
  )
}

function PolicyCoverage() {
  const { t } = useTranslation()
  return (
    <SettingsField label={t('settings.access.policyCoverage')} hint={t('settings.access.policyCoverageHint')}>
      <div className='space-y-2'>
        <div className='rounded-md border border-dashed border-border px-3 py-1.5 text-[12px] text-muted-foreground'>
          <i className='ri-tools-line mr-1 align-[-1px]' />
          {t('settings.access.policyListingUnavailable')}
        </div>
        <p className='text-[12px] leading-relaxed text-muted-foreground'>
          <Trans
            i18nKey='settings.access.bypassNote'
            components={{
              mono: <span className='font-mono' />,
              strong: <span className='font-medium text-foreground' />
            }}
          />
        </p>
      </div>
    </SettingsField>
  )
}

export function SettingsAccess() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [identity, setIdentity] = useState<IdentityResponse | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [surfaces, setSurfaces] = useState<InboundSurfaceWire[]>([])
  const [saved, setSaved] = useState<AccessInput | null>(null)
  const [draft, setDraft] = useState<AccessInput>({ teamDomain: '', aud: '' })
  const [check, setCheck] = useState<AccessCheckResponse | null>(null)
  // The exact input `check` was produced against. Compared rather than
  // trusted, so a pass for one domain cannot authorise saving another.
  const [checkedFor, setCheckedFor] = useState<AccessInput | null>(null)
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)

  const loadConfig = useCallback(() => {
    api
      .get<EnvelopeWire>('/config')
      .then((res) => {
        setApiKey(typeof res.APIKEY === 'string' ? res.APIKEY : '')
        const next: AccessInput = {
          teamDomain: typeof res.ACCESS_TEAM_DOMAIN === 'string' ? res.ACCESS_TEAM_DOMAIN : '',
          aud: typeof res.ACCESS_AUD === 'string' ? res.ACCESS_AUD : ''
        }
        setSaved(next)
        setDraft(next)
      })
      .catch((e: Error) => toast.error(t('settings.access.envelopeReadFailed', { message: e.message })))
  }, [t])

  const loadIdentity = useCallback(() => {
    api
      .getIdentity()
      .then(setIdentity)
      .catch((e: Error) => toast.error(t('settings.access.identityReadFailed', { message: e.message })))
  }, [t])

  useEffect(() => {
    loadIdentity()
    loadConfig()
    api
      .getInboundSurfaces()
      .then((res) => setSurfaces(res.surfaces))
      .catch(() => {
        // Scoping pickers fall back to "all endpoints", which is the
        // server's own default when surface is null.
      })
  }, [loadIdentity, loadConfig])

  // Normalised once, and used for the check, the gate and the save alike
  // — the checked string and the saved string must be the same string.
  const normalized = useMemo(() => normalizeAccessInput(draft), [draft])
  const gate = accessSaveGate(normalized, check, checkedFor)
  const stale = checkedFor !== null && !sameAccessInput(normalized, checkedFor)
  const dirty = saved !== null && !sameAccessInput(normalized, normalizeAccessInput(saved))

  const runCheck = () => {
    setChecking(true)
    api
      .post<AccessCheckResponse>('/access-check', { teamDomain: normalized.teamDomain, aud: normalized.aud })
      .then((res) => {
        setCheck(res)
        setCheckedFor(normalized)
      })
      .catch((e: Error) => toast.error(t('settings.access.checkFailed', { message: e.message })))
      .finally(() => setChecking(false))
  }

  const save = () => {
    if (!gate.allowed) {
      toast.error(gate.reason)
      return
    }
    setSaving(true)
    api
      .post<{ success: boolean; message: string }>('/config', {
        ACCESS_TEAM_DOMAIN: normalized.teamDomain,
        ACCESS_AUD: normalized.aud
      })
      .then(() => {
        toast.success(t(normalized.teamDomain.length === 0 ? 'settings.access.savedOff' : 'settings.access.savedOn'))
        loadConfig()
        loadIdentity()
      })
      .catch((e: Error) => toast.error(t('settings.common.saveFailed', { message: e.message })))
      .finally(() => setSaving(false))
  }

  const discard = () => {
    if (saved !== null) setDraft(saved)
    setCheck(null)
    setCheckedFor(null)
  }

  const configured = identity?.accessConfigured === true
  const subtitle = t(configured ? 'settings.access.subtitleConfigured' : 'settings.access.subtitleUnconfigured')

  return (
    <SettingsLayout
      active='access'
      subtitle={subtitle}
      headerBadge={
        configured ? (
          <Pill tone='ok'>{t('settings.access.badgeConfigured')}</Pill>
        ) : (
          <Pill tone='bad'>{t('settings.access.badgeUnconfigured')}</Pill>
        )
      }
      headerNote={window.location.hostname}
      actions={
        <>
          <RButton variant='ghost' onClick={discard} disabled={!dirty}>
            {t('common.discard')}
          </RButton>
          <RButton
            variant='primary'
            icon='ri-check-line'
            onClick={save}
            disabled={!dirty || saving || !gate.allowed}
            title={gate.allowed ? undefined : gate.reason}
          >
            {t('common.save')}
          </RButton>
        </>
      }
      headerActions={
        <div className='flex items-center gap-2'>
          {/* Who reached this install, and how, is a log question — the
              mock puts the shortcut here because Access is where the
              question occurs to you. Goes to the screen that already
              exists rather than to a second log reader. */}
          <RButton variant='ghost' icon='ri-history-line' onClick={() => navigate('/activity/logs')}>
            {t('settings.access.auditLog')}
          </RButton>
          <RButton
            variant='outline'
            icon='ri-external-link-line'
            onClick={() => window.open(ZERO_TRUST_URL, '_blank', 'noopener,noreferrer')}
          >
            {t('settings.access.openZeroTrust')}
          </RButton>
        </div>
      }
    >
      {identity === null ? null : <ExposureNotice identity={identity} />}

      <SettingsField label={t('settings.access.signedInAs')} hint={t('settings.access.signedInAsHint')}>
        <SignedInAs identity={identity} />
      </SettingsField>

      <AccessConfigSection
        draft={draft}
        onChange={setDraft}
        check={check}
        checking={checking}
        onCheck={runCheck}
        stale={stale}
      />
      {dirty && !gate.allowed ? (
        <div className='px-6 pb-4 text-[12px] leading-relaxed text-amber-600 dark:text-amber-400'>{gate.reason}</div>
      ) : null}
      {dirty && gate.allowed && gate.caveat !== null ? (
        <div className='px-6 pb-4 text-[12px] leading-relaxed text-muted-foreground'>{gate.caveat}</div>
      ) : null}

      <PolicyCoverage />

      <BootstrapTokenSection apiKey={apiKey} />

      <div className='px-6 pb-2'>
        <GuardsCard />
      </div>

      <AccessTokensSection surfaces={surfaces} />
      <div className='h-8' />
    </SettingsLayout>
  )
}
