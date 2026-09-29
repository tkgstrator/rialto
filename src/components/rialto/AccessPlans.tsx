/**
 * Access tokens → Plans: what a token on each plan may spend.
 *
 * A plan is referenced, never copied onto its tokens. Raising Free's
 * limits is one edit that every token on Free sees at its next
 * request — the alternative, a limit stamped on each token at issue
 * time, is a migration every time pricing moves.
 *
 * A token is put on a plan when it is issued, or later from its own page.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useConfig } from '@/components/ConfigProvider'
import { useConfirm } from '@/components/rialto/ConfirmDialog'
import { Mono, Pill, RButton } from '@/components/rialto/primitives'
import { enabledTargets } from '@/components/rialto/routing/derive'
import { Screen } from '@/components/rialto/Screen'
import { AccessTabs } from '@/components/rialto/settings/access/AccessTabs'
import { PlanDialog } from '@/components/rialto/settings/access/PlanDialog'
import { SectionHead } from '@/components/rialto/settings/fields'
import { SortTh, type SortValue, useTableSort } from '@/components/rialto/table-sort'
import { api, type PlanWire } from '@/lib/api'
import { splitConfirmMessage } from '@/lib/rialto/confirm-message'
import { fmtCount } from '@/lib/rialto/format'
import { emptyPlanDraft, type PlanDraft, planDraftOf, planInputOf } from '@/lib/rialto/settings/plans'
import { fmtUsd } from '@/lib/rialto/settings/usage-windows'

type PlanSortKey = 'name' | 'models' | 'fiveHour' | 'sevenDay' | 'tokens'

const planSortValue = (plan: PlanWire, key: PlanSortKey): SortValue => {
  if (key === 'name') return plan.name
  if (key === 'models') return plan.models.length
  // A window sorts by its request limit, the cell's first line. No limit
  // is null, which the sort keeps below every number in either direction.
  if (key === 'fiveHour') return plan.fiveHourRequestLimit
  if (key === 'sevenDay') return plan.sevenDayRequestLimit
  return plan.tokenCount
}

/**
 * One window's two limits, a line each: requests over spend. Each says
 * "No … limit" in words rather than leaving a blank, because a blank
 * cell reads as a value that failed to load.
 */
function WindowCell({ requests, spendUsd }: { requests: number | null; spendUsd: number | null }) {
  const { t } = useTranslation()
  return (
    <>
      <div>
        {requests === null ? (
          <span className='text-muted-foreground'>{t('access.plans.noRequestLimit')}</span>
        ) : (
          t('access.plans.windowRequests', { n: requests.toLocaleString('en-US') })
        )}
      </div>
      <div className='text-muted-foreground'>
        {spendUsd === null ? t('access.plans.noSpendLimit') : t('access.plans.windowSpend', { usd: fmtUsd(spendUsd) })}
      </div>
    </>
  )
}

/**
 * The default and a count, not the whole list: a plan can carry several
 * models and the column would wrap. The rest is a hover away, and the
 * dialog lists them all.
 */
function ModelsCell({ plan }: { plan: PlanWire }) {
  const { t } = useTranslation()
  const rest = plan.models.length - 1
  return (
    <span className='inline-flex min-w-0 items-center gap-1.5' title={plan.models.join(' · ')}>
      <Mono className='truncate'>{plan.defaultModel}</Mono>
      <Pill tone='mute'>{t('access.plans.default')}</Pill>
      {rest > 0 ? <span className='shrink-0 font-mono text-[12px] text-muted-foreground/70'>+{rest}</span> : null}
    </span>
  )
}

