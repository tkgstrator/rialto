import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pill, RButton } from '@/components/rialto/primitives'
import { Screen } from '@/components/rialto/Screen'
import { api } from '@/lib/api'
import type { DecisionEvaluateResponse, DecisionStatusResponse } from '@/schemas/api/decisions'

type QuestionType = 'choice' | 'noul' | 'score'
type Option = { id: string; text: string }
const INITIAL_OPTIONS: Option[] = [
  { id: 'initial-1', text: 'A request to explain or summarize information' },
  { id: 'initial-2', text: 'A task that requires multi-step reasoning' }
]
const probability = (value: number): string => `${(value * 100).toFixed(1)}%`
const connectionMessageKey = (status: DecisionStatusResponse | null) =>
  status?.configured === false
    ? 'decisions.configure'
    : status?.configured
      ? status.shadowEnabled
        ? 'decisions.shadowOn'
        : 'decisions.shadowOff'
      : null

function ConnectionPanel({
  status,
  error,
  refresh
}: {
  status: DecisionStatusResponse | null
  error: string | null
  refresh: () => void
}) {
  const { t } = useTranslation()
  const messageKey = connectionMessageKey(status)
  const message = messageKey === null ? null : t(messageKey)
  const failure = status?.error ? status.error : error
  const hasDetails = [message, status?.model, failure].some(Boolean)
  return (
    <section className='border-b border-border'>
      <div className='flex flex-wrap items-center gap-3 px-6 py-3 max-md:px-4'>
        <h2 className='text-xs font-medium'>{t('decisions.connection')}</h2>
        <span className='text-[12px] text-muted-foreground max-md:order-last max-md:basis-full'>
          {t('decisions.connectionHint')}
        </span>
        <Pill tone={status?.ready ? 'ok' : 'mute'} className='ml-auto'>
          {status?.ready ? t('decisions.ready') : t('decisions.unavailable')}
        </Pill>
        <RButton variant='outline' icon='ri-refresh-line' onClick={refresh}>
          {t('decisions.refresh')}
        </RButton>
      </div>
      {hasDetails ? (
        <div className='space-y-2 px-6 pb-4 text-xs text-muted-foreground max-md:px-4'>
          {message ? <p>{message}</p> : null}
          {status?.model ? <p className='font-mono'>{status.model}</p> : null}
          {failure ? (
            <p role='alert' className='text-destructive'>
              {failure}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function ResultPanel({
  response,
  error,
  labels
}: {
  response: DecisionEvaluateResponse | null
  error: string | null
  labels: Record<string, string>
}) {
  const { t } = useTranslation()
  const result = response?.answers.task
  const title =
    result?.type === 'choice'
      ? `${result.choice} · ${probability(result.confidence)}`
      : result?.type === 'noul'
        ? probability(result.noul)
        : result?.score.toFixed(2)
  return (
    <section
      aria-live='polite'
      className='min-w-0 border-t border-border @min-[64rem]:border-l @min-[64rem]:border-t-0'
    >
      <div className='px-6 pt-6 pb-3 max-md:px-4'>
        <h2 className='text-sm font-semibold'>{t('decisions.result')}</h2>
        <p className='mt-1 text-[12px] leading-relaxed text-muted-foreground'>{t('decisions.shadowHint')}</p>
      </div>
      {error ? (
        <p role='alert' className='px-6 py-4 text-xs text-destructive max-md:px-4'>
          {error}
        </p>
      ) : null}
      {!result && !error ? (
        <p className='px-6 py-4 text-xs text-muted-foreground max-md:px-4'>{t('decisions.noResult')}</p>
      ) : null}
      {result ? (
        <div className='px-6 py-4 max-md:px-4'>
          <div className='text-lg font-semibold tabular-nums'>{title}</div>
          {result.type !== 'noul' ? (
            <div className='mt-4 space-y-3'>
              {Object.entries(result.probabilities)
                .sort((a, b) => b[1] - a[1])
                .map(([key, value]) => (
                  <div key={key} className='space-y-1'>
                    <div className='flex justify-between gap-3 text-xs'>
                      <span className='min-w-0 truncate'>
                        {result.type === 'score' && typeof result.legend[key] === 'string'
                          ? result.legend[key]
                          : labels[key] || key}
                      </span>
                      <span className='font-mono tabular-nums'>{probability(value)}</span>
                    </div>
                    <div className='h-1.5 overflow-hidden rounded-full bg-muted'>
                      <div className='h-full rounded-full bg-primary' style={{ width: probability(value) }} />
                    </div>
                  </div>
                ))}
            </div>
          ) : null}
          <p className='mt-4 font-mono text-xs text-muted-foreground'>
            {response?.model} · {response?.usage.input_tokens} {t('decisions.tokens')}
          </p>
        </div>
      ) : null}
    </section>
  )
}

// These fields belong to one question, so spacing groups them without
// the per-setting rules that the shared SettingsField deliberately draws.
function DecisionField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='space-y-2 px-6 py-4 max-md:px-4'>
      <div className='text-xs font-medium'>{label}</div>
      <div className='min-w-0'>{children}</div>
    </div>
  )
}

function CriteriaFields({
  options,
  type,
  change,
  remove,
  add
}: {
  options: Option[]
  type: QuestionType
  change: (id: string, value: string) => void
  remove: (id: string) => void
  add: () => void
}) {
  const { t } = useTranslation()
  if (type === 'noul') return null
  return (
    <fieldset aria-label={t('decisions.criteria')} className='min-w-0 space-y-2'>
      {options.map((option, index) => (
        <div key={option.id} className='flex items-center gap-2'>
          <span className='w-5 shrink-0 text-xs text-muted-foreground'>{index + 1}</span>
          <input
            aria-label={`${t('decisions.option')} ${index + 1}`}
            value={option.text}
            onChange={(event) => change(option.id, event.target.value)}
            maxLength={500}
            className='h-8 min-w-0 flex-1 rounded-md border border-border bg-transparent px-3 text-xs outline-none focus:border-foreground/40'
          />
          <button
            type='button'
            disabled={options.length <= 2}
            onClick={() => remove(option.id)}
            aria-label={`${t('decisions.removeOption')} ${index + 1}`}
            className='rounded-md px-2 py-1 text-muted-foreground hover:text-foreground disabled:opacity-40'
          >
            <i aria-hidden className='ri-close-line' />
          </button>
        </div>
      ))}
      <div className='pt-1'>
        <RButton
          variant='outline'
          icon='ri-add-line'
          disabled={options.length >= (type === 'score' ? 10 : 26)}
          onClick={add}
        >
          {t('decisions.addOption')}
        </RButton>
      </div>
    </fieldset>
  )
}

export function DecisionsScreen() {
  const { t } = useTranslation()
  const [status, setStatus] = useState<DecisionStatusResponse | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [state, setState] = useState('')
  const [instructions, setInstructions] = useState('Which option best describes the subagent task?')
  const [type, setType] = useState<QuestionType>('choice')
  const [options, setOptions] = useState<Option[]>(INITIAL_OPTIONS)
  const [response, setResponse] = useState<DecisionEvaluateResponse | null>(null)
  const [labels, setLabels] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    setStatusError(null)
    api
      .get<DecisionStatusResponse>('/decisions/status')
      .then(setStatus)
      .catch((cause: unknown) => {
        setStatus(null)
        setStatusError(cause instanceof Error ? cause.message : String(cause))
      })
  }, [])
  useEffect(() => refresh(), [refresh])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!status?.ready || busy) return
    setBusy(true)
    setError(null)
    setResponse(null)
    const descriptions = options.map((option) => option.text.trim())
    const criteria = Object.fromEntries(descriptions.map((text, index) => [String(index + 1), text]))
    const question =
      type === 'noul'
        ? { type, instructions: instructions.trim() }
        : type === 'score'
          ? { type, instructions: instructions.trim(), criteria: descriptions }
          : { type, instructions: instructions.trim(), criteria }
    try {
      const next = await api.post<DecisionEvaluateResponse>('/decisions/evaluate', {
        model: 'jeff-latest',
        state: state.trim(),
        questions: { task: question }
      })
      setLabels(criteria)
      setResponse(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const canSubmit =
    status?.ready === true &&
    state.trim().length > 0 &&
    instructions.trim().length > 0 &&
    (type === 'noul' || (options.length >= 2 && options.every((option) => option.text.trim().length > 0)))

  return (
    <Screen subtitle={t('decisions.subtitle')}>
      <div className='@container min-w-0'>
        <ConnectionPanel status={status} error={statusError} refresh={refresh} />
        <div className='grid min-w-0 grid-cols-1 @min-[64rem]:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]'>
          <section className='min-w-0 pb-6'>
            <div className='flex flex-wrap items-center gap-3 gap-y-2 px-6 pt-6 pb-3 max-md:px-4'>
              <h2 className='text-sm font-semibold'>{t('decisions.playground')}</h2>
              <span className='order-last basis-full text-[12px] leading-relaxed text-muted-foreground'>
                {t('decisions.englishHint')}
              </span>
              <div className='ml-auto'>
                <RButton
                  variant='primary'
                  icon='ri-play-line'
                  type='submit'
                  form='decision-form'
                  disabled={!canSubmit || busy}
                >
                  {busy ? t('decisions.running') : t('decisions.run')}
                </RButton>
              </div>
            </div>
            <form id='decision-form' onSubmit={submit}>
              <DecisionField label={t('decisions.state')}>
                <textarea
                  aria-label={t('decisions.state')}
                  value={state}
                  onChange={(event) => setState(event.target.value)}
                  maxLength={8000}
                  placeholder={t('decisions.statePlaceholder')}
                  className='h-28 w-full resize-y rounded-md border border-border bg-transparent px-3 py-2 text-xs outline-none focus:border-foreground/40'
                />
              </DecisionField>
              <DecisionField label={t('decisions.questionType')}>
                <div className='relative inline-flex'>
                  <select
                    aria-label={t('decisions.questionType')}
                    value={type}
                    onChange={(event) => {
                      const next = event.target.value
                      if (next === 'choice' || next === 'noul' || next === 'score') setType(next)
                    }}
                    className='h-8 w-40 appearance-none rounded-md border border-border bg-transparent pl-3 pr-8 text-xs outline-none focus:border-foreground/40'
                  >
                    <option value='choice'>choice</option>
                    <option value='noul'>noul</option>
                    <option value='score'>score</option>
                  </select>
                  <i
                    aria-hidden
                    className='ri-arrow-down-s-line pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground'
                  />
                </div>
              </DecisionField>
              <DecisionField label={t('decisions.instructions')}>
                <input
                  aria-label={t('decisions.instructions')}
                  value={instructions}
                  maxLength={500}
                  onChange={(event) => setInstructions(event.target.value)}
                  className='h-8 w-full rounded-md border border-border bg-transparent px-3 text-xs outline-none focus:border-foreground/40'
                />
              </DecisionField>
              {type !== 'noul' ? (
                <DecisionField label={t('decisions.criteria')}>
                  <CriteriaFields
                    options={options}
                    type={type}
                    change={(id, value) =>
                      setOptions((current) =>
                        current.map((option) => (option.id === id ? { ...option, text: value } : option))
                      )
                    }
                    remove={(id) => setOptions((current) => current.filter((option) => option.id !== id))}
                    add={() => setOptions((current) => [...current, { id: crypto.randomUUID(), text: '' }])}
                  />
                </DecisionField>
              ) : null}
            </form>
          </section>
          <ResultPanel response={response} error={error} labels={labels} />
        </div>
        <div className='h-10' />
      </div>
    </Screen>
  )
}
