/**
 * The Chain view when the selected surface does not go through the router.
 *
 * The preference chain is not just irrelevant here, it would be actively
 * misleading — nothing in it runs. What matters instead is the set of
 * `provider,model` strings a caller is allowed to name, so that is what
 * the screen shows.
 */
import { useCallback, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Pill, RButton } from '@/components/rialto/primitives'
import type { InboundSurfaceWire, RoutingSchedulerWeightEntry } from '@/lib/api'
import { STATE_LABEL_KEYS, STATE_TONE, targetState } from './derive'
import type { EnabledTarget } from './types'

const copy = (text: string): void => {
  // Clipboard access is permission-gated and absent over plain http; a
  // refused copy should leave the table alone rather than throw into the
  // render tree.
  navigator.clipboard?.writeText(text).catch(() => {})
}

function ReachableRow({ entry, live }: { entry: EnabledTarget; live: RoutingSchedulerWeightEntry | undefined }) {
  const { t } = useTranslation()
  const state = targetState(live)
  return (
    <tr className='border-t border-border/60 transition-colors hover:bg-muted/50'>
      <td className='py-2.5 pl-6 pr-2 font-mono text-xs'>{entry.target}</td>
      <td className='px-2'>{entry.tier === null ? null : <Pill tone='mute'>{entry.tier}</Pill>}</td>
      <td className='px-2'>
        <Pill tone={STATE_TONE[state]}>{t(STATE_LABEL_KEYS[state])}</Pill>
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
  weights
}: {
  surface: InboundSurfaceWire
  targets: readonly EnabledTarget[]
  weights: Map<string, RoutingSchedulerWeightEntry>
}) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const copyAll = useCallback(() => {
    copy(targets.map((t) => t.target).join('\n'))
    setCopied(true)
  }, [targets])

  return (
    <>
      {/* Own the gap: this heading is the first thing under the mode bar,
          so it cannot lean on a preceding block for spacing. */}
      <div className='flex items-center gap-3 px-6 pt-6 pb-3'>
        <h2 className='text-sm font-semibold'>{t('routing.chain.reachableTargets')}</h2>
        <span className='text-[12px] text-muted-foreground'>
          <Trans i18nKey='routing.chain.reachableHint' components={{ mono: <span className='font-mono' /> }} />
        </span>
        <div className='ml-auto'>
          <RButton variant='outline' icon='ri-file-copy-line' onClick={copyAll}>
            {copied ? t('routing.chain.copied') : t('routing.chain.copyAsList')}
          </RButton>
        </div>
      </div>

      <table className='w-full table-fixed'>
        <colgroup>
          <col />
          <col className='w-24' />
          <col className='w-24' />
          <col className='w-16' />
        </colgroup>
        <thead>
          <tr className='text-[12px] uppercase tracking-wider text-muted-foreground/70 [&>th]:pb-2'>
            <th className='pl-6 pr-2 text-left font-medium'>{t('routing.common.colTarget')}</th>
            <th className='px-2 text-left font-medium'>{t('routing.common.colTier')}</th>
            <th className='px-2 text-left font-medium'>{t('routing.common.colState')}</th>
            <th className='pl-2 pr-6' />
          </tr>
        </thead>
        <tbody>
          {targets.map((entry) => (
            <ReachableRow key={entry.target} entry={entry} live={weights.get(entry.target)} />
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
