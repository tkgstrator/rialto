/**
 * What step 3 adds for a Custom provider.
 *
 * Every other vendor arrives with a catalog of models. A hand-added endpoint
 * has only what it said when asked, so step 3 reports how that went and
 * always offers the way out: typing a model ID. The lookup is a one-shot at
 * connect time, so both pieces read it from the flow rather than asking
 * again.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RButton } from '@/components/rialto/primitives'
import { Input } from '@/components/ui/input'
import type { CustomModelsLookup } from '@/schemas/api/providers'
import { type ModelIdProblem, modelIdProblem } from './custom-form'

export interface CustomModelsProps {
  /** How the connect-time lookup went; null when this page never ran one. */
  lookup: CustomModelsLookup | null
  /** Model IDs the provider already lists, for the duplicate check. */
  listed: readonly string[]
  /** Resolves once the model is saved; rejects with the server's reason. */
  onAddModel: (id: string) => Promise<void>
}

/** The header paragraph: what the endpoint answered, and what to do next. */
export function CustomLookupNote({ lookup }: { lookup: CustomModelsLookup | null }) {
  const { t } = useTranslation()
  if (lookup === null) return <>{t('providers.connect.custom.models.unavailable')}</>
  if (lookup.status === 'found') return <>{t('providers.connect.custom.models.found', { count: lookup.count })}</>
  return (
    <>
      {t('providers.connect.custom.models.unavailable')}
      {/* The server's own words (status, address): the one fact that tells an
          operator whether the key, the path or the host is what is wrong. */}
      <span className='mt-1 block break-all font-mono'>{lookup.error}</span>
    </>
  )
}

// A literal key per case, so the locale checks can see every one of them.
function problemText(problem: ModelIdProblem, t: (key: string) => string): string | null {
  switch (problem) {
    case 'space':
      return t('providers.connect.custom.models.problemSpace')
    case 'duplicate':
      return t('providers.connect.custom.models.problemDuplicate')
    case 'empty':
      return null
  }
}

/** The row under the table: type an ID, add it. */
export function ManualModelAdd({ listed, onAddModel }: Pick<CustomModelsProps, 'listed' | 'onAddModel'>) {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const problem = modelIdProblem(value, listed)
  // An empty box is not a mistake, only an unfinished one: the button stays
  // off and nothing is flagged until something has been typed.
  const shown = problem === null ? null : problemText(problem, t)
  const submit = (): void => {
    if (problem !== null || saving) return
    setSaving(true)
    onAddModel(value.trim())
      // The box is cleared only on success: a refused add keeps what was
      // typed so it can be corrected, and the page raises the reason itself.
      .then(() => setValue(''))
      .catch(() => {})
      .finally(() => setSaving(false))
  }
  return (
    <form
      className='border-t border-border px-4 py-4 md:px-6'
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <label htmlFor='custom-model-id' className='mb-1 block text-[12px] text-muted-foreground'>
        {t('providers.connect.custom.models.manualTitle')}
      </label>
      <div className='flex items-center gap-2'>
        <Input
          id='custom-model-id'
          className='h-8 px-3 font-mono text-xs md:text-xs'
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t('providers.connect.custom.models.manualPlaceholder')}
          spellCheck={false}
          autoComplete='off'
          aria-invalid={shown === null ? undefined : true}
          aria-describedby='custom-model-note'
        />
        <span className='shrink-0'>
          <RButton type='submit' variant='outline' icon='ri-add-line' disabled={problem !== null || saving}>
            {t('providers.connect.custom.models.manualAdd')}
          </RButton>
        </span>
      </div>
      <p
        id='custom-model-note'
        className={`mt-1.5 text-[12px] leading-relaxed ${shown === null ? 'text-muted-foreground' : 'text-destructive'}`}
      >
        {shown === null ? t('providers.connect.custom.models.manualHint') : shown}
      </p>
    </form>
  )
}
