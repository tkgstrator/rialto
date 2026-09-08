/**
 * First-run screen. Replaces SetupDialog.
 *
 * SetupDialog asked for an APIKEY in a modal before the operator had any
 * model of what Rialto is, so "why am I being asked this" had nowhere to
 * live. This states the shape of the system first, then walks the two
 * things that actually unblock the install: a provider to route to, and a
 * credential a client can authenticate with.
 *
 * Full page, no app shell — the sidebar's five destinations mean nothing
 * until something answers.
 */
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'
import { useConfig } from '@/components/ConfigProvider'
import { Pill, RButton } from '@/components/rialto/primitives'
import { isProviderConnected, markSetupOffered } from '@/components/rialto/system/first-run'
import { useAppVersion } from '@/hooks/use-app-version'
import { type AccessTokenWire, api } from '@/lib/api'
import { cn } from '@/lib/utils'

type StepState = 'done' | 'active' | 'todo'

const DOT: Record<StepState, string> = {
  done: 'bg-foreground text-background',
  active: 'bg-foreground text-background',
  todo: 'bg-muted text-muted-foreground'
}

// Only claude and codex are subscription seats: they are the whole of
// SUBSCRIPTION_PRESETS, and each has an OAuth initiate endpoint. Gemini is
// listed because it is one of the four inbound surfaces, but it reaches
// upstream through the `google` api_key vendor, NOT through a plan —
// Gemini CLI / Code Assist stopped serving the individual, AI Pro and AI
// Ultra tiers on 2026-06-18, so naming a plan here would promise a seat
// that no longer exists. Every card hands off to Providers regardless.
//
// The labels are product names, identical in every language; the hints say
// how the vendor is paid for, so they come from the bundle.
const CONNECT_OPTIONS: Array<{ label: string; icon: string; hintKey: string }> = [
  { label: 'Claude Code', icon: 'ri-sparkling-line', hintKey: 'system.setup.optionHintClaudeCode' },
  { label: 'Codex', icon: 'ri-terminal-line', hintKey: 'system.setup.optionHintCodex' },
  { label: 'Google AI', icon: 'ri-gemini-line', hintKey: 'system.setup.optionHintGoogle' }
]

// Mirrors the server's own liveness test in access-token-service: listing
// returns revoked and expired rows too, and neither will authenticate.
const isLive = (token: AccessTokenWire, now: number): boolean => {
  if (token.revokedAt !== null) return false
  return token.expiresAt === null ? true : Date.parse(token.expiresAt) > now
}

type Translate = (key: string, options?: Record<string, unknown>) => string

const nextTokenName = (live: number, t: Translate): string =>
  live === 0 ? t('system.setup.firstClient') : t('system.setup.nthClient', { n: live + 1 })

function Step({
  n,
  state,
  title,
  body,
  children
}: {
  n: number
  state: StepState
  title: string
  body: string
  children?: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <div className={cn('flex gap-4 border-t border-border px-6 py-5', state === 'todo' ? 'opacity-50' : '')}>
      <span
        className={cn(
          'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-[12px] font-medium',
          DOT[state]
        )}
      >
        {state === 'done' ? <i className='ri-check-line text-xs' /> : n}
      </span>
      <div className='min-w-0 flex-1'>
        <div className='flex items-center gap-2'>
          <h2 className='text-xs font-semibold'>{title}</h2>
          {state === 'done' ? <Pill tone='ok'>{t('system.setup.stepDone')}</Pill> : null}
        </div>
        <p className='mt-1 text-[12px] leading-relaxed text-muted-foreground'>{body}</p>
        {children}
      </div>
    </div>
  )
}

/**
 * The export block, in its two states.
 *
 * Before issuing it shows the shape rather than a value, because the only
 * credential the page could otherwise offer — the envelope bootstrap token
 * — is admin-only now and would 401 on the client's first request. After
 * issuing it shows the plaintext in full: a masked token cannot be pasted,
 * and pasting it is the entire point of this block.
 */
function ExportBlock({ baseUrl, plaintext }: { baseUrl: string; plaintext: string | null }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const [clipboardError, setClipboardError] = useState<string | null>(null)

  const copy = () => {
    if (plaintext === null) return
    navigator.clipboard.writeText(plaintext).then(
      () => setCopied(true),
      () => setClipboardError(t('system.setup.clipboardRefused'))
    )
  }

  return (
    <>
      <div className='mt-3 rounded-md bg-muted/60 px-3 py-2 font-mono text-[12px] leading-relaxed break-all'>
        <div>export ANTHROPIC_BASE_URL={baseUrl}</div>
        {plaintext === null ? (
          <div className='text-muted-foreground'>export ANTHROPIC_AUTH_TOKEN=…</div>
        ) : (
          <div>export ANTHROPIC_AUTH_TOKEN={plaintext}</div>
        )}
        <div>claude</div>
      </div>
      {plaintext === null ? null : (
        <div className='mt-2 flex items-start gap-2'>
          <RButton
            variant='outline'
            icon={copied ? 'ri-check-line' : 'ri-file-copy-line'}
            className='shrink-0'
            onClick={copy}
          >
            {t(copied ? 'settings.access.tokenCopiedShort' : 'common.copy')}
          </RButton>
          <span className='text-[12px] leading-relaxed text-muted-foreground'>
            {clipboardError === null ? t('system.setup.shownOnce') : clipboardError}
          </span>
        </div>
      )}
    </>
  )
}

