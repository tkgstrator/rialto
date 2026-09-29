/**
 * A token's 5-hour and 7-day usage windows against its plan's limits, and
 * the button that clears them.
 *
 * Current windows only, kept apart from the 30-day totals in the Usage
 * row below: those are history, these are what the gate will decide the
 * next request on. Each measure is the same meter the subscription
 * windows use; a measure the plan does not limit says "No limit" rather
 * than drawing an empty bar that reads as 0% of something.
 *
 * Reset sits beside the usage it clears, not with Rotate and Revoke in
 * the header — it changes what the token may spend, not what it is — and
 * is asked first: it hands the client its full allowance back, which is
 * the point, but not something to do by a stray click.
 */
import { useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useConfirm } from '@/components/rialto/ConfirmDialog'
import { Meter, Pill, RButton } from '@/components/rialto/primitives'
import { SettingsField } from '@/components/rialto/settings/SettingsLayout'
import { type AccessTokenWire, api, type TokenUsageWindowsWire } from '@/lib/api'
import dayjs from '@/lib/dayjs'
import { fmtUntil } from '@/lib/rialto/format'
import {
  fmtResetAt,
  fmtUsd,
  type Measure,
  type SpentMeasure,
  type UsageWindowsView,
  type WindowView,
  zoneName,
  zoneOffset
} from '@/lib/rialto/settings/usage-windows'

type WindowId = WindowView['window']

const WINDOW_LABEL: Readonly<Record<WindowId, string>> = {
  '5h': 'access.token.window5h',
  '7d': 'access.token.window7d'
}

const REACHED: Readonly<Record<WindowId, Readonly<Record<SpentMeasure, string>>>> = {
  '5h': { requests: 'access.token.reached5hRequests', spend: 'access.token.reached5hSpend' },
  '7d': { requests: 'access.token.reached7dRequests', spend: 'access.token.reached7dSpend' }
}

/**
 * The token's windows as the server reports them. Refetched whenever the
 * page reloads the token, so moving it onto another plan shows the new
 * limits at once. `setUsage` takes a reset's answer without a second read.
 */
export function useTokenUsageWindows(token: AccessTokenWire | null): {
  usage: TokenUsageWindowsWire | null
  setUsage: (next: TokenUsageWindowsWire) => void
} {
  const [usage, setUsage] = useState<TokenUsageWindowsWire | null>(null)
  useEffect(() => {
    if (token === null) return
    api
      .getTokenUsageWindows(token.id)
      .then(setUsage)
      .catch(() => {
        // The field then reads as loading; the rest of the page still works.
      })
  }, [token])
  return { usage, setUsage }
}

/** One measure: its name, its meter (or "No limit"), and the figures. */
function MeasureLine({ label, measure, format }: { label: string; measure: Measure; format: (n: number) => string }) {
  const { t } = useTranslation()
  return (
    <div className='mt-2 flex items-center gap-3'>
      <span className='w-20 shrink-0 text-[12px] text-muted-foreground'>{label}</span>
      <div className='min-w-0 flex-1'>
        {measure.pct === null ? (
          <span className='text-[12px] text-muted-foreground'>{t('access.token.noLimit')}</span>
        ) : (
          <Meter pct={measure.pct} />
        )}
      </div>
      <span className='w-40 shrink-0 text-right font-mono text-xs tabular-nums'>
        {measure.limit === null
          ? t('access.token.usedOnly', { used: format(measure.used) })
          : t('access.token.usedOf', { used: format(measure.used), limit: format(measure.limit) })}
      </span>
    </div>
  )
}

const fmtRequests = (n: number): string => n.toLocaleString('en-US')

