/**
 * A token's 5-hour and 7-day usage windows against its plan's limits, and
 * the button that clears them.
 *
 * Reloaded whenever the page reloads the token, so moving the token onto
 * another plan shows the new limits at once. Reset is asked first: it
 * hands the client its full allowance back, which is the point, but not
 * something to do by a stray click.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useConfirm } from '@/components/rialto/ConfirmDialog'
import { RButton } from '@/components/rialto/primitives'
import { SettingsField } from '@/components/rialto/settings/SettingsLayout'
import { type AccessTokenWire, api, type TokenUsageWindowsWire, type UsageWindowWire } from '@/lib/api'
import { splitConfirmMessage } from '@/lib/rialto/confirm-message'
import { fmtCount } from '@/lib/rialto/format'
import { fmtCost } from '@/lib/sessions/format'

const WINDOW_LABEL: Readonly<Record<UsageWindowWire['window'], string>> = {
  '5h': 'access.token.window5h',
  '7d': 'access.token.window7d'
}

function WindowRow({ row }: { row: UsageWindowWire }) {
  const { t } = useTranslation()
  const noLimit = t('access.plans.noLimit')
  return (
    <div className='flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs tabular-nums'>
      <span className='w-14 text-muted-foreground'>{t(WINDOW_LABEL[row.window])}</span>
      <span>
        {t('access.token.windowRequests', {
          used: fmtCount(row.requests),
          limit: row.requestLimit === null ? noLimit : fmtCount(row.requestLimit)
        })}
      </span>
      <span className='text-muted-foreground'>·</span>
      <span>
        {t('access.token.windowSpend', {
          used: fmtCost(row.costUsd),
          limit: row.spendLimitUsd === null ? noLimit : fmtCost(row.spendLimitUsd)
        })}
      </span>
      <span className='text-muted-foreground'>·</span>
      <span className='text-muted-foreground'>
        {row.resetsAt === null
          ? t('access.token.windowIdle')
          : t('access.token.windowResets', { at: row.resetsAt.slice(0, 16).replace('T', ' ') })}
      </span>
    </div>
  )
}

export function TokenUsageWindows({ token }: { token: AccessTokenWire }) {
  const { t } = useTranslation()
  const { confirm, dialog: confirmDialog } = useConfirm()
  const [usage, setUsage] = useState<TokenUsageWindowsWire | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api
      .getTokenUsageWindows(token.id)
      .then(setUsage)
      .catch(() => {
        // The field then reads as loading; the rest of the page still works.
      })
  }, [token])

  const reset = async () => {
    const { title, description } = splitConfirmMessage(t('access.token.resetConfirm', { name: token.name }))
    const confirmed = await confirm({
      title,
      description,
      confirmLabel: t('access.token.reset'),
      icon: 'ri-restart-line'
    })
    if (!confirmed) return
    setBusy(true)
    api
      .resetTokenUsageWindows(token.id)
      .then((next) => {
        setUsage(next)
        toast.success(t('access.token.windowsReset', { name: token.name }))
      })
      .catch((e: Error) => toast.error(t('access.token.resetFailed', { message: e.message })))
      .finally(() => setBusy(false))
  }

  return (
    <SettingsField label={t('access.token.windows')} hint={t('access.token.windowsHint')}>
      {usage === null ? (
        <div className='text-xs text-muted-foreground'>{t('common.loading')}</div>
      ) : (
        <div className='space-y-2'>
          {usage.limited ? null : (
            <div className='text-[12px] text-muted-foreground'>{t('access.token.windowsUnlimited')}</div>
          )}
          {usage.windows.map((row) => (
            <WindowRow key={row.window} row={row} />
          ))}
          <RButton variant='ghost' icon='ri-restart-line' onClick={reset} disabled={busy}>
            {t('access.token.reset')}
          </RButton>
        </div>
      )}
      {confirmDialog}
    </SettingsField>
  )
}
