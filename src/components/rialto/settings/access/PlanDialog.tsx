/**
 * New / edit plan, as a dialog over the Plans list.
 *
 * Providers first, then that provider's models: an install can have
 * dozens of models across a handful of providers, and one flat list of
 * them is a scroll hunt. Each provider chip counts what is ticked under
 * it out of what it has, so a choice made on another provider is never
 * out of sight. Select all · Clear act on every provider at once, and the
 * header checkbox of the provider on show on that provider alone — kept
 * out of the chips, so a chip only ever navigates.
 *
 * A tick for the allow-list and a radio for the default sit on the same
 * row, so the default can only ever be one of the allowed models. The
 * default is never picked for the operator: a change that removes it
 * clears it and disables Save, and Select all keeps one but never chooses
 * one. It is where every unlisted request goes, so moving it silently
 * could move a plan onto a costlier model.
 */
import { useId } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { RButton } from '@/components/rialto/primitives'
import { PlanEditorBody } from '@/components/rialto/settings/access/PlanEditorBody'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { PlanWire } from '@/lib/api'
import { type PlanDraft, planInputOf } from '@/lib/rialto/settings/plans'

/** Who an edit reaches, or that a new plan has nobody on it yet. */
function AppliesTo({ plan }: { plan: PlanWire | null }) {
  const { t } = useTranslation()
  return (
    <div className='rounded-md border border-dashed border-border px-3 py-2 text-[12px] leading-snug text-muted-foreground'>
      {plan === null ? (
        t('access.plans.createNote')
      ) : (
        <Trans
          i18nKey={plan.tokenCount === 1 ? 'access.plans.appliesToOne' : 'access.plans.appliesTo'}
          values={{ n: plan.tokenCount, name: plan.name }}
          components={{ strong: <span className='font-medium text-foreground' /> }}
        />
      )}
    </div>
  )
}

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
  const statusId = useId()
  const inUse = plan !== null && plan.tokenCount > 0

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <DialogContent className='max-h-[calc(100vh-4rem)] overflow-y-auto sm:max-w-md'>
        <DialogHeader>
          <DialogTitle className='text-sm'>
            {t(plan === null ? 'access.plans.newTitle' : 'access.plans.editTitle')}
          </DialogTitle>
        </DialogHeader>

        <div className='grid gap-4'>
          <PlanEditorBody
            draft={draft}
            available={available}
            statusId={statusId}
            autoFocusName={plan === null}
            onChange={onChange}
          />

          <AppliesTo plan={plan} />
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
            <RButton variant='ghost' onClick={onCancel}>
              {t('common.cancel')}
            </RButton>
            <RButton
              variant='primary'
              icon='ri-check-line'
              aria-describedby={statusId}
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
