import { useTranslation } from 'react-i18next'
import { RButton } from '@/components/rialto/primitives'
import { PlanEditorBody } from '@/components/rialto/settings/access/PlanEditorBody'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { PlanWire } from '@/lib/api'
import { type PlanDraft, planInputOf } from '@/lib/rialto/settings/plans'

export function PlanDialog({
  plan,
  draft,
  available,
  saving,
  onChange,
  onSubmit,
  onDelete,
  onCancel
}: {
  /** The plan being edited; null for a new one. */
  plan: PlanWire | null
  draft: PlanDraft
  /** Every `provider,model` the operator has left routable. */
  available: readonly string[]
  saving: boolean
  onChange: (next: PlanDraft) => void
  onSubmit: () => void
  onDelete: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const inUse = plan !== null && plan.tokenCount > 0

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <DialogContent aria-describedby={undefined} className='max-h-[calc(100vh-4rem)] overflow-y-auto sm:max-w-md'>
        <DialogHeader>
          <DialogTitle className='text-sm'>
            {t(plan === null ? 'access.plans.newTitle' : 'access.plans.editTitle')}
          </DialogTitle>
        </DialogHeader>

        <div className='grid gap-4'>
          <PlanEditorBody draft={draft} available={available} autoFocusName={plan === null} onChange={onChange} />
        </div>

        <div className='flex flex-col-reverse gap-2 sm:flex-row sm:items-center'>
          {/* Not in the mock, kept so a plan can still be removed: offered
              only while nothing is on the plan, since the server refuses
              the rest — removing a plan would lift its tokens' limits. */}
          {plan === null ? null : (
            <RButton
              variant='danger'
              icon='ri-delete-bin-line'
              onClick={onDelete}
              disabled={saving || inUse}
              title={inUse ? t('access.plans.deleteInUse') : undefined}
            >
              {t('settings.access.delete')}
            </RButton>
          )}
          <div className='flex flex-col-reverse gap-2 sm:ml-auto sm:flex-row'>
            <RButton variant='outline' onClick={onCancel}>
              {t('common.cancel')}
            </RButton>
            <RButton
              variant='primary'
              icon='ri-check-line'
              onClick={onSubmit}
              disabled={saving || planInputOf(draft) === null}
            >
              {t(plan === null ? 'access.plans.create' : 'common.save')}
            </RButton>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