export function SetupScreen() {
  const { t } = useTranslation()
  const version = useAppVersion()
  const { config } = useConfig()
  const navigate = useNavigate()
  const [tokens, setTokens] = useState<AccessTokenWire[] | null>(null)
  const [issued, setIssued] = useState<string | null>(null)
  const [issuing, setIssuing] = useState(false)
  const [issueError, setIssueError] = useState<string | null>(null)

  // Mark the nudge delivered as soon as this screen renders. ProtectedRoute
  // sends a fresh install here and will keep doing so until it is told the
  // offer was made — without this, "Skip setup" navigates to /overview, the
  // gate re-evaluates, and the operator lands straight back on this page
  // with nothing to show for the click. On mount rather than on the link so
  // every way out (Continue, browser back, the sidebar) behaves the same.
  useEffect(() => {
    markSetupOffered()
  }, [])

  useEffect(() => {
    api
      .getAccessTokens()
      .then((res) => setTokens(res.tokens))
      .catch(() => {
        // A failed listing only costs the "you already have N" hint; the
        // issue action below still works and is the point of the step.
      })
  }, [])

  const providers = config === null ? [] : config.Providers
  const connected = providers.filter(isProviderConnected).length
  const live = tokens === null ? 0 : tokens.filter((token) => isLive(token, Date.now())).length

  // The URL the operator's browser used to get here is, by construction,
  // a URL that reaches this server — through a tunnel, over the LAN, or on
  // loopback. config.PORT would only be right in the third case.
  const baseUrl = window.location.origin

  const issue = () => {
    setIssuing(true)
    setIssueError(null)
    api
      .issueAccessToken({ name: nextTokenName(live, t) })
      .then((result) => {
        setIssued(result.plaintext)
        setTokens(tokens === null ? [result.token] : [result.token, ...tokens])
      })
      .catch((err: unknown) => setIssueError(err instanceof Error ? err.message : t('system.setup.issueFailed')))
      .finally(() => setIssuing(false))
  }

  const catalogBody = t('system.setup.databaseBody', {
    n: providers.length,
    authenticated:
      connected === 0 ? t('system.setup.noneAuthenticated') : t('system.setup.someAuthenticated', { n: connected })
  })

  return (
    <div className='flex min-h-screen items-center justify-center bg-background px-6 py-10'>
      <div className='w-full max-w-2xl rounded-lg border border-border'>
        <div className='px-6 pt-6 pb-5'>
          <div className='flex items-center gap-2.5'>
            <div className='flex size-7 items-center justify-center rounded bg-foreground text-background'>
              <i className='ri-route-line text-base leading-none' />
            </div>
            <span className='text-base font-semibold tracking-tight'>Rialto</span>
            <span className='ml-auto font-mono text-[11px] text-muted-foreground'>v{version}</span>
          </div>
          <p className='mt-4 text-xs leading-relaxed text-muted-foreground'>
            <Trans i18nKey='system.setup.intro' components={{ mono: <span className='font-mono' /> }} />
          </p>
        </div>

        <Step n={1} state='done' title={t('system.setup.databaseTitle')} body={catalogBody} />

        <Step
          n={2}
          state={connected === 0 ? 'active' : 'done'}
          title={t('system.setup.connectTitle')}
          body={t('system.setup.connectBody')}
        >
          <div className='mt-3 grid grid-cols-3 gap-2'>
            {CONNECT_OPTIONS.map((option) => (
              <Link
                key={option.label}
                to='/providers'
                className='rounded-md border border-border px-3 py-2.5 text-left transition-colors hover:bg-muted/50'
              >
                <i className={cn(option.icon, 'text-sm text-muted-foreground')} />
                <div className='mt-1 text-[12px] font-medium'>{option.label}</div>
                <div className='text-[11px] text-muted-foreground'>{t(option.hintKey)}</div>
              </Link>
            ))}
          </div>
          <Link
            to='/providers'
            className='mt-2 inline-block text-[12px] text-muted-foreground underline-offset-2 hover:underline'
          >
            {t('system.setup.useApiKey')}
          </Link>
        </Step>

        <Step
          n={3}
          state={connected === 0 ? 'todo' : 'active'}
          title={t('system.setup.clientTitle')}
          body={t('system.setup.clientBody')}
        >
          <ExportBlock baseUrl={baseUrl} plaintext={issued} />
          {issued === null ? (
            <div className='mt-2 flex items-start gap-2'>
              <RButton variant='outline' icon='ri-key-2-line' className='shrink-0' onClick={issue} disabled={issuing}>
                {t(issuing ? 'system.setup.issuing' : 'system.setup.issueToken')}
              </RButton>
              <span className='text-[12px] leading-relaxed text-muted-foreground'>
                {live === 0 ? t('system.setup.nothingCanCall') : t('system.setup.alreadyHave', { n: live })}
              </span>
            </div>
          ) : null}
          {issueError === null ? null : <p className='mt-2 text-[12px] text-destructive'>{issueError}</p>}
        </Step>

        <div className='flex items-center gap-3 border-t border-border px-6 py-4'>
          {/* The note is the only part that may reflow. min-w-0 lets it
              shrink below its content width; without it flex refuses to
              compress the prose and squeezes the two actions instead,
              which wrapped "Skip setup" onto a second line. */}
          <span className='min-w-0 text-[12px] text-muted-foreground'>
            <Trans i18nKey='system.setup.footerNote' components={{ mono: <span className='font-mono' /> }} />
          </span>
          <Link
            to='/overview'
            className='ml-auto shrink-0 whitespace-nowrap text-[12px] text-muted-foreground underline-offset-2 hover:underline'
          >
            {t('system.setup.skip')}
          </Link>
          <div className='shrink-0'>
            <RButton variant='primary' onClick={() => navigate(connected === 0 ? '/providers' : '/overview')}>
              {t('common.continue')} <i className='ri-arrow-right-line text-sm' />
            </RButton>
          </div>
        </div>
      </div>
    </div>
  )
}
