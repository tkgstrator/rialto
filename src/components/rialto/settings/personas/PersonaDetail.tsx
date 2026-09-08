/**
 * The persona object view: identity, scope, prompt, and the rendered
 * result — the three routes (`/personas`, `/personas/view/:id`,
 * `/personas/edit/:id`) collapsed into one pane with no view/edit mode.
 */
import { useTranslation } from 'react-i18next'
import { Pill, RButton, SurfaceChip } from '@/components/rialto/primitives'
import type { InboundSurfaceWire } from '@/lib/api'
import { fmtCount } from '@/lib/rialto/format'
import { countWords, estimateTokens, type PersonaDraft } from '@/lib/rialto/settings-content/persona'
import { cn } from '@/lib/utils'
import { PersonaPreview } from './PersonaPreview'
import { PromptEditor } from './PromptEditor'

const WORDS = new Intl.NumberFormat('en-US')

/** The active-persona switch. Exactly one persona can be active at a time. */
function ActiveSwitch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  const { t } = useTranslation()
  return (
    <button
      type='button'
      onClick={onToggle}
      aria-pressed={on}
      title={t(on ? 'settings.personas.activeTitle' : 'settings.personas.makeActiveTitle')}
      className={cn(
        'inline-flex h-4 w-7 items-center rounded-full px-0.5 transition-colors',
        on ? 'bg-foreground' : 'bg-muted-foreground/40'
      )}
    >
      <span className={cn('size-3 rounded-full bg-background transition-transform', on ? 'translate-x-3' : '')} />
    </button>
  )
}

function PersonaHeader({
  persona,
  active,
  onRename,
  onToggleActive,
  onDuplicate,
  onDelete
}: {
  persona: PersonaDraft
  active: boolean
  onRename: (name: string) => void
  onToggleActive: () => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const words = countWords(persona.prompt)
  return (
    <div className='flex items-center gap-3 border-b border-border px-6 py-3'>
      <input
        value={persona.name}
        onChange={(e) => onRename(e.target.value)}
        aria-label={t('settings.personas.nameLabel')}
        className='flex h-8 max-w-xs flex-1 items-center rounded-md border border-border bg-transparent px-3 text-xs font-medium outline-none focus:border-foreground/40'
      />
      <Pill tone='info'>
        {t('settings.personas.wordsTokens', {
          words: WORDS.format(words),
          tokens: fmtCount(estimateTokens(persona.prompt))
        })}
      </Pill>
      <div className='ml-auto flex items-center gap-2'>
        <ActiveSwitch on={active} onToggle={onToggleActive} />
        <RButton variant='ghost' icon='ri-file-copy-line' onClick={onDuplicate}>
          {t('settings.personas.duplicate')}
        </RButton>
        <RButton variant='ghost' icon='ri-delete-bin-line' onClick={onDelete}>
          {t('settings.access.delete')}
        </RButton>
      </div>
    </div>
  )
}

/**
 * Which inbound surfaces the persona reaches.
 *
 * Read-only: a persona has no per-surface scope in the config, it is
 * injected on every routed request. So the chips report the surfaces'
 * real routing mode — a passthrough surface never sees the persona,
 * because passthrough traffic is not rewritten at all.
 */
function AppliesToBar({ surfaces }: { surfaces: InboundSurfaceWire[] }) {
  const { t } = useTranslation()
  return (
    <div className='flex items-center gap-2 border-b border-border px-6 py-2.5'>
      <span className='text-[12px] text-muted-foreground'>{t('settings.personas.appliesTo')}</span>
      {surfaces.map((surface) => (
        <SurfaceChip
          key={surface.id}
          path={surface.path}
          on={surface.routingMode === 'routed'}
          readOnlyHint={
            surface.routingMode === 'routed'
              ? t('settings.personas.surfaceRoutedHint', { path: surface.path })
              : t('settings.personas.surfacePassthroughHint', { path: surface.path })
          }
        />
      ))}
      <span className='mx-1 h-4 w-px bg-border' />
      <span className='text-[12px] text-muted-foreground'>{t('settings.personas.lane')}</span>
      {/* Not a control: persona injection is not lane-scoped, so there is
          nothing to choose. A disabled button still reads as a control
          someone is being denied, which is a different and wrong story. */}
      <span
        title={t('settings.personas.laneHint')}
        className='inline-flex h-7 items-center rounded-md border border-border px-2.5 text-[12px] text-muted-foreground'
      >
        {t('settings.personas.laneBoth')}
      </span>
    </div>
  )
}

export function PersonaDetail({
  persona,
  active,
  surfaces,
  onRename,
  onEditPrompt,
  onToggleActive,
  onDuplicate,
  onDelete
}: {
  persona: PersonaDraft
  active: boolean
  surfaces: InboundSurfaceWire[]
  onRename: (name: string) => void
  onEditPrompt: (prompt: string) => void
  onToggleActive: () => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className='min-w-0 overflow-y-auto'>
      <PersonaHeader
        persona={persona}
        active={active}
        onRename={onRename}
        onToggleActive={onToggleActive}
        onDuplicate={onDuplicate}
        onDelete={onDelete}
      />
      <AppliesToBar surfaces={surfaces} />

      <div className='grid grid-cols-2'>
        <div className='border-r border-border'>
          <div className='flex items-center gap-2 px-6 pt-4 pb-2'>
            <h3 className='text-sm font-semibold'>{t('settings.personas.prompt')}</h3>
            <span className='ml-auto text-[12px] text-muted-foreground'>{t('settings.personas.markdown')}</span>
          </div>
          <PromptEditor value={persona.prompt} onChange={onEditPrompt} />
        </div>
        <div>
          <div className='flex items-center gap-2 px-6 pt-4 pb-2'>
            <h3 className='text-sm font-semibold'>{t('settings.personas.preview')}</h3>
            <span className='ml-auto text-[12px] text-muted-foreground'>{t('settings.personas.asSent')}</span>
          </div>
          <PersonaPreview name={persona.name} prompt={persona.prompt} />
        </div>
      </div>
      <div className='h-6' />
    </div>
  )
}
