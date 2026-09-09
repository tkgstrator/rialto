/**
 * The Chain view when the selected surface does not go through the router.
 *
 * The preference chain is not just irrelevant here, it would be actively
 * misleading — nothing in it runs. What matters instead is the set of
 * `provider,model` strings a caller is allowed to name, so that is what
 * the screen shows.
 *
 * Two columns, and neither is a live reading. State went with the chain
 * table's: the scheduler only scores what a chain names, and a
 * passthrough surface names nothing, so the pill read `unknown` on every
 * row of every install. "Copy as list" went too — the per-row copy is
 * the one that gets used, and a header button that duplicates the whole
 * table into the clipboard was a control nobody reached for.
 */
import { Trans, useTranslation } from 'react-i18next'
import { Pill } from '@/components/rialto/primitives'
import type { InboundSurfaceWire } from '@/lib/api'
import type { EnabledTarget } from './types'

const copy = (text: string): void => {
  // Clipboard access is permission-gated and absent over plain http; a
  // refused copy should leave the table alone rather than throw into the
  // render tree.
  navigator.clipboard?.writeText(text).catch(() => {})
}

function ReachableRow({ entry }: { entry: EnabledTarget }) {
  const { t } = useTranslation()
  return (
    <tr className='border-t border-border/60 transition-colors hover:bg-muted/50'>
      <td className='py-2.5 pl-6 pr-2 font-mono text-xs'>{entry.target}</td>
      <td className='px-2'>{entry.tier === null ? null : <Pill tone='mute'>{entry.tier}</Pill>}</td>
      <td className='py-2.5 pl-2 pr-6 text-right'>
        <button
          type='button'
          aria-label={t('routing.chain.copyTarget', { target: entry.target })}
          onClick={() => copy(entry.target)}
          className='text-muted-foreground/60 hover:text-foreground'
        >
          <i className='ri-file-copy-line text-sm' />
        </button>
      </td>
    </tr>
  )
}

export function PassthroughPanel({
  surface,
  targets
}: {
  surface: InboundSurfaceWire
  targets: readonly EnabledTarget[]
}) {
  const { t } = useTranslation()

  return (
    <>
      {/* Band 3 of the passthrough half, at the same height and rule as
          the chain half's action band. It owns its gap: this heading is
          the first thing under the scope strip, so it cannot lean on a
          preceding block for spacing. */}
      <div className='flex items-center gap-3 border-b border-border px-6 py-2.5'>
        <h2 className='text-sm font-semibold'>{t('routing.chain.reachableTargets')}</h2>
        <span className='text-[12px] text-muted-foreground'>
          <Trans i18nKey='routing.chain.reachableHint' components={{ mono: <span className='font-mono' /> }} />
        </span>
      </div>

      <table className='w-full table-fixed'>
        <colgroup>
          <col />
          <col className='w-24' />
          <col className='w-16' />
        </colgroup>
        <thead>
          <tr className='text-[12px] uppercase tracking-wider text-muted-foreground/70 [&>th]:h-9 [&>th]:whitespace-nowrap [&>th]:align-bottom [&>th]:pb-2'>
            <th className='pl-6 pr-2 text-left font-medium'>{t('routing.common.colTarget')}</th>
            <th className='px-2 text-left font-medium'>{t('routing.common.colTier')}</th>
            <th className='pl-2 pr-6' />
          </tr>
        </thead>
        <tbody>
          {targets.map((entry) => (
            <ReachableRow key={entry.target} entry={entry} />
          ))}
        </tbody>
      </table>

      <div className='px-6 py-5'>
        <div className='rounded-md border border-dashed border-border px-4 py-3 text-[12px] leading-relaxed text-muted-foreground'>
          <i className='ri-lightbulb-line mr-1 align-[-1px]' />
          <Trans
            i18nKey='routing.chain.passthroughNote'
            values={{ client: surface.client }}
            components={{ mono: <span className='font-mono' /> }}
          />
        </div>
      </div>
      <div className='h-8' />
    </>
  )
}