function PlanTable({ plans, onOpen }: { plans: PlanWire[]; onOpen: (plan: PlanWire) => void }) {
  const { t } = useTranslation()
  const sort = useTableSort<PlanWire, PlanSortKey>(plans, planSortValue)
  if (plans.length === 0) {
    return <div className='px-6 pb-6 text-[12px] text-muted-foreground'>{t('access.plans.empty')}</div>
  }
  return (
    <table className='w-full table-fixed'>
      <colgroup>
        <col className='w-24' />
        <col />
        <col className='w-40' />
        <col className='w-40' />
        <col className='w-20' />
        <col className='w-10' />
      </colgroup>
      <thead>
        <tr className='text-[12px] uppercase tracking-wider text-muted-foreground/70 [&>th]:h-9 [&>th]:whitespace-nowrap [&>th]:align-bottom [&>th]:pb-2'>
          <SortTh sortKey='name' sort={sort} className='pl-6 pr-3 text-left'>
            {t('access.plans.colPlan')}
          </SortTh>
          <SortTh sortKey='models' sort={sort} className='px-3 text-left'>
            {t('access.plans.colModels')}
          </SortTh>
          <SortTh sortKey='fiveHour' sort={sort} className='px-3 text-right' align='right'>
            {t('access.plans.col5h')}
          </SortTh>
          <SortTh sortKey='sevenDay' sort={sort} className='px-3 text-right' align='right'>
            {t('access.plans.col7d')}
          </SortTh>
          <SortTh sortKey='tokens' sort={sort} className='px-3 text-right' align='right'>
            {t('access.plans.colTokens')}
          </SortTh>
          <th className='pl-3 pr-6' />
        </tr>
      </thead>
      <tbody>
        {sort.sorted.map((plan) => (
          <tr
            key={plan.id}
            className='cursor-pointer border-t border-border/60 transition-colors hover:bg-muted/50'
            onClick={() => onOpen(plan)}
          >
            <td className='py-2.5 pl-6 pr-3 text-xs font-medium'>{plan.name}</td>
            <td className='px-3'>
              <ModelsCell plan={plan} />
            </td>
            <td className='px-3 text-right font-mono text-xs tabular-nums'>
              <WindowCell requests={plan.fiveHourRequestLimit} spendUsd={plan.fiveHourSpendLimitUsd} />
            </td>
            <td className='px-3 text-right font-mono text-xs tabular-nums'>
              <WindowCell requests={plan.sevenDayRequestLimit} spendUsd={plan.sevenDaySpendLimitUsd} />
            </td>
            <td className='px-3 text-right font-mono text-xs tabular-nums'>{fmtCount(plan.tokenCount)}</td>
            <td className='py-2.5 pl-3 pr-6'>
              <div className='flex justify-end text-muted-foreground/50'>
                <i className='ri-pencil-line text-sm' />
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

interface Editing {
  plan: PlanWire | null
  draft: PlanDraft
}

export function AccessPlans() {
  const { t } = useTranslation()
  const { config } = useConfig()
  const { confirm, dialog: confirmDialog } = useConfirm()
  const [plans, setPlans] = useState<PlanWire[]>([])
  const [editing, setEditing] = useState<Editing | null>(null)
  const [saving, setSaving] = useState(false)
  // Tokens with no plan, for the summary's "N without". Null until the
  // token list answers; the summary then leaves the count out.
  const [withoutPlan, setWithoutPlan] = useState<number | null>(null)

  const load = useCallback(() => {
    api
      .getPlans()
      .then((res) => setPlans(res.plans))
      .catch((e: Error) => toast.error(t('access.plans.listFailed', { message: e.message })))
    // Counted over every row, revoked ones included, the same rows a
    // plan's own token count covers, so the two halves add up.
    api
      .getAccessTokens()
      .then((res) => setWithoutPlan(res.tokens.filter((token) => token.plan === null).length))
      .catch(() => setWithoutPlan(null))
  }, [t])

  useEffect(load, [load])

  // What the operator has left routable, the same list Routing offers.
  const available = useMemo(
    () => (config === null ? [] : enabledTargets(config.Providers).map((target) => target.target)),
    [config]
  )

  const save = () => {
    if (editing === null) return
    const input = planInputOf(editing.draft)
    if (input === null) return
    setSaving(true)
    const request = editing.plan === null ? api.createPlan(input) : api.updatePlan(editing.plan.id, input)
    request
      .then((plan) => {
        toast.success(t('access.plans.saved', { name: plan.name }))
        setEditing(null)
        load()
      })
      .catch((e: Error) => toast.error(t('settings.common.saveFailed', { message: e.message })))
      .finally(() => setSaving(false))
  }

  const remove = async () => {
    if (editing === null || editing.plan === null) return
    const plan = editing.plan
    const { title, description } = splitConfirmMessage(t('access.plans.deleteConfirm', { name: plan.name }))
    const confirmed = await confirm({
      title,
      description,
      confirmLabel: t('settings.access.delete'),
      icon: 'ri-delete-bin-line'
    })
    if (!confirmed) return
    setSaving(true)
    api
      .deletePlan(plan.id)
      .then(() => {
        toast.success(t('access.plans.deleted', { name: plan.name }))
        setEditing(null)
        load()
      })
      .catch((e: Error) => toast.error(t('settings.access.deleteFailed', { message: e.message })))
      .finally(() => setSaving(false))
  }

  const onPlan = plans.reduce((sum, plan) => sum + plan.tokenCount, 0)

  return (
    <Screen subtitle={t('access.plans.subtitle')}>
      <AccessTabs active='plans' />
      <SectionHead
        meta={t(onPlan === 1 ? 'access.plans.summaryOneToken' : 'access.plans.summary', {
          n: plans.length,
          onPlan: fmtCount(onPlan),
          without: withoutPlan === null ? '–' : fmtCount(withoutPlan)
        })}
        actions={
          <RButton
            variant='primary'
            icon='ri-add-line'
            onClick={() => setEditing({ plan: null, draft: emptyPlanDraft() })}
          >
            {t('access.plans.new')}
          </RButton>
        }
      />
      <div className='px-6 pb-4'>
        <div className='rounded-md border border-dashed border-border px-4 py-3 text-[12px] leading-relaxed text-muted-foreground'>
          <i className='ri-information-line mr-1 align-[-1px]' />
          <Trans
            i18nKey='access.plans.note'
            components={{ strong: <span className='font-medium text-foreground' /> }}
          />
        </div>
      </div>
      <PlanTable plans={plans} onOpen={(plan) => setEditing({ plan, draft: planDraftOf(plan) })} />
      {editing === null ? null : (
        <PlanDialog
          plan={editing.plan}
          draft={editing.draft}
          available={available}
          saving={saving}
          onChange={(draft) => setEditing({ ...editing, draft })}
          onSubmit={save}
          onDelete={remove}
          onCancel={() => setEditing(null)}
        />
      )}
      {confirmDialog}
      <div className='h-8' />
    </Screen>
  )
}
