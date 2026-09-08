/**
 * Retention table, over `GET /api/storage`.
 *
 * The Keep column is deliberately NOT a saved retention policy: nothing
 * stores one, and `POST /api/storage/prune` requires an explicit cutoff
 * on every call. So it reads as "prune older than", which is what the
 * button next to it actually does. What currently bounds each store —
 * usually nothing — rides under the store name instead, because
 * "unbounded" is the fact this panel exists to surface.
 */
import { useTranslation } from 'react-i18next'
import { Pill } from '@/components/rialto/primitives'
import { fmtBytes } from '@/lib/rialto/settings/envelope'

export type StoreId = 'requestLog' | 'message' | 'usageSnapshot' | 'logFiles'

export interface StoreStats {
  id: StoreId
  label: string
  /** Null for the log-file store, which has files rather than rows. */
  rows: number | null
  bytes: number
  /** What currently bounds the store, or null when nothing does. */
  retention: string | null
}

export interface StorageStats {
  stores: StoreStats[]
  generatedAt: string
}

/** Cutoffs offered for a prune. Explicit days, because the API demands one. */
export const CUTOFF_DAYS = [7, 30, 90, 365] as const

function CutoffSelect({ value, onChange, label }: { value: number; onChange: (days: number) => void; label: string }) {
  const { t } = useTranslation()
  return (
    <div className='relative inline-flex'>
      <select
        value={value}
        aria-label={t('settings.logging.pruneOlderThanLabel', { store: label })}
        onChange={(e) => onChange(Number(e.target.value))}
        className='inline-flex h-7 appearance-none items-center rounded-md border border-border bg-transparent pl-2.5 pr-7 text-xs transition-colors hover:bg-muted/60'
      >
        {CUTOFF_DAYS.map((d) => (
          <option key={d} value={d}>
            {t('settings.logging.days', { n: d })}
          </option>
        ))}
      </select>
      <i className='ri-arrow-down-s-line pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-sm text-muted-foreground' />
    </div>
  )
}

function StoreRow({
  store,
  cutoff,
  onCutoff,
  onPrune,
  pruning
}: {
  store: StoreStats
  cutoff: number
  onCutoff: (days: number) => void
  onPrune: () => void
  pruning: boolean
}) {
  const { t } = useTranslation()
  return (
    <tr className='border-t border-border/60 transition-colors hover:bg-muted/50'>
      <td className='py-2.5 pl-6 pr-3'>
        <div className='font-mono text-xs'>{store.label}</div>
        <div className='mt-0.5 text-[12px] text-muted-foreground'>
          {store.retention === null ? <Pill tone='warn'>{t('settings.logging.unbounded')}</Pill> : store.retention}
        </div>
      </td>
      <td className='px-3 text-right font-mono text-xs tabular-nums text-muted-foreground'>
        {store.rows === null ? '—' : store.rows.toLocaleString()}
      </td>
      <td className='px-3 text-right font-mono text-xs tabular-nums'>{fmtBytes(store.bytes)}</td>
      <td className='px-3'>
        <CutoffSelect value={cutoff} onChange={onCutoff} label={store.label} />
      </td>
      <td className='py-2.5 pl-3 pr-6 text-right'>
        <button
          type='button'
          onClick={onPrune}
          disabled={pruning}
          className='text-[12px] text-muted-foreground hover:text-destructive disabled:opacity-50'
        >
          {t('settings.logging.pruneNow')}
        </button>
      </td>
    </tr>
  )
}

export function RetentionTable({
  stores,
  cutoffs,
  onCutoff,
  onPrune,
  pruning
}: {
  stores: StoreStats[]
  cutoffs: Record<string, number>
  onCutoff: (id: StoreId, days: number) => void
  onPrune: (store: StoreStats, days: number) => void
  pruning: StoreId | null
}) {
  const { t } = useTranslation()
  return (
    <table className='w-full table-fixed'>
      <colgroup>
        <col />
        <col className='w-24' />
        <col className='w-24' />
        <col className='w-32' />
        <col className='w-24' />
      </colgroup>
      <thead>
        <tr className='text-[12px] uppercase tracking-wider text-muted-foreground/70 [&>th]:pb-2'>
          <th className='pl-6 pr-3 text-left font-medium'>{t('settings.logging.colStore')}</th>
          <th className='px-3 text-right font-medium'>{t('settings.logging.colRows')}</th>
          <th className='px-3 text-right font-medium'>{t('settings.logging.colSize')}</th>
          <th className='px-3 text-left font-medium'>{t('settings.logging.colPruneOlderThan')}</th>
          <th className='pl-3 pr-6' />
        </tr>
      </thead>
      <tbody>
        {stores.map((store) => {
          const days = cutoffs[store.id]
          const cutoff = days === undefined ? 90 : days
          return (
            <StoreRow
              key={store.id}
              store={store}
              cutoff={cutoff}
              onCutoff={(d) => onCutoff(store.id, d)}
              onPrune={() => onPrune(store, cutoff)}
              pruning={pruning === store.id}
            />
          )
        })}
      </tbody>
    </table>
  )
}
