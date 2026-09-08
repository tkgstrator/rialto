/**
 * Three-step progress bar for the add-provider flow.
 *
 * The flow replaces a stack of four dialogs that chained into each other.
 * A dialog stack is the wrong shape for something that branches (browser
 * OAuth vs. importing the CLI's credentials) and that fails often enough
 * to need a visible failure state.
 */
import { useTranslation } from 'react-i18next'
import { RButton } from '@/components/rialto/primitives'
import { cn } from '@/lib/utils'

export type StepState = 'done' | 'active' | 'todo'

const STEP_TONE: Record<StepState, string> = {
  done: 'bg-foreground text-background',
  active: 'bg-foreground text-background',
  todo: 'bg-muted text-muted-foreground'
}

function Step({ n, label, state }: { n: number; label: string; state: StepState }) {
  return (
    <div className='flex items-center gap-2'>
      <span
        className={cn('flex size-5 items-center justify-center rounded-full text-[11px] font-medium', STEP_TONE[state])}
      >
        {state === 'done' ? <i className='ri-check-line text-xs' /> : n}
      </span>
      <span className={cn('text-xs', state === 'todo' ? 'text-muted-foreground' : 'font-medium')}>{label}</span>
    </div>
  )
}

const LABEL_KEYS = ['providers.connect.stepVendor', 'providers.connect.stepAuth', 'providers.connect.stepModels']

const stateFor = (index: number, current: number): StepState => {
  if (index < current) return 'done'
  return index === current ? 'active' : 'todo'
}

export function ConnectStepBar({ current, onCancel }: { current: number; onCancel: () => void }) {
  const { t } = useTranslation()
  return (
    <div className='flex items-center gap-6 border-b border-border px-6 py-3'>
      {LABEL_KEYS.map((key, i) => (
        <div key={key} className='flex items-center gap-6'>
          {i === 0 ? null : <i className='ri-arrow-right-s-line text-sm text-muted-foreground/50' />}
          <Step n={i + 1} label={t(key)} state={stateFor(i + 1, current)} />
        </div>
      ))}
      <div className='ml-auto'>
        <RButton variant='ghost' onClick={onCancel}>
          {t('common.cancel')}
        </RButton>
      </div>
    </div>
  )
}
