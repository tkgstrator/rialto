import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Pager } from '@/components/rialto/Pager'
import { enabledCountOf, hidesAsLegacy, listedModelsOf, type ModelRow, passesShow, type ShowMode } from './derive'
import { ModelsTable } from './ModelsTable'
import type { Provider, ReasoningEffort } from './types'

const SHOW_LABEL_KEYS: Record<ShowMode, string> = {
  priced: 'providers.models.showPriced',
  enabled: 'providers.models.showEnabled',
  all: 'providers.models.showAll'
}

// Each click widens the list from the default, then wraps.
const NEXT_SHOW: Record<ShowMode, ShowMode> = { enabled: 'priced', priced: 'all', all: 'enabled' }

/** Models per page on the api_key side. */
const PAGE = 8

function FilterBox({ value, onChange, wide }: { value: string; onChange: (v: string) => void; wide: boolean }) {
  const { t } = useTranslation()
  return (
    <div
      className={`flex h-7 items-center gap-2 rounded-md border border-border px-2.5 text-xs text-muted-foreground ${wide ? 'w-44' : ''}`}
    >
      <i className='ri-search-line text-sm' />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t(wide ? 'providers.models.filterModels' : 'providers.models.filter')}
        className='min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground'
      />
    </div>
  )
}

const NOTE_COMPONENTS = {
  mono: <span className='font-mono' />,
  strong: <span className='font-medium text-foreground' />
}

/**
 * The note under the table: how a model is reached at all, since nothing
 * in a row says it. OpenAI-style providers also explain their Effort column.
 */
function ModelsNote({
  isApiKey,
  hasEffort,
  claudeCode
}: {
  isApiKey: boolean
  hasEffort: boolean
  claudeCode: boolean
}) {
  return (
    <div className='px-6 py-4'>
      <div className='rounded-md border border-dashed border-border px-4 py-3 text-[12px] leading-relaxed text-muted-foreground'>
        <i className='ri-information-line mr-1 align-[-1px]' />
        {isApiKey ? (
          <>
            <Trans i18nKey='providers.models.noteApiKey' components={NOTE_COMPONENTS} />
            {hasEffort ? (
              <span className='mt-1.5 block'>
                <Trans
                  i18nKey={claudeCode ? 'providers.models.noteClaudeEffort' : 'providers.models.noteEffort'}
                  components={NOTE_COMPONENTS}
                />
              </span>
            ) : null}
          </>
        ) : (
          <>
            <Trans i18nKey='providers.models.noteSubscription' components={NOTE_COMPONENTS} />
            {hasEffort ? (
              <span className='mt-1.5 block'>
                <Trans
                  i18nKey={claudeCode ? 'providers.models.noteClaudeEffort' : 'providers.models.noteEffort'}
                  components={NOTE_COMPONENTS}
                />
              </span>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

export function ProviderModelsSection({
  provider,
  rows,
  editing,
  onToggle,
  onEffort
}: {
  provider: Provider
  rows: ModelRow[]
  editing: boolean
  onToggle: (model: string, next: boolean) => void
  onEffort: (model: string, next: ReasoningEffort | null) => void
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  // "Enabled only": what a provider is actually routing to is the
  // question this table is opened with. The priced slice is one click
  // away for the times the question is what else could be switched on.
  const [show, setShow] = useState<ShowMode>('enabled')
  const [page, setPage] = useState(0)
  // Subscription side only. The api_key side reveals legacy rows through
  // its Show control; this side has none, and hiding a row with no way
  // back would make a legacy model impossible to switch on again.
  const [showLegacy, setShowLegacy] = useState(false)
  const isApiKey = provider.auth_mode !== 'subscription'
  const claudeCode = !isApiKey && provider.api_style === 'anthropic'
  const hasEffort = claudeCode || provider.api_style === 'openai_chat' || provider.api_style === 'openai_responses'

  const hidesLegacy = !isApiKey && !showLegacy
  const legacyHidden = hidesLegacy ? rows.filter(hidesAsLegacy).length : 0
  const needle = query.trim().toLowerCase()
  const filtered = rows.filter(
    (r) =>
      r.name.toLowerCase().includes(needle) && (!isApiKey || passesShow(r, show)) && (!hidesLegacy || !hidesAsLegacy(r))
  )
  // Subscription providers list a curated handful; only the api_key side
  // is long enough that paging earns its footer row.
  //
  // Paged rather than the "show 8 more" expander this used to be. On a
  // 61-model vendor that button ends in a 61-row table with no way back
  // up, and it can never say where you are — the range footer does both,
  // and it is the same control every other long list on the screen uses.
  //
  // The filters rebuild the list under the cursor, so a page index past
  // the new end has to fall back rather than render nothing.
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE))
  const current = isApiKey ? Math.min(page, pageCount - 1) : 0
  const offset = current * PAGE
  const shownCount = isApiKey ? Math.min(PAGE, Math.max(0, filtered.length - offset)) : filtered.length

  return (
    <>
      <div className='flex items-center gap-3 px-6 pt-5 pb-3'>
        <h3 className='text-sm font-semibold'>{t('providers.models.title')}</h3>
        <span className='text-[12px] text-muted-foreground'>
          {t('providers.models.enabledCount', {
            enabled: enabledCountOf(provider),
            total: listedModelsOf(provider).length
          })}
        </span>
        {/* The count is the control that unfolds them, the way the
            revoked count is on Access tokens. A plain label would leave
            the rows unreachable and a separate switch would spend a
            control on a state most installs never look at. */}
        {legacyHidden === 0 ? null : (
          <button
            type='button'
            onClick={() => setShowLegacy(true)}
            className='text-[12px] text-muted-foreground underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground'
          >
            {t('providers.models.legacyHidden', { n: legacyHidden })}
          </button>
        )}
        {/* Filter, Show and the pager change what is on screen, not the
            provider, so they work whether or not the page is editing. */}
        <div className='ml-auto flex items-center gap-2'>
          {isApiKey ? (
            <button
              type='button'
              onClick={() => setShow(NEXT_SHOW[show])}
              className='inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs hover:bg-muted/60'
            >
              <span className='text-muted-foreground'>{t('providers.models.show')}</span> {t(SHOW_LABEL_KEYS[show])}
              <i className='ri-arrow-down-s-line text-sm text-muted-foreground' />
            </button>
          ) : null}
          <FilterBox value={query} onChange={setQuery} wide={isApiKey} />
        </div>
      </div>
      <ModelsTable
        rows={filtered}
        limit={isApiKey ? PAGE : undefined}
        offset={offset}
        withOverride={hasEffort}
        effortKind={claudeCode ? 'claude-code' : 'openai'}
        withAlias
        editable={editing}
        onToggle={onToggle}
        onEffort={onEffort}
      />
      <ModelsNote isApiKey={isApiKey} hasEffort={hasEffort} claudeCode={claudeCode} />
      {isApiKey ? (
        <Pager page={current} pageSize={PAGE} loaded={shownCount} total={filtered.length} onPage={setPage} />
      ) : null}
      <div className={isApiKey ? 'h-6' : 'h-8'} />
    </>
  )
}