function WindowBlock({ view, now }: { view: WindowView; now: number }) {
  const { t, i18n } = useTranslation()
  const resets = (resetsAt: string) => {
    const until = fmtUntil(resetsAt, now)
    const at = fmtResetAt(resetsAt, i18n.language)
    return until === null ? t('access.token.resetsDue', { at }) : t('access.token.resetsIn', { until, at })
  }
  return (
    <div className='border-t border-border/60 py-3 first:border-t-0 first:pt-0'>
      <div className='flex items-center gap-2 text-xs'>
        <span className='font-medium'>{t(WINDOW_LABEL[view.window])}</span>
        {view.spentBy.length > 0 ? <Pill tone='bad'>{t('access.token.spent')}</Pill> : null}
        <span className='ml-auto text-[12px] text-muted-foreground'>
          {view.resetsAt === null ? t('access.token.notStarted') : resets(view.resetsAt)}
        </span>
      </div>
      <MeasureLine label={t('access.token.measureRequests')} measure={view.requests} format={fmtRequests} />
      <MeasureLine label={t('access.token.measureSpend')} measure={view.spend} format={fmtUsd} />
    </div>
  )
}

/** A token with no plan, or on a plan that limits neither window. */
function NoLimits({ view }: { view: Extract<UsageWindowsView, { kind: 'no-plan' | 'unlimited' }> }) {
  return (
    <div className='rounded-md border border-dashed border-border px-4 py-3 text-[12px] leading-relaxed text-muted-foreground'>
      <Trans
        i18nKey={view.kind === 'no-plan' ? 'access.token.noPlanNote' : 'access.token.unlimitedNote'}
        values={{ name: view.kind === 'unlimited' ? view.planName : '' }}
        components={{ strong: <span className='font-medium text-foreground' /> }}
      />
    </div>
  )
}

export function TokenUsageWindows({
  token,
  view,
  now,
  onReset
}: {
  token: AccessTokenWire
  view: UsageWindowsView
  /** The page's pinned instant, so the countdowns agree with its other relative labels. */
  now: number
  onReset: (next: TokenUsageWindowsWire) => void
}) {
  const { t, i18n } = useTranslation()
  const { confirm, dialog: confirmDialog } = useConfirm()
  const [busy, setBusy] = useState(false)
  const nowIso = dayjs(now).toISOString()

  const reset = async () => {
    const confirmed = await confirm({
      title: t('access.token.resetTitle', { name: token.name }),
      description: [
        { text: t('access.token.resetBody') },
        { text: t('access.token.resetWarning'), tone: 'strong' },
        { text: t('access.token.resetKeeps') }
      ],
      confirmLabel: t('access.token.reset'),
      icon: 'ri-restart-line'
    })
    if (!confirmed) return
    setBusy(true)
    api
      .resetTokenUsageWindows(token.id)
      .then(onReset)
      .catch((e: Error) => toast.error(t('access.token.resetFailed', { message: e.message })))
      .finally(() => setBusy(false))
  }

  return (
    <SettingsField
      label={t('access.token.windows')}
      hint={t('access.token.windowsHint', {
        zone: zoneName(nowIso, i18n.language),
        offset: zoneOffset(nowIso)
      })}
    >
      {view.kind === 'loading' ? (
        <div className='text-xs text-muted-foreground'>{t('common.loading')}</div>
      ) : view.kind === 'limited' ? (
        <div className='max-w-2xl'>
          {view.block === null ? null : (
            <div className='mb-3 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-[12px] text-destructive'>
              {[
                t('access.token.blockedUntil', { at: fmtResetAt(view.block.until, i18n.language) }),
                ...view.block.reasons.map((reason) => t(REACHED[reason.window][reason.measure])),
                t('access.token.blockedTail')
              ].join(' ')}
            </div>
          )}
          {view.windows.map((row) => (
            <WindowBlock key={row.window} view={row} now={now} />
          ))}
          <div className='flex items-center gap-3 border-t border-border/60 pt-3'>
            <span className='text-[12px] leading-snug text-muted-foreground'>
              {t(view.resettable ? 'access.token.windowsNote' : 'access.token.windowsNoteIdle')}
            </span>
            <span className='ml-auto shrink-0'>
              {view.resettable ? (
                <RButton variant='outline' icon='ri-restart-line' onClick={reset} disabled={busy}>
                  {t('access.token.reset')}
                </RButton>
              ) : (
                <span className='text-[12px] text-muted-foreground'>{t('access.token.nothingToReset')}</span>
              )}
            </span>
          </div>
        </div>
      ) : (
        <NoLimits view={view} />
      )}
      {confirmDialog}
    </SettingsField>
  )
}
