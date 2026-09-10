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
import { useCallback, useMemo, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Pill } from '@/components/rialto/primitives'
import type { InboundSurfaceWire, RoutingMode, SurfaceId } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { EnabledTarget } from './types'

const copy = (text: string): void => {
  // Clipboard access is permission-gated and absent over plain http; a
  // refused copy should leave the table alone rather than throw into the
  // render tree.
  navigator.clipboard?.writeText(text).catch(() => {})
}

function ReachableRow({
  entry,
  allowed,
  busy,
  onToggle
}: {
  entry: EnabledTarget
  allowed: boolean
  busy: boolean
  onToggle: (next: boolean) => void
}) {
  const { t } = useTranslation()
  return (
    <tr className={cn('border-t border-border/60 transition-colors hover:bg-muted/50', allowed ? '' : 'opacity-45')}>
      <td className='py-2.5 pl-6 pr-2 font-mono text-xs'>{entry.target}</td>
      <td className='px-2'>{entry.tier === null ? null : <Pill tone='mute'>{entry.tier}</Pill>}</td>
      <td className='px-2 text-right'>
        <button
          type='button'
          disabled={busy}
          aria-label={t('routing.chain.allowTarget', { target: entry.target })}
          onClick={() => onToggle(!allowed)}
          className='inline-flex h-8 items-center disabled:pointer-events-none disabled:opacity-50'
        >
          <span
            className={cn(
              'inline-flex h-4 w-7 items-center rounded-full px-0.5 transition-colors',
              allowed ? 'bg-foreground' : 'bg-muted-foreground/30'
            )}
          >
            <span
              className={cn('size-3 rounded-full bg-background transition-transform', allowed ? 'translate-x-3' : '')}
            />
          </span>
        </button>
      </td>
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
  targets,
  onSetDenied
}: {
  surface: InboundSurfaceWire
  targets: readonly EnabledTarget[]
  onSetDenied: (surface: SurfaceId, routingMode: RoutingMode, denied: readonly string[]) => Promise<void>
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const denied = useMemo(() => new Set(surface.deniedTargets), [surface.deniedTargets])

  const onToggle = useCallback(
    (target: string, next: boolean) => {
      const updated = new Set(denied)
      if (next) updated.delete(target)
      else updated.add(target)
      setBusy(true)
      onSetDenied(surface.id, surface.routingMode, [...updated])
        .catch(() => {
          // The row keeps the state it had: the surface list is only
          // replaced on a resolved write, so nothing on screen claims a
          // change that did not land.
        })
        .finally(() => setBusy(false))
    },
    [denied, onSetDenied, surface.id, surface.routingMode]
  )

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
          <col className='w-20' />
          <col className='w-16' />
        </colgroup>
        <thead>
          <tr className='text-[12px] uppercase tracking-wider text-muted-foreground/70 [&>th]:h-9 [&>th]:whitespace-nowrap [&>th]:align-bottom [&>th]:pb-2'>
            <th className='pl-6 pr-2 text-left font-medium'>{t('routing.common.colTarget')}</th>
            <th className='px-2 text-left font-medium'>{t('routing.common.colTier')}</th>
            <th className='px-2 text-right font-medium'>{t('routing.chain.colOn')}</th>
            <th className='pl-2 pr-6' />
          </tr>
        </thead>
        <tbody>
          {targets.map((entry) => (
            <ReachableRow
              key={entry.target}
              entry={entry}
              allowed={!denied.has(entry.target)}
              busy={busy}
              onToggle={(next) => onToggle(entry.target, next)}
            />
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
