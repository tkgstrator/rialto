import type { TFunction } from 'i18next'
import type { OverviewSpendRow } from '@/lib/api'

export const ROW_LINK = 'transition-colors hover:bg-muted/50 cursor-pointer'

// Spend is going up or down, and neither direction is an alarm on its
// own — a rise past a tenth is the one worth colouring.
export const deltaTone = (ratio: number): 'warn' | 'ok' | 'mute' => {
  if (ratio > 0.1) return 'warn'
  if (ratio < 0) return 'ok'
  return 'mute'
}

export const fmtDelta = (ratio: number): string => `${ratio > 0 ? '+' : ''}${Math.round(ratio * 100)}%`

export const SPEND_LABEL_KEYS: Record<OverviewSpendRow['label'], string> = {
  today: 'overview.spendToday',
  week: 'overview.spendWeek',
  month: 'overview.spendMonth',
  savedBySubscription: 'overview.spendSaved'
}

/** The window a section describes, as a period — "last 168h" is
 *  arithmetic, not a period anyone thinks in. */
export const windowMeta = (hours: number, t: TFunction): string =>
  hours >= 24 && hours % 24 === 0 ? t('overview.lastDays', { days: hours / 24 }) : t('overview.lastHours', { hours })
