/**
 * The prompt field.
 *
 * The mock draws the prompt as a `<pre>` that grows with its content, and
 * this screen also has to edit it — so the textarea is stacked on an
 * invisible copy of its own text in the same grid cell. The copy sets the
 * height; the textarea inherits it. That keeps one scroll region on the
 * pane instead of a nested one, which a long persona would otherwise get.
 */
import { useTranslation } from 'react-i18next'

export function PromptEditor({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const { t } = useTranslation()
  return (
    <div className='grid px-6 pb-6 font-mono text-[12px] leading-relaxed'>
      <div aria-hidden='true' className='invisible whitespace-pre-wrap break-words [grid-area:1/1]'>
        {`${value}\n`}
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        placeholder={t('settings.personas.promptPlaceholder')}
        className='resize-none overflow-hidden bg-transparent break-words whitespace-pre-wrap outline-none placeholder:text-muted-foreground [grid-area:1/1]'
      />
    </div>
  )
}
