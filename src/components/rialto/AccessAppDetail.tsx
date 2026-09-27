/**
 * One authorized app: how its installs register, and the installs.
 *
 * The top half is configuration and saves as one form, like a token's
 * page. The bottom half is operations: a searchable list of devices,
 * each its own token. A device row opens that token's page — Revoke
 * lives there, for the same reason it left the token table: one
 * mis-aimed click in a list of live credentials takes a person's app
 * offline.
 *
 * Off rather than Delete. Turning an app off stops every token it issued
 * and turning it back on restores them; deleting would orphan every
 * RequestLog row its installs wrote.
 */
import { useCallback, useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { useConfirm } from '@/components/rialto/ConfirmDialog'
import { Pager } from '@/components/rialto/Pager'
import { Meter, Pill, RButton } from '@/components/rialto/primitives'
import { Screen } from '@/components/rialto/Screen'
import { Picker } from '@/components/rialto/settings/access/pickers'
import { SettingsField } from '@/components/rialto/settings/SettingsLayout'
import { useUnsavedGuard } from '@/components/rialto/settings/use-unsaved-guard'
import { type AppDeviceWire, type AuthorizedAppWire, api, type PlanWire } from '@/lib/api'
import { splitConfirmMessage } from '@/lib/rialto/confirm-message'
import { fmtAgo, fmtCount } from '@/lib/rialto/format'
import { capPct } from '@/lib/rialto/settings/plans'
import { fmtCost } from '@/lib/sessions/format'

const PAGE_SIZE = 50

interface AppForm {
  name: string
  planId: string
  allowDevelopment: boolean
}

const formOf = (app: AuthorizedAppWire): AppForm => ({
  name: app.name,
  planId: app.plan.id,
  allowDevelopment: app.allowDevelopment
})

function DeviceRow({ device, now, onOpen }: { device: AppDeviceWire; now: number; onOpen: () => void }) {
  const { t } = useTranslation()
  const pct = capPct(device.requestsToday, device.dailyRequestLimit)
  return (
    <tr
      className={`cursor-pointer border-t border-border/60 transition-colors hover:bg-muted/50 ${device.revokedAt === null ? '' : 'opacity-45'}`}
      onClick={onOpen}
    >
      <td className='py-2.5 pl-6 pr-3'>
        <div className='flex items-center gap-2'>
          <span className='font-mono text-xs'>{device.keyPrefix}…</span>
          {device.revokedAt === null ? null : <Pill tone='bad'>{t('settings.access.tokenRevoked')}</Pill>}
        </div>
      </td>
      <td className='px-3'>
        <Pill tone={device.environment === 'production' ? 'mute' : 'warn'}>{device.environment}</Pill>
      </td>
      <td className='px-3'>
        {device.plan === null ? (
          <span className='text-[12px] text-muted-foreground/50'>–</span>
        ) : (
          <Pill tone='info'>{device.plan.name}</Pill>
        )}
      </td>
      <td className='px-3'>
        {/* Against the plan's cap, so a device about to be refused says so
            before the 429 does. */}
        <div className='flex items-center gap-2'>
          {pct === null ? null : (
            <div className='w-20'>
              <Meter pct={pct} />
            </div>
          )}
          <span
            className={`whitespace-nowrap font-mono text-[12px] tabular-nums ${pct !== null && pct >= 100 ? 'text-destructive' : 'text-muted-foreground'}`}
          >
            {device.dailyRequestLimit === null
              ? fmtCount(device.requestsToday)
              : `${device.requestsToday} / ${device.dailyRequestLimit}`}
          </span>
        </div>
      </td>
      <td className='px-3 text-right font-mono text-xs tabular-nums'>{fmtCost(device.costUsd)}</td>
      <td className='px-3 text-right font-mono text-[12px] tabular-nums text-muted-foreground'>
        {device.lastUsedAt === null
          ? t('settings.access.never')
          : t('settings.access.lastUsedAgo', { ago: fmtAgo(device.lastUsedAt, now) })}
      </td>
      <td className='px-3 text-right font-mono text-[12px] tabular-nums text-muted-foreground'>
        {device.registeredAt.slice(0, 10)}
      </td>
      <td className='py-2.5 pl-3 pr-6'>
        <div className='flex justify-end text-muted-foreground/50'>
          <i className='ri-arrow-right-s-line text-base' />
        </div>
      </td>
    </tr>
  )
}

/** The app's installs, a page at a time, searchable by the start of the key id. */
function Devices({ app }: { app: AuthorizedAppWire }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [result, setResult] = useState<{ total: number; devices: AppDeviceWire[] } | null>(null)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    api
      .getAppDevices(app.id, { query: query.trim(), offset: page * PAGE_SIZE, limit: PAGE_SIZE })
      .then((res) => {
        setResult(res)
        setNow(Date.now())
      })
      .catch((e: Error) => toast.error(t('access.app.devicesFailed', { message: e.message })))
  }, [app.id, query, page, t])

  const devices = result === null ? [] : result.devices
  return (
    <section className='border-t border-border'>
      <div className='flex items-center gap-3 px-6 pt-6 pb-3'>
        <h2 className='text-sm font-semibold'>{t('access.app.devices')}</h2>
        <span className='text-[12px] text-muted-foreground'>
          {t('access.app.devicesSummary', { total: fmtCount(app.deviceCount), active: fmtCount(app.activeDevices) })}
        </span>
        <div className='ml-auto flex items-center gap-2'>
          <div className='relative'>
            <i className='ri-search-line pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground' />
            <input
              type='search'
              value={query}
              aria-label={t('access.app.searchKey')}
              placeholder={t('access.app.searchKey')}
              onChange={(e) => {
                setQuery(e.target.value)
                setPage(0)
              }}
              className='flex h-8 w-56 items-center rounded-md border border-border bg-transparent pl-8 pr-3 font-mono text-xs outline-none focus:border-foreground/40'
            />
          </div>
        </div>
      </div>
      {result !== null && devices.length === 0 ? (
        <div className='px-6 pb-6 text-[12px] text-muted-foreground'>
          {query.trim().length === 0 ? t('access.app.noDevices') : t('access.app.noMatches')}
        </div>
      ) : (
        <table className='w-full table-fixed'>
          <colgroup>
            <col />
            <col className='w-28' />
            <col className='w-20' />
            <col className='w-52' />
            <col className='w-24' />
            <col className='w-24' />
            <col className='w-28' />
            <col className='w-10' />
          </colgroup>
          <thead>
            {/* Not sortable: the list is paged on the server, most recently
                used first, and sorting one page of it would misrepresent
                the rest. */}
            <tr className='text-left text-[12px] uppercase tracking-wider text-muted-foreground/70 [&>th]:h-9 [&>th]:whitespace-nowrap [&>th]:align-bottom [&>th]:pb-2 [&>th]:font-normal'>
              <th className='pl-6 pr-3'>{t('access.app.colKey')}</th>
              <th className='px-3'>{t('access.app.colBuild')}</th>
              <th className='px-3'>{t('access.app.colPlan')}</th>
              <th className='px-3'>{t('access.app.colRequestsToday')}</th>
              <th className='px-3 text-right'>{t('access.app.colCost')}</th>
              <th className='px-3 text-right'>{t('access.app.colLastUsed')}</th>
              <th className='px-3 text-right'>{t('access.app.colRegistered')}</th>
              <th className='pl-3 pr-6' />
            </tr>
          </thead>
          <tbody>
            {devices.map((device) => (
              <DeviceRow
                key={device.tokenId}
                device={device}
                now={now}
                onOpen={() => navigate(`/access-tokens/${device.tokenId}`)}
              />
            ))}
          </tbody>
        </table>
      )}
      <Pager
        page={page}
        pageSize={PAGE_SIZE}
        loaded={devices.length}
        total={result === null ? undefined : result.total}
        onPage={setPage}
      />
    </section>
  )
}

