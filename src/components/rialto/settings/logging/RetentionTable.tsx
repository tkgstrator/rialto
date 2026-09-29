/**
 * Stored-data table, over `GET /api/storage`.
 *
 * Each row is what one Activity view reads, so its name leads there — "how
 * big is this" and "what is in it" are the same question asked from two
 * ends. The names are the ones those views use, not table names: an
 * operator deleting old conversations should not have to know the rows
 * live in `Message`.
 *
 * The cutoff is not a saved retention policy: nothing stores one, and
 * `POST /api/storage/prune` requires an explicit cutoff on every call. So
 * the column is headed as the argument to the button beside it ("older
 * than"), which says what the button does without a footnote.
 */
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { RButton } from '@/components/rialto/primitives'
import { usePhone } from '@/hooks/use-phone'
import { fmtBytes } from '@/lib/rialto/settings/envelope'

export type StoreId = 'requestLog' | 'message' | 'usageSnapshot' | 'logFiles'

export interface StoreStats {
  id: StoreId
  /** Rows for a table, files for the log-file store. */
  count: number
  bytes: number
}

export interface StorageStats {
  stores: StoreStats[]
  generatedAt: string
}

/**
 * What each store is called, and the view that reads it. Conversations
 * have no list of their own — they are read per session — so that row
 * leads to Sessions.
 */
export const STORES: Record<StoreId, { labelKey: string; view: string }> = {
  requestLog: { labelKey: 'settings.logging.storeRequests', view: '/activity/requests' },
  message: { labelKey: 'settings.logging.storeConversations', view: '/activity' },
  usageSnapshot: { labelKey: 'settings.logging.storeUsage', view: '/activity/usage' },
  logFiles: { labelKey: 'settings.logging.storeLogFiles', view: '/activity/logs' }
}

/** Cutoffs offered for a delete. Explicit days, because the API demands one. */
export const CUTOFF_DAYS = [7, 30, 90, 365] as const

function CutoffSelect({ value, onChange, label }: { value: number; onChange: (days: number) => void; label: string }) {
  const { t } = useTranslation()
  return (
    <div className='relative inline-flex'>
      <select
        value={value}
        aria-label={t('settings.logging.pruneOlderThanLabel', { store: label })}
        onChange={(e) => onChange(Number(e.target.value))}
        className='inline-flex h-8 appearance-none items-center rounded-md border border-border bg-transparent pl-2.5 pr-7 text-xs transition-colors hover:bg-muted/60'
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
  const { labelKey, view } = STORES[store.id]
  const label = t(labelKey)
  return (
    <tr className='border-t border-border/60 transition-colors hover:bg-muted/50'>
      <td className='py-2.5 pl-6 pr-3'>
        <Link to={view} className='group inline-flex items-center gap-1.5 text-xs'>
          <span className='group-hover:underline'>{label}</span>
          <i className='ri-arrow-right-up-line text-sm text-muted-foreground' />
        </Link>
      </td>
      <td className='px-3 text-right font-mono text-xs tabular-nums text-muted-foreground'>
        {store.count.toLocaleString()}
      </td>
      <td className='px-3 text-right font-mono text-xs tabular-nums'>{fmtBytes(store.bytes)}</td>
      <td className='px-3'>
        <CutoffSelect value={cutoff} onChange={onCutoff} label={label} />
      </td>
      <td className='py-2.5 pl-3 pr-6 text-right'>
        {/* Red, like every action that cannot be taken back: the rows are
            deleted, not hidden, and a quiet text link undersold that. */}
        <RButton variant='danger' icon='ri-delete-bin-line' onClick={onPrune} disabled={pruning}>
          {t('settings.logging.pruneNow')}
        </RButton>
      </td>
    </tr>
  )
}

/**
 * One store at phone width: name and size on the first line, the cutoff
 * and the delete on the second. Five columns gave the name 40px and
 * pushed the button off the edge; the row count goes, since the size is
 * what a prune is weighed against.
 */
function StoreBlock({
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
  const { labelKey, view } = STORES[store.id]
  const label = t(labelKey)
  return (
    <div className='border-t border-border/60 px-4 py-3'>
      <div className='flex items-baseline gap-3'>
        <Link to={view} className='inline-flex min-w-0 items-center gap-1.5 text-xs'>
          <span className='truncate'>{label}</span>
          <i className='ri-arrow-right-up-line text-sm text-muted-foreground' />
        </Link>
        <span className='ml-auto shrink-0 font-mono text-xs tabular-nums'>{fmtBytes(store.bytes)}</span>
      </div>
      <div className='mt-2 flex items-center gap-2'>
        <span className='text-[12px] text-muted-foreground'>{t('settings.logging.colKeep')}</span>
        <CutoffSelect value={cutoff} onChange={onCutoff} label={label} />
        <RButton variant='danger' icon='ri-delete-bin-line' onClick={onPrune} disabled={pruning} className='ml-auto'>
          {t('settings.logging.pruneNow')}
        </RButton>
      </div>
    </div>
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
  const phone = usePhone()
  const cutoffOf = (store: StoreStats): number => {
    const days = cutoffs[store.id]
    return days === undefined ? 90 : days
  }
  if (phone) {
    return (
      <div>
        {stores.map((store) => (
          <StoreBlock
            key={store.id}
            store={store}
            cutoff={cutoffOf(store)}
            onCutoff={(d) => onCutoff(store.id, d)}
            onPrune={() => onPrune(store, cutoffOf(store))}
            pruning={pruning === store.id}
          />
        ))}
      </div>
    )
  }
  return (
    <table className='w-full table-fixed'>
      <colgroup>
        <col />
        <col className='w-24' />
        <col className='w-24' />
        <col className='w-32' />
        {/* Wide enough for the red button's icon and label in every
            locale; the text link it replaced fit in a w-24. */}
        <col className='w-40' />
      </colgroup>
      <thead>
        <tr className='text-[12px] uppercase tracking-wider text-muted-foreground/70 [&>th]:h-9 [&>th]:whitespace-nowrap [&>th]:align-bottom [&>th]:pb-2'>
          <th className='pl-6 pr-3 text-left font-medium'>{t('settings.logging.colStore')}</th>
          <th className='px-3 text-right font-medium'>{t('settings.logging.colCount')}</th>
          <th className='px-3 text-right font-medium'>{t('settings.logging.colSize')}</th>
          <th className='px-3 text-left font-medium'>{t('settings.logging.colKeep')}</th>
          <th className='pl-3 pr-6' />
        </tr>
      </thead>
      <tbody>
        {stores.map((store) => (
          <StoreRow
            key={store.id}
            store={store}
            cutoff={cutoffOf(store)}
            onCutoff={(d) => onCutoff(store.id, d)}
            onPrune={() => onPrune(store, cutoffOf(store))}
            pruning={pruning === store.id}
          />
        ))}
      </tbody>
    </table>
  )
}
