/**
 * What applying this preset would change.
 *
 * The old flow asked for confirmation without ever naming what it would
 * overwrite, so applying a shared preset could silently retarget the
 * default route. The diff is computed client-side from the manifest and
 * the live config, so it costs nothing to show before the operator
 * commits.
 */
import { useTranslation } from 'react-i18next'
import type { DiffRow } from '@/lib/rialto/settings-content/presets'

const MARK: Record<DiffRow['kind'], { glyph: string; className: string }> = {
  add: { glyph: '+', className: 'text-emerald-600 dark:text-emerald-400' },
  change: { glyph: '~', className: 'text-amber-600 dark:text-amber-400' },
  same: { glyph: '=', className: 'text-muted-foreground/50' }
}

function Row({ row }: { row: DiffRow }) {
  const mark = MARK[row.kind]
  return (
    <div className='flex gap-2'>
      <span className={`w-4 ${mark.className}`}>{mark.glyph}</span>
      {row.kind === 'same' ? (
        <span className='text-muted-foreground'>{row.label}</span>
      ) : (
        <span>
          {row.label}
          {row.name === null ? null : <span className='font-medium'> {row.name}</span>}
          {row.from === null ? null : (
            <>
              {' '}
              <span className='text-muted-foreground'>{row.from}</span> → <span>{row.to}</span>
            </>
          )}
        </span>
      )}
    </div>
  )
}

export function ApplyDiff({ rows }: { rows: DiffRow[] }) {
  const { t } = useTranslation()
  return (
    <>
      <div className='flex items-center gap-2 border-t border-border px-6 pt-5 pb-2'>
        <h3 className='text-sm font-semibold'>{t('settings.presets.whatItChanges')}</h3>
        <span className='text-[12px] text-muted-foreground'>{t('settings.presets.diffAgainst')}</span>
      </div>
      <div className='space-y-1 px-6 pb-5 font-mono text-[12px]'>
        {rows.length === 0 ? (
          <div className='text-muted-foreground'>{t('settings.presets.diffEmpty')}</div>
        ) : (
          rows.map((row) => <Row key={row.key} row={row} />)
        )}
      </div>
    </>
  )
}
