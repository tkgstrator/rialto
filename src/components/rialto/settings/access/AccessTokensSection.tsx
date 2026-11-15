import { useCallback, useEffect, useMemo, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useConfig } from '@/components/ConfigProvider'
import { scopePaths } from '@/components/rialto/activity/use-surfaces'
import { useConfirm } from '@/components/rialto/ConfirmDialog'
import { RButton } from '@/components/rialto/primitives'
import { IssuedTokenDialog } from '@/components/rialto/settings/access/IssuedTokenDialog'
import { emptyDraft, type IssueDraft, IssueTokenDialog } from '@/components/rialto/settings/access/IssueTokenDialog'
import { ANY, scopeForWire } from '@/components/rialto/settings/access/pickers'
import { TokenListPhone } from '@/components/rialto/settings/access/TokenListPhone'
import { TokenTable } from '@/components/rialto/settings/access/TokenTable'
import { SectionHead } from '@/components/rialto/settings/fields'
import { usePhone } from '@/hooks/use-phone'
import { type AccessTokenWire, api, type InboundSurfaceWire, type PlanWire } from '@/lib/api'
import { enabledTargets } from '@/lib/models/enabled-targets'
import { countTokens, expiryToIso, type TokenCounts } from '@/lib/rialto/settings/access-tokens'

interface Revealed {
  plaintext: string
  name: string
  scope: string
  expiry: string
}

function Summary({ counts }: { counts: TokenCounts }) {
  const { t } = useTranslation()
  if (counts.active === 0 && counts.expired === 0) return null
  return (
    <>
      {t('settings.access.countActive', { n: counts.active })}
      {counts.expired > 0 ? ` · ${t('settings.access.countExpired', { n: counts.expired })}` : ''}
      {' · '}
      <Trans i18nKey='settings.access.tokensScope' components={{ mono: <span className='font-mono' /> }} />
    </>
  )
}

export function AccessTokensSection({ surfaces }: { surfaces: InboundSurfaceWire[] }) {
  const { t } = useTranslation()
  const { config } = useConfig()
  const [tokens, setTokens] = useState<AccessTokenWire[]>([])
  const [plans, setPlans] = useState<PlanWire[]>([])
  const [draft, setDraft] = useState<IssueDraft | null>(null)
  const [revealed, setRevealed] = useState<Revealed | null>(null)
  const [issuing, setIssuing] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [allReset, setAllReset] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createdNote, setCreatedNote] = useState<string | null>(null)
  const { confirm, dialog: confirmDialog } = useConfirm()
  const [now, setNow] = useState(Date.now())
  const phone = usePhone()

  const available = useMemo(
    () => (config === null ? [] : enabledTargets(config.Providers).map((target) => target.target)),
    [config]
  )

  const closeDialog = () => {
    setDraft(null)
    setCreating(false)
    setCreatedNote(null)
  }

  const onPlanCreated = (plan: PlanWire) => {
    setPlans((prev) => [...prev, plan])
    setDraft((prev) => (prev === null ? prev : { ...prev, planId: plan.id }))
    setCreatedNote(plan.name)
    api
      .getPlans()
      .then((res) => setPlans(res.plans))
      .catch(() => {})
  }

  const load = useCallback(() => {
    api
      .getAccessTokens()
      .then((res) => {
        setTokens(res.tokens)
        setNow(Date.now())
      })
      .catch((e: Error) => toast.error(t('settings.access.listFailed', { message: e.message })))
  }, [t])

  useEffect(() => {
    load()
    api
      .getPlans()
      .then((res) => setPlans(res.plans))
      .catch(() => {})
  }, [load])

  const issue = () => {
    if (draft === null) return
    setIssuing(true)
    api
      .issueAccessToken({
        name: draft.name.trim(),
        surfaces: scopeForWire(surfaces, draft.surfaces),
        expiresAt: expiryToIso(draft.expiry, Date.now()),
        planId: draft.planId === ANY ? null : draft.planId
      })
      .then((res) => {
        const paths = scopePaths(surfaces, res.token.surfaces)
        setRevealed({
          plaintext: res.plaintext,
          name: res.token.name,
          scope: paths.length === 0 ? t('settings.access.allEndpoints') : paths.join(', '),
          expiry: res.token.expiresAt === null ? t('settings.access.never') : res.token.expiresAt.slice(0, 10)
        })
        closeDialog()
        load()
      })
      .catch((e: Error) => toast.error(t('settings.access.issueFailed', { message: e.message })))
      .finally(() => setIssuing(false))
  }

  const resetAll = async () => {
    const confirmed = await confirm({
      title: t('access.token.resetAllTitle'),
      description: [
        { text: t('access.token.resetAllBody') },
        { text: t('access.token.resetAllWarning'), tone: 'destructive' },
        { text: t('access.token.resetAllKeeps') }
      ],
      confirmLabel: t('access.token.resetAll'),
      icon: 'ri-restart-line'
    })
    if (!confirmed) return
    setResetting(true)
    api
      .resetAllUsageWindows()
      .then(() => setAllReset(true))
      .catch((e: Error) => toast.error(t('access.token.resetFailed', { message: e.message })))
      .finally(() => setResetting(false))
  }

  const counts = countTokens(tokens, now)

  const dialogs = (
    <>
      {revealed !== null ? (
        <IssuedTokenDialog {...revealed} onDone={() => setRevealed(null)} />
      ) : draft !== null ? (
        <IssueTokenDialog
          draft={draft}
          surfaces={surfaces}
          plans={plans}
          available={available}
          creating={creating}
          createdNote={createdNote}
          issuing={issuing}
          onChange={(next) => {
            if (draft !== null && next.planId !== draft.planId) setCreatedNote(null)
            setDraft(next)
          }}
          onSubmit={issue}
          onCancel={closeDialog}
          onCreatingChange={setCreating}
          onDismissCreatedNote={() => setCreatedNote(null)}
          onPlanCreated={onPlanCreated}
        />
      ) : null}
      {confirmDialog}
    </>
  )

  if (phone) {
    return (
      <>
        <TokenListPhone
          tokens={tokens}
          now={now}
          summary={<Summary counts={counts} />}
          onIssue={() => setDraft(emptyDraft())}
        />
        {dialogs}
      </>
    )
  }

  return (
    <>
      <SectionHead
        meta={<Summary counts={counts} />}
        actions={
          <RButton variant='primary' icon='ri-add-line' onClick={() => setDraft(emptyDraft())}>
            {t('settings.access.issueToken')}
          </RButton>
        }
      />

      <div className='px-6 pb-4'>
        <div className='rounded-md border border-dashed border-border px-4 py-3 text-[12px] leading-relaxed text-muted-foreground'>
          <i className='ri-information-line mr-1 align-[-1px]' />
          <Trans
            i18nKey='settings.access.tokensNote'
            components={{ strong: <span className='font-medium text-foreground' /> }}
          />
        </div>
      </div>

      <TokenTable tokens={tokens} surfaces={surfaces} now={now} />

      <div className='flex items-center gap-3 border-t border-border/60 px-6 py-4'>
        <span className='text-[12px] text-muted-foreground'>
          {t(allReset ? 'access.token.allResetNote' : 'access.token.listWindowsNote')}
        </span>
        <div className='ml-auto shrink-0'>
          <RButton variant='ghost' icon='ri-restart-line' onClick={resetAll} disabled={resetting}>
            {t('access.token.resetAll')}
          </RButton>
        </div>
      </div>

      {dialogs}
    </>
  )
}
