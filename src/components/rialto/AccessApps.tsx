/**
 * Access tokens → Apps: apps whose installs register themselves.
 *
 * An install cannot ship a credential — anything in the binary is
 * everyone's — so it proves instead, with Apple App Attest, that it is
 * this app, unmodified, on a real device, and is handed a token of its
 * own. Which apps may do that is the one decision left to the operator,
 * made here per app rather than in an environment variable nobody can
 * see from the UI.
 *
 * The rows are apps, not installs. A thousand devices are a count on the
 * app's row and a searchable list on its page.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Pill, RButton } from '@/components/rialto/primitives'
import { Screen } from '@/components/rialto/Screen'
import { AccessTabs } from '@/components/rialto/settings/access/AccessTabs'
import { AddAppDialog, type AppDraft, emptyAppDraft } from '@/components/rialto/settings/access/AddAppDialog'
import { SectionHead } from '@/components/rialto/settings/fields'
import { SortTh, type SortValue, useTableSort } from '@/components/rialto/table-sort'
import { type AuthorizedAppWire, api, type PlanWire } from '@/lib/api'
import { fmtCount } from '@/lib/rialto/format'
import { fmtCost } from '@/lib/sessions/format'

type AppSortKey = 'name' | 'builds' | 'plan' | 'devices' | 'active' | 'requests' | 'cost'

const appSortValue = (app: AuthorizedAppWire, key: AppSortKey): SortValue => {
  if (key === 'name') return app.name
  if (key === 'builds') return app.allowDevelopment
  if (key === 'plan') return app.plan.name
  if (key === 'devices') return app.deviceCount
  if (key === 'active') return app.activeDevices
  if (key === 'requests') return app.requestsToday
  return app.costUsd
}

function AppRow({ app, onOpen }: { app: AuthorizedAppWire; onOpen: () => void }) {
  const { t } = useTranslation()
  return (
    <tr
      className={`cursor-pointer border-t border-border/60 transition-colors hover:bg-muted/50 ${app.enabled ? '' : 'opacity-45'}`}
      onClick={onOpen}
    >
      <td className='py-2.5 pl-6 pr-3'>
        <div className='flex items-center gap-2'>
          <span className='text-xs font-medium'>{app.name}</span>
          {app.enabled ? null : <Pill tone='mute'>{t('access.apps.off')}</Pill>}
        </div>
        <div className='truncate font-mono text-[12px] text-muted-foreground'>{app.appleAppId}</div>
      </td>
      <td className='px-3 text-[12px] text-muted-foreground'>
        {t(app.allowDevelopment ? 'access.apps.buildsDevelopment' : 'access.apps.buildsStore')}
      </td>
      <td className='px-3'>
        <Pill tone='info'>{app.plan.name}</Pill>
      </td>
      <td className='px-3 text-right font-mono text-xs tabular-nums'>{fmtCount(app.deviceCount)}</td>
      <td className='px-3 text-right font-mono text-xs tabular-nums'>{fmtCount(app.activeDevices)}</td>
      <td className='px-3 text-right font-mono text-xs tabular-nums'>{fmtCount(app.requestsToday)}</td>
      <td className='px-3 text-right font-mono text-xs tabular-nums'>{fmtCost(app.costUsd)}</td>
      <td className='py-2.5 pl-3 pr-6'>
        <div className='flex justify-end text-muted-foreground/50'>
          <i className='ri-arrow-right-s-line text-base' />
        </div>
      </td>
    </tr>
  )
}

function AppTable({ apps }: { apps: AuthorizedAppWire[] }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const sort = useTableSort<AuthorizedAppWire, AppSortKey>(apps, appSortValue)
  if (apps.length === 0) {
    return <div className='px-6 pb-6 text-[12px] text-muted-foreground'>{t('access.apps.empty')}</div>
  }
  const th = (key: AppSortKey, label: string, right = false) => (
    <SortTh
      sortKey={key}
      sort={sort}
      className={right ? 'px-3 text-right' : key === 'name' ? 'pl-6 pr-3 text-left' : 'px-3 text-left'}
      align={right ? 'right' : undefined}
    >
      {label}
    </SortTh>
  )
  return (
    <table className='w-full table-fixed'>
      <colgroup>
        <col />
        <col className='w-44' />
        <col className='w-24' />
        <col className='w-24' />
        <col className='w-24' />
        <col className='w-24' />
        <col className='w-24' />
        <col className='w-10' />
      </colgroup>
      <thead>
        <tr className='text-[12px] uppercase tracking-wider text-muted-foreground/70 [&>th]:h-9 [&>th]:whitespace-nowrap [&>th]:align-bottom [&>th]:pb-2'>
          {th('name', t('access.apps.colApp'))}
          {th('builds', t('access.apps.colBuilds'))}
          {th('plan', t('access.apps.colPlan'))}
          {th('devices', t('access.apps.colDevices'), true)}
          {th('active', t('access.apps.colActive'), true)}
          {th('requests', t('access.apps.colRequestsToday'), true)}
          {th('cost', t('access.apps.colCost'), true)}
          <th className='pl-3 pr-6' />
        </tr>
      </thead>
      <tbody>
        {sort.sorted.map((app) => (
          <AppRow key={app.id} app={app} onOpen={() => navigate(`/access-tokens/apps/${app.id}`)} />
        ))}
      </tbody>
    </table>
  )
}

export function AccessApps() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [apps, setApps] = useState<AuthorizedAppWire[]>([])
  const [plans, setPlans] = useState<PlanWire[]>([])
  const [draft, setDraft] = useState<AppDraft | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    Promise.all([api.getAuthorizedApps(), api.getPlans()])
      .then(([appsRes, plansRes]) => {
        setApps(appsRes.apps)
        setPlans(plansRes.plans)
      })
      .catch((e: Error) => toast.error(t('access.apps.listFailed', { message: e.message })))
  }, [t])

  useEffect(load, [load])

  const add = () => {
    if (draft === null) return
    setSaving(true)
    api
      .createAuthorizedApp({
        name: draft.name.trim(),
        appleAppId: draft.appleAppId.trim(),
        planId: draft.planId,
        allowDevelopment: draft.allowDevelopment
      })
      .then((app) => {
        setDraft(null)
        // Straight to its page: the next thing to do with a new app is
        // watch its first install arrive there.
        navigate(`/access-tokens/apps/${app.id}`)
      })
      .catch((e: Error) => toast.error(t('access.apps.addFailed', { message: e.message })))
      .finally(() => setSaving(false))
  }

  const summary = useMemo(() => {
    const on = apps.filter((app) => app.enabled).length
    const devices = apps.reduce((sum, app) => sum + app.deviceCount, 0)
    return t('access.apps.summary', { on, off: apps.length - on, devices: fmtCount(devices) })
  }, [apps, t])

  return (
    <Screen subtitle={t('access.apps.subtitle')}>
      <AccessTabs active='apps' />
      <SectionHead
        meta={summary}
        actions={
          <RButton variant='primary' icon='ri-add-line' onClick={() => setDraft(emptyAppDraft(plans))}>
            {t('access.apps.add')}
          </RButton>
        }
      />
      <div className='px-6 pb-4'>
        <div className='rounded-md border border-dashed border-border px-4 py-3 text-[12px] leading-relaxed text-muted-foreground'>
          <i className='ri-information-line mr-1 align-[-1px]' />
          <Trans
            i18nKey='access.apps.note'
            components={{
              mono: <span className='font-mono' />,
              strong: <span className='font-medium text-foreground' />
            }}
          />
        </div>
      </div>
      <AppTable apps={apps} />
      {draft === null ? null : (
        <AddAppDialog
          draft={draft}
          plans={plans}
          saving={saving}
          onChange={setDraft}
          onSubmit={add}
          onCancel={() => setDraft(null)}
        />
      )}
      <div className='h-8' />
    </Screen>
  )
}
