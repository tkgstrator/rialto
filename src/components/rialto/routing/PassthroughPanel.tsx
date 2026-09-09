/**
 * The Chain view when the selected surface does not go through the router.
 *
 * The preference chain is not just irrelevant here, it would be actively
 * misleading — nothing in it runs. What matters instead is the set of
 * `provider,model` strings a caller is allowed to name, so that is what
 * the screen shows.
 *
 * There is no Share column, and not because it was dropped: passthrough
 * has no lane, no chain and no scheduler weights to take a slice of, so
 * a share is not a quantity that exists here. State went for a related
 * reason — the scheduler only scores what a chain names, so a passthrough
 * surface was `unknown` on every row of every install.
 *
 * The toggle is a different matter and does belong: "may a caller name
 * this model" is exactly the question this table answers, and `On` is
 * the switch that changes the answer.
 */
import { useCallback, useMemo, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useConfig } from '@/components/ConfigProvider'
import { Pill } from '@/components/rialto/primitives'
import { toggleModel } from '@/components/rialto/providers/actions'
import type { InboundSurfaceWire } from '@/lib/api'
import { cn } from '@/lib/utils'
import { reachableTargets } from './derive'
import type { ReachableTarget } from './types'

const copy = (text: string): void => {
  // Clipboard access is permission-gated and absent over plain http; a
  // refused copy should leave the table alone rather than throw into the
  // render tree.
  navigator.clipboard?.writeText(text).catch(() => {})
}

function ReachableRow({
  entry,
  busy,
  onToggle
}: {
  entry: ReachableTarget
  busy: boolean
  onToggle: (next: boolean) => void
}) {
  const { t } = useTranslation()
  return (
    <tr
      className={cn('border-t border-border/60 transition-colors hover:bg-muted/50', entry.enabled ? '' : 'opacity-45')}
    >
      <td className='py-2.5 pl-6 pr-2 font-mono text-xs'>{entry.target}</td>
      <td className='px-2'>{entry.tier === null ? null : <Pill tone='mute'>{entry.tier}</Pill>}</td>
      <td className='px-2 text-right'>
        <button
          type='button'
          disabled={busy}
          aria-label={t('providers.models.toggleModel', { model: entry.model })}
          onClick={() => onToggle(!entry.enabled)}
          className='inline-flex h-8 items-center disabled:pointer-events-none disabled:opacity-50'
        >
          <span
            className={cn(
              'inline-flex h-4 w-7 items-center rounded-full px-0.5 transition-colors',
              entry.enabled ? 'bg-foreground' : 'bg-muted-foreground/30'
            )}
          >
            <span
              className={cn(
                'size-3 rounded-full bg-background transition-transform',
                entry.enabled ? 'translate-x-3' : ''
              )}
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

export function PassthroughPanel({ surface }: { surface: InboundSurfaceWire }) {
  const { t } = useTranslation()
  const { config, reloadConfig } = useConfig()
  const [busy, setBusy] = useState(false)

  const targets = useMemo(() => (config === null ? [] : reachableTargets(config.Providers)), [config])
  const enabled = useMemo(() => targets.filter((entry) => entry.enabled), [targets])
  const disabled = useMemo(() => targets.filter((entry) => !entry.enabled), [targets])

  // Collapsed by default. A vendor catalog is mostly models an install
  // does not serve — a Gemini provider carries every preview and audio
  // variant Google publishes — so listing them inline buries the handful
  // a caller can actually name under the ones they cannot, under a
  // heading that promises the opposite. Expanded is how a row you just
  // switched off stays reachable: it moves into the group rather than
  // vanishing, and the count beside it goes up.
  const [showDisabled, setShowDisabled] = useState(false)
  const rows = showDisabled ? [...enabled, ...disabled] : enabled

  const onToggle = useCallback(
    (entry: ReachableTarget, next: boolean) => {
      const provider = config?.Providers.find((p) => p.name === entry.provider)
      if (provider === undefined) return
      setBusy(true)
      toggleModel(provider, entry.model, next)
        .then(reloadConfig)
        .catch(() => {
          // The row stays as it was; the config reload never happened, so
          // nothing on screen claims a write that did not land.
        })
        .finally(() => setBusy(false))
    },
    [config, reloadConfig]
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
          {rows.map((entry) => (
            <ReachableRow key={entry.target} entry={entry} busy={busy} onToggle={(next) => onToggle(entry, next)} />
          ))}
        </tbody>
      </table>

      <div className='flex items-center gap-3 border-t border-border/60 px-6 py-2.5'>
        <span className='text-[12px] text-muted-foreground'>
          {t('routing.common.targetCount', { n: enabled.length })}
        </span>
        {disabled.length === 0 ? null : (
          <button
            type='button'
            onClick={() => setShowDisabled((v) => !v)}
            className='-mx-2 flex h-8 items-center gap-1 rounded-md px-2 text-[12px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground'
          >
            <i className={showDisabled ? 'ri-arrow-down-s-line text-sm' : 'ri-arrow-right-s-line text-sm'} />
            {t('routing.chain.disabledCount', { n: disabled.length })}
          </button>
        )}
      </div>

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