export function AccessAppDetail() {
  const { t } = useTranslation()
  const { id = '' } = useParams()
  const { confirm, dialog: confirmDialog } = useConfirm()
  const [app, setApp] = useState<AuthorizedAppWire | null>(null)
  const [plans, setPlans] = useState<PlanWire[]>([])
  const [form, setForm] = useState<AppForm | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const show = useCallback((next: AuthorizedAppWire) => {
    setApp(next)
    setForm(formOf(next))
  }, [])

  useEffect(() => {
    api
      .getAuthorizedApp(id)
      .then(show)
      .catch((e: Error) => setError(e.message))
    api
      .getPlans()
      .then((res) => setPlans(res.plans))
      .catch(() => {
        // The picker then offers only the app's current plan.
      })
  }, [id, show])

  const dirty =
    app !== null &&
    form !== null &&
    (form.name.trim() !== app.name || form.planId !== app.plan.id || form.allowDevelopment !== app.allowDevelopment)
  const unsavedDialog = useUnsavedGuard(dirty)

  const save = () => {
    if (app === null || form === null) return
    setBusy(true)
    api
      .updateAuthorizedApp(app.id, { ...form, name: form.name.trim() })
      .then((next) => {
        show(next)
        toast.success(t('access.app.saved', { name: next.name }))
      })
      .catch((e: Error) => toast.error(t('settings.common.saveFailed', { message: e.message })))
      .finally(() => setBusy(false))
  }

  const setEnabled = async (enabled: boolean) => {
    if (app === null) return
    if (!enabled) {
      const { title, description } = splitConfirmMessage(
        t('access.app.turnOffConfirm', { name: app.name, n: fmtCount(app.deviceCount) })
      )
      const confirmed = await confirm({
        title,
        description,
        confirmLabel: t('access.app.turnOff'),
        icon: 'ri-forbid-line'
      })
      if (!confirmed) return
    }
    setBusy(true)
    api
      .setAuthorizedAppEnabled(app.id, enabled)
      .then(show)
      .catch((e: Error) => toast.error(t('settings.common.saveFailed', { message: e.message })))
      .finally(() => setBusy(false))
  }

  if (error !== null) {
    return (
      <Screen crumbs={[{ label: t('access.tabs.apps'), href: '/access-tokens/apps' }]}>
        <div className='px-6 py-8 text-xs text-muted-foreground'>{t('access.app.loadFailed', { message: error })}</div>
      </Screen>
    )
  }
  if (app === null || form === null) {
    return (
      <Screen>
        <div className='px-6 py-8 text-xs text-muted-foreground'>{t('common.loading')}</div>
      </Screen>
    )
  }

  // The app's own plan stays selectable even if the plans list failed to load.
  const planOptions = plans.some((plan) => plan.id === app.plan.id) ? plans : [app.plan, ...plans]

  return (
    <Screen
      crumbs={[{ label: t('access.tabs.apps'), href: '/access-tokens/apps' }, { label: app.name }]}
      subtitle={t('access.app.subtitle')}
    >
      <div className='min-w-0'>
        <div className='flex items-center gap-3 px-6 pt-6 pb-3'>
          <div className='min-w-0'>
            <div className='truncate text-sm font-semibold'>{app.name}</div>
            <div className='font-mono text-[12px] text-muted-foreground'>{app.appleAppId}</div>
          </div>
          <Pill tone={app.enabled ? 'ok' : 'mute'}>{t(app.enabled ? 'access.app.on' : 'access.apps.off')}</Pill>
          <div className='ml-auto flex items-center gap-2'>
            {app.enabled ? (
              <RButton variant='danger' icon='ri-forbid-line' onClick={() => setEnabled(false)} disabled={busy}>
                {t('access.app.turnOff')}
              </RButton>
            ) : (
              <RButton variant='outline' icon='ri-play-line' onClick={() => setEnabled(true)} disabled={busy}>
                {t('access.app.turnOn')}
              </RButton>
            )}
          </div>
        </div>

        <SettingsField label={t('access.apps.name')}>
          <input
            type='text'
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className='flex h-8 w-full max-w-md items-center rounded-md border border-border bg-transparent px-3 font-mono text-xs outline-none focus:border-foreground/40'
          />
        </SettingsField>

        <SettingsField label={t('access.apps.appId')} hint={t('access.app.appIdHint')}>
          <div className='font-mono text-xs'>{app.appleAppId}</div>
        </SettingsField>

        <SettingsField label={t('access.apps.planForNew')} hint={t('access.app.planHint')}>
          <Picker
            label={t('access.apps.planForNew')}
            value={form.planId}
            onChange={(planId) => setForm({ ...form, planId })}
            disabled={busy}
          >
            {planOptions.map((plan) => (
              <option key={plan.id} value={plan.id}>
                {plan.name}
              </option>
            ))}
          </Picker>
        </SettingsField>

        <SettingsField label={t('access.app.developmentBuilds')} hint={t('access.apps.acceptDevelopmentHint')}>
          <div className='flex items-center gap-3'>
            <button
              type='button'
              role='switch'
              aria-checked={form.allowDevelopment}
              aria-label={t('access.app.developmentBuilds')}
              onClick={() => setForm({ ...form, allowDevelopment: !form.allowDevelopment })}
              className={`inline-flex h-5 w-9 items-center rounded-full p-0.5 transition-colors ${form.allowDevelopment ? 'bg-primary' : 'bg-muted'}`}
            >
              <span
                className={`size-4 rounded-full bg-background shadow transition-transform ${form.allowDevelopment ? 'translate-x-4' : ''}`}
              />
            </button>
            <span className='text-[12px] text-muted-foreground'>
              {t(form.allowDevelopment ? 'access.apps.buildsDevelopment' : 'access.apps.buildsStore')}
            </span>
          </div>
        </SettingsField>

        <div className='flex items-center gap-2 border-t border-border/60 px-6 py-4'>
          <span className='text-[12px] text-muted-foreground'>
            <Trans
              i18nKey='access.app.saveNote'
              values={{ name: app.name }}
              components={{ strong: <span className='font-medium text-foreground' /> }}
            />
          </span>
          <div className='ml-auto flex gap-2'>
            <RButton variant='ghost' onClick={() => setForm(formOf(app))} disabled={!dirty || busy}>
              {t('common.discard')}
            </RButton>
            <RButton
              variant='primary'
              icon='ri-check-line'
              onClick={save}
              disabled={!dirty || busy || form.name.trim().length === 0}
            >
              {t('common.save')}
            </RButton>
          </div>
        </div>

        <Devices app={app} />
        <div className='h-8' />
        {confirmDialog}
        {unsavedDialog}
      </div>
    </Screen>
  )
}
