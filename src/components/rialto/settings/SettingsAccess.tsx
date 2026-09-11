/**
 * Settings → Access. Who is allowed to reach Rialto, and with what.
 *
 * Two independent gates, and the screen's job is to make it obvious
 * which one is actually load-bearing:
 *
 *   /api/*  — a browser on this machine, which presents nothing, or a
 *             Cloudflare Access assertion once ACCESS_TEAM_DOMAIN +
 *             ACCESS_AUD are set (verified against the team JWKS before
 *             any handler runs). Nothing else: there is no admin secret.
 *   /v1/*   — per-client access tokens, and only those. This path has to
 *             be a Bypass app at the edge, because Claude Code, Codex and
 *             Gemini CLI cannot complete an interactive Access login. No
 *             tokens issued means no proxying at all.
 *
 * `accessConfigured: false` means the admin API is closed to everything
 * but this machine, so it is stated at the top of the page rather than
 * inferred from a missing pill. And because a broken Access configuration
 * shuts remote browsers out with no key to fall back on, the page says how
 * to come in from the host before anyone needs to know.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Pill, RButton } from '@/components/rialto/primitives'
import { AccessConfigSection } from '@/components/rialto/settings/access/AccessConfigSection'
import { GuardsCard } from '@/components/rialto/settings/access/GuardsCard'
import { SettingsField, SettingsLayout } from '@/components/rialto/settings/SettingsLayout'
import { useUnsavedGuard } from '@/components/rialto/settings/use-unsaved-guard'
import { api, type IdentityResponse } from '@/lib/api'
import {
  type AccessCheckResponse,
  type AccessInput,
  accessSaveGate,
  normalizeAccessInput,
  sameAccessInput
} from '@/lib/rialto/settings/access-config'
import type { EnvelopeWire } from '@/lib/rialto/settings/envelope'

const ZERO_TRUST_URL = 'https://one.dash.cloudflare.com/'

// ConfigEnvelopeSchema's own PORT default, for the recovery command while
// the envelope has not loaded yet.
const DEFAULT_PORT = 3456

// Two ways in, and they are not interchangeable. Reporting a local
// request as a verified identity would claim a credential had been
// checked when none was presented at all.
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
 * The closed statement.
 *
 * One line by design: the mock has nothing in this position, so a block
 * here displaces the whole page. With Access unconfigured nothing is
 * exposed — only this machine can reach /api/* — so it reads as a lock,
 * not a warning.
 */
function ClosedNotice({ identity }: { identity: IdentityResponse }) {
  if (identity.accessConfigured) return null
  return (
    <div className='px-6 pt-1 pb-3'>
      <div className='flex items-center gap-2 rounded-md border border-border px-4 py-2 text-[12px] leading-relaxed text-muted-foreground'>
        <i className='ri-lock-line shrink-0 text-sm' />
        <span>
          <Trans
            i18nKey='settings.access.closedNotice'
            components={{ strong: <span className='font-medium' />, mono: <span className='font-mono' /> }}
          />
        </span>
      </div>
    </div>
  )
}

/**
 * The way back in when Access itself is what broke.
 *
 * A bootstrap token used to sit here, kept for exactly that outage. It was
 * a master key for /api/* that got past Access for whoever read it out of
 * config.json, a backup or shell history, and the outage already had a way
 * in that needs no secret: a request made on the host skips the gate, and
 * that check reads neither Access nor the database. So the row says how to
 * be on the host instead of holding a key.
 */
function RecoveryPath({ port }: { port: number }) {
  const { t } = useTranslation()
  return (
    <SettingsField label={t('settings.access.recoveryTitle')} hint={t('settings.access.recoveryHint')}>
      <div className='space-y-1.5'>
        <div className='flex h-8 max-w-md items-center rounded-md border border-border px-3 font-mono text-xs'>
          {`ssh -L ${port}:localhost:${port} <host>`}
        </div>
        <p className='text-[12px] leading-relaxed text-muted-foreground'>
          <Trans
            i18nKey='settings.access.recoveryBody'
            values={{ port }}
            components={{ mono: <span className='font-mono' /> }}
          />
        </p>
      </div>
    </SettingsField>
  )
}

function PolicyCoverage() {
  const { t } = useTranslation()
  return (
    <SettingsField label={t('settings.access.policyCoverage')}>
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
  const [port, setPort] = useState(DEFAULT_PORT)
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
        setPort(typeof res.PORT === 'number' ? res.PORT : DEFAULT_PORT)
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
  }, [loadIdentity, loadConfig])

  // Normalised once, and used for the check, the gate and the save alike
  // — the checked string and the saved string must be the same string.
  const normalized = useMemo(() => normalizeAccessInput(draft), [draft])
  const gate = accessSaveGate(normalized, check, checkedFor)
  const stale = checkedFor !== null && !sameAccessInput(normalized, checkedFor)
  const dirty = saved !== null && !sameAccessInput(normalized, normalizeAccessInput(saved))
  const unsavedDialog = useUnsavedGuard(dirty)

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
      heading={t('settings.access.adminAccess')}
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
      {identity === null ? null : <ClosedNotice identity={identity} />}

      {/* No hint under the label: how the caller was verified is the
          gate's business, and the pill beside the name already says it. */}
      <SettingsField label={t('settings.access.signedInAs')}>
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

      <RecoveryPath port={port} />

      <div className='px-6 pb-2'>
        <GuardsCard />
      </div>

      {/* The /v1 token list is its own top-level screen now. This page
          answers who may administer the install; that one answers who
          may send it traffic, and the two were only ever together
          because both involve a credential. */}
      <div className='h-8' />
      {unsavedDialog}
    </SettingsLayout>
  )
}
