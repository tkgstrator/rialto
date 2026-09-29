/**
 * Personas at phone width: the library, or one persona — not both.
 *
 * The desktop screen is a 17rem list beside the editor, which on a phone
 * left the editor 100px and set the prompt one character per line. Here
 * the list is the screen until a persona is picked, and the persona then
 * has the whole width with a row back to the list above it — the same
 * two panes, taken one at a time.
 */
import { useTranslation } from 'react-i18next'
import type { InboundSurfaceWire } from '@/lib/api'
import type { PersonaDraft } from '@/lib/rialto/settings-content/persona'
import { PersonaDetail } from './PersonaDetail'
import { PersonaList } from './PersonaList'

export function PersonasPhone({
  personas,
  selected,
  activeId,
  surfaces,
  onSelect,
  onCreate,
  onRename,
  onEditPrompt,
  onToggleActive,
  onDuplicate,
  onDelete
}: {
  personas: PersonaDraft[]
  /** The persona picked in this visit; undefined shows the list. */
  selected: PersonaDraft | undefined
  activeId: string | null
  surfaces: InboundSurfaceWire[]
  onSelect: (id: string | null) => void
  onCreate: () => void
  onRename: (name: string) => void
  onEditPrompt: (prompt: string) => void
  onToggleActive: (id: string) => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  if (selected === undefined) {
    // Nothing is highlighted: with the list alone on screen there is no
    // open persona for a highlight to point at.
    return (
      <PersonaList personas={personas} selectedId={null} activeId={activeId} onSelect={onSelect} onCreate={onCreate} />
    )
  }
  return (
    <>
      <button
        type='button'
        onClick={() => onSelect(null)}
        className='flex w-full items-center gap-1 border-b border-border px-3 py-2.5 text-xs text-muted-foreground active:bg-muted/50'
      >
        <i aria-hidden className='ri-arrow-left-s-line text-base leading-none' />
        {t('settings.rail.personas')}
      </button>
      <PersonaDetail
        persona={selected}
        active={selected.id === activeId}
        surfaces={surfaces}
        onRename={onRename}
        onEditPrompt={onEditPrompt}
        onToggleActive={() => onToggleActive(selected.id)}
        onDuplicate={onDuplicate}
        onDelete={onDelete}
      />
    </>
  )
}
