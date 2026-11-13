/**
 * Step 2 of the add-provider flow for the Custom card: describe an endpoint
 * Rialto has no catalog entry for.
 *
 * Every other vendor arrives with a name, an address and a wire format from
 * the catalog, so its step 2 only asks for a credential. Here the operator
 * supplies all four, and the form says what it will store (the address a
 * request goes to) before it is saved. Once the provider exists the fields
 * lock: changing an address or a key is the provider page's job, and a
 * second Connect on this form would only make a second provider by accident.
 */
import type { TFunction } from 'i18next'
import { Trans, useTranslation } from 'react-i18next'
import { Pill, RButton } from '@/components/rialto/primitives'
import { Input } from '@/components/ui/input'
import { CUSTOM_API_STYLES, CUSTOM_NAME_MAX_LENGTH, type CustomApiStyle } from '@/shared/custom-provider'
import { type AuthFailure, FailureCard } from './ConnectAuthStep'
import {
  CUSTOM_ENTRY,
  type CustomDraft,
  type CustomFieldProblem,
  customDraftProblems,
  customEndpointPreview
} from './custom-form'
import { vendorLabel } from './vendor-labels'

const FIELD_CLS = 'h-8 px-3 font-mono text-xs md:text-xs'
const NOTE_CLS = 'mt-1.5 text-[12px] leading-relaxed text-muted-foreground'
const PROBLEM_CLS = 'mt-1.5 text-[12px] leading-relaxed text-destructive'

// One literal key per case on purpose: a key built from the problem code
// would be invisible to the missing-key check the locale tests run.
function problemText(problem: CustomFieldProblem, t: TFunction): string {
  switch (problem) {
    case 'too_long':
      return t('providers.connect.custom.problem.tooLong', { max: CUSTOM_NAME_MAX_LENGTH })
    case 'charset':
      return t('providers.connect.custom.problem.charset')
    case 'reserved':
      return t('providers.connect.custom.problem.reserved')
    case 'taken':
      return t('providers.connect.custom.problem.taken')
    case 'invalid_base_url':
      return t('providers.connect.custom.problem.invalidBaseUrl')
  }
}

interface WireFormat {
  style: CustomApiStyle
  icon: string
  title: string
  body: React.ReactNode
}

const mono = { mono: <span className='font-mono' /> }

// The three shapes the request pipeline can already convert between, in the
// order the mock draws them. `gemini` is a real api_style but not one a
// hand-added endpoint is offered.
function wireFormats(t: TFunction): Record<CustomApiStyle, WireFormat> {
  return {
    anthropic: {
      style: 'anthropic',
      icon: 'ri-message-3-line',
      title: t('providers.connect.custom.formatAnthropic'),
      body: <Trans i18nKey='providers.connect.custom.formatAnthropicBody' components={mono} />
    },
    openai_chat: {
      style: 'openai_chat',
      icon: 'ri-chat-1-line',
      title: t('providers.connect.custom.formatChat'),
      body: <Trans i18nKey='providers.connect.custom.formatChatBody' components={mono} />
    },
    openai_responses: {
      style: 'openai_responses',
      icon: 'ri-loop-right-line',
      title: t('providers.connect.custom.formatResponses'),
      body: <Trans i18nKey='providers.connect.custom.formatResponsesBody' components={mono} />
    }
  }
}

// The card is the label and the radio inside it is visually hidden, so a
// click anywhere on the card and the arrow keys both pick a format without
// any script; the card takes the focus ring the hidden radio cannot show.
function FormatCard({
  format,
  selected,
  disabled,
  onSelect
}: {
  format: WireFormat
  selected: boolean
  disabled: boolean
  onSelect: () => void
}) {
  return (
    <label
      className={`rounded-md px-4 py-3 text-left has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50 ${
        selected
          ? 'border-2 border-foreground/40 bg-muted/40'
          : 'border border-border transition-colors hover:bg-muted/50'
      } ${disabled ? 'cursor-default opacity-45' : 'cursor-pointer'}`}
    >
      <input
        type='radio'
        name='custom-api-style'
        className='sr-only'
        checked={selected}
        disabled={disabled}
        onChange={onSelect}
      />
      <div className='flex items-center gap-2'>
        <i aria-hidden className={`${format.icon} text-sm ${selected ? '' : 'text-muted-foreground'}`} />
        <span className='text-xs font-medium'>{format.title}</span>
      </div>
      <p className='mt-1.5 text-[12px] leading-relaxed text-muted-foreground'>{format.body}</p>
    </label>
  )
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className='mb-1 block text-[12px] text-muted-foreground'>
        {label}
      </label>
      {children}
    </div>
  )
}

export interface ConnectCustomStepProps {
  draft: CustomDraft
  /** Names that are already providers, for the "taken" check. */
  existingNames: readonly string[]
  /** The provider's name once it exists; null while the form is still open. */
  createdName: string | null
  ready: boolean
  busy: boolean
  failure: AuthFailure | null
  now: number
  onChange: (next: CustomDraft) => void
  onConnect: () => void
}

