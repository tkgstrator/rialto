/**
 * The selector's constraints on the lane, as a footer to the chain they
 * constrain.
 *
 * These were a right rail. Four rows do not fill a page, so the rail ran
 * the full height beside a table that ended after five — a tall empty
 * column next to a short full one, with the emptier half taking 320px
 * from the chain and from the two bands above it. Four-up under the
 * table they still read as context you take in while reordering, and
 * they land in the space the rail was leaving blank anyway.
 */
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'

// bg-background so the cells sit on the 1px grid gap rather than letting
// the border colour show through them.
const ROW =
  'border-l-2 border-l-transparent bg-background px-4 py-3 transition-colors hover:border-l-border hover:bg-muted/50'

const readBool = (raw: Record<string, unknown> | null, key: string, fallback: boolean): boolean => {
  const value = raw === null ? undefined : raw[key]
  return typeof value === 'boolean' ? value : fallback
}

const readNum = (raw: Record<string, unknown> | null, key: string, fallback: number): number => {
  const value = raw === null ? undefined : raw[key]
  return typeof value === 'number' ? value : fallback
}

// Two directional gates read better as one four-state answer than as two
// booleans the operator has to combine in their head.
const substitutionLabel = (up: boolean, down: boolean, t: TFunction): string => {
  if (up && down) return t('routing.chain.substitutionUpDown')
  if (up) return t('routing.chain.substitutionUp')
  if (down) return t('routing.chain.substitutionDown')
  return t('routing.chain.substitutionSame')
}

function ConstraintRow({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className={ROW}>
      <div className='flex items-baseline gap-2'>
        <span className='text-xs'>{label}</span>
        <span className='ml-auto font-mono text-xs'>{value}</span>
      </div>
      <div className='mt-0.5 text-[12px] text-muted-foreground'>{hint}</div>
    </div>
  )
}

function ConstraintCells({ constraints }: { constraints: Record<string, unknown> | null }) {
  const { t } = useTranslation()
  const escalation = readBool(constraints, 'allowEscalation', true)
  const demotion = readBool(constraints, 'allowDemotion', true)
  const exhausted = constraints === null ? '429' : constraints.exhaustedBehavior
  return (
    <>
      <ConstraintRow
        label={t('routing.chain.tierSubstitution')}
        value={substitutionLabel(escalation, demotion, t)}
        hint={t('routing.chain.tierSubstitutionHint')}
      />
      <ConstraintRow
        label={t('routing.chain.weightFloor')}
        value={`${Math.round(readNum(constraints, 'healthinessThreshold', 0.05) * 100)}%`}
        hint={t('routing.chain.weightFloorHint')}
      />
      <ConstraintRow
        label={t('routing.chain.whenExhausted')}
        value={exhausted === 'passthrough' ? t('routing.common.modePassthrough') : '429'}
        hint={t('routing.chain.whenExhaustedHint')}
      />
      <ConstraintRow
        label={t('routing.chain.quotaSkip')}
        value={`${readNum(constraints, 'quotaSkipPct', 100)}%`}
        hint={t('routing.chain.quotaSkipHint')}
      />
    </>
  )
}

export function ChainConstraints({ constraints }: { constraints: Record<string, unknown> | null }) {
  const { t } = useTranslation()
  return (
    <div className='mt-6 border-t border-border'>
      <div className='px-6 pt-4 pb-2'>
        <h2 className='text-[12px] font-semibold uppercase tracking-wider text-muted-foreground'>
          {t('routing.chain.constraints')}
        </h2>
      </div>
      <div className='grid grid-cols-4 gap-px bg-border/60'>
        <ConstraintCells constraints={constraints} />
      </div>
    </div>
  )
}