export function ConnectCustomStep(props: ConnectCustomStepProps) {
  const { t } = useTranslation()
  const { draft, createdName, onChange } = props
  const locked = createdName !== null
  // A locked form is a finished one: whatever it was refused for, it was
  // accepted in the end, so it shows no complaints.
  const problems = locked ? { name: null, baseUrl: null } : customDraftProblems(draft, props.existingNames)
  const preview = problems.baseUrl === null ? customEndpointPreview(draft) : null
  const formats = wireFormats(t)

  return (
    <div className='@container min-w-0 overflow-y-auto'>
      <div className='border-b border-border px-6 py-4 @max-[40rem]:px-4'>
        <div className='flex items-center gap-2'>
          <h2 className='text-sm font-semibold'>{vendorLabel(CUSTOM_ENTRY.name, CUSTOM_ENTRY.displayName)}</h2>
          <Pill tone='mute'>{t('providers.connect.pillApiKey')}</Pill>
        </div>
        <p className='mt-1 text-[12px] leading-relaxed text-muted-foreground'>{t('providers.connect.custom.intro')}</p>
      </div>

      <div className='px-6 pt-5 pb-2 @max-[40rem]:px-4'>
        <h3 className='text-sm font-semibold'>{t('providers.connect.custom.heading')}</h3>
      </div>
      <form
        className='space-y-4 px-6 pb-5 @max-[40rem]:px-4'
        onSubmit={(e) => {
          e.preventDefault()
          if (props.ready && !props.busy && !locked) props.onConnect()
        }}
      >
        <Field id='custom-name' label={t('providers.connect.custom.fieldName')}>
          <Input
            id='custom-name'
            className={FIELD_CLS}
            value={draft.name}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
            placeholder={t('providers.connect.custom.namePlaceholder')}
            spellCheck={false}
            autoComplete='off'
            disabled={locked}
            aria-invalid={problems.name === null ? undefined : true}
            aria-describedby='custom-name-note'
          />
          <p id='custom-name-note' className={problems.name === null ? NOTE_CLS : PROBLEM_CLS}>
            {problems.name === null ? t('providers.connect.custom.nameHint') : problemText(problems.name, t)}
          </p>
        </Field>

        <Field id='custom-base-url' label={t('providers.connect.custom.fieldBaseUrl')}>
          <Input
            id='custom-base-url'
            className={FIELD_CLS}
            value={draft.baseUrl}
            onChange={(e) => onChange({ ...draft, baseUrl: e.target.value })}
            placeholder={t('providers.connect.custom.baseUrlPlaceholder')}
            spellCheck={false}
            autoComplete='off'
            disabled={locked}
            aria-invalid={problems.baseUrl === null ? undefined : true}
            aria-describedby='custom-base-url-note'
          />
          {problems.baseUrl === null ? (
            <>
              <p id='custom-base-url-note' className={NOTE_CLS}>
                <Trans i18nKey='providers.connect.custom.baseUrlHint' components={mono} />
              </p>
              {preview === null ? null : (
                <p className={`${NOTE_CLS} flex min-w-0 items-baseline gap-2`}>
                  <span className='shrink-0'>{t('providers.connect.custom.sendsTo')}</span>
                  <span className='min-w-0 truncate font-mono text-foreground' title={preview}>
                    {preview}
                  </span>
                </p>
              )}
            </>
          ) : (
            <p id='custom-base-url-note' className={PROBLEM_CLS}>
              {problemText(problems.baseUrl, t)}
            </p>
          )}
        </Field>

        <fieldset className='min-w-0'>
          <legend className='mb-1 text-[12px] text-muted-foreground'>
            {t('providers.connect.custom.fieldFormat')}
          </legend>
          <div className='grid grid-cols-3 gap-3 @max-[40rem]:grid-cols-1'>
            {CUSTOM_API_STYLES.map((style) => (
              <FormatCard
                key={style}
                format={formats[style]}
                selected={draft.style === style}
                disabled={locked}
                onSelect={() => onChange({ ...draft, style })}
              />
            ))}
          </div>
        </fieldset>

        <Field id='custom-api-key' label={t('providers.connect.custom.fieldApiKey')}>
          <Input
            id='custom-api-key'
            className={FIELD_CLS}
            value={draft.apiKey}
            onChange={(e) => onChange({ ...draft, apiKey: e.target.value })}
            placeholder={t('providers.connect.custom.apiKeyPlaceholder')}
            spellCheck={false}
            autoComplete='off'
            disabled={locked}
            aria-describedby='custom-api-key-note'
          />
          <p id='custom-api-key-note' className={NOTE_CLS}>
            {t('providers.connect.custom.apiKeyHint')}
          </p>
        </Field>

        {locked ? (
          <div className='rounded-md border border-dashed border-border px-4 py-3 text-[12px] leading-relaxed text-muted-foreground'>
            <i aria-hidden className='ri-information-line mr-1 align-[-1px]' />
            <Trans i18nKey='providers.connect.custom.locked' values={{ name: createdName }} components={mono} />
          </div>
        ) : (
          <div>
            <RButton type='submit' variant='primary' icon='ri-check-line' disabled={!props.ready || props.busy}>
              {t('providers.connect.custom.connect')}
            </RButton>
          </div>
        )}
      </form>
      {props.failure === null ? null : <FailureCard failure={props.failure} now={props.now} flush={false} />}
      <div className='h-6' />
    </div>
  )
}
