/**
 * One preset, whole: identity, what it needs from you, and what it would
 * do to your config. Absorbs `PresetDetailDialog` + `DeletePresetDialog`.
 */
import { useTranslation } from 'react-i18next'
import { Pill, RButton } from '@/components/rialto/primitives'
import type { PresetDetail, RequiredInput } from '@/lib/presets/types'
import { missingInputIds, presetDiff } from '@/lib/rialto/settings-content/presets'
import type { Config } from '@/types'
import { ApplyDiff } from './ApplyDiff'
import { RequiredInputs } from './RequiredInputs'

function Header({
  preset,
  installed,
  onReapply,
  onDelete
}: {
  preset: PresetDetail
  installed: boolean
  onReapply: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const keywords = preset.keywords === undefined ? [] : preset.keywords
  return (
    <div className='flex items-center gap-3 border-b border-border px-6 py-4'>
      <div>
        <div className='flex items-center gap-2'>
          <h2 className='text-sm font-semibold'>{preset.name}</h2>
          <Pill tone='mute'>v{preset.version}</Pill>
          {installed ? (
            <Pill tone='ok'>{t('settings.presets.pillInstalled')}</Pill>
          ) : (
            <Pill tone='info'>{t('settings.presets.pillNotInstalled')}</Pill>
          )}
        </div>
        <p className='mt-0.5 text-[12px] text-muted-foreground'>
          {preset.author === undefined
            ? t('settings.presets.authorUnknown')
            : t('settings.presets.byAuthor', { author: preset.author })}
          {keywords.map((keyword) => (
            <span key={keyword} className='font-mono'>
              {' · '}
              {keyword}
            </span>
          ))}
        </p>
      </div>
      <div className='ml-auto flex gap-2'>
        <RButton variant='outline' icon='ri-refresh-line' onClick={onReapply}>
          {t('settings.presets.reapply')}
        </RButton>
        {installed ? (
          <RButton variant='ghost' icon='ri-delete-bin-line' onClick={onDelete}>
            {t('settings.access.delete')}
          </RButton>
        ) : null}
      </div>
    </div>
  )
}

/**
 * The one thing a preset cannot reach. Worth stating outright: the whole
 * reason applying a shared preset is safe is that OAuth-backed providers
 * are not manifest fields.
 */
function ApplyWarning() {
  const { t } = useTranslation()
  return (
    <div className='px-6 pb-6'>
      <div className='rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3'>
        <div className='flex items-center gap-2'>
          <i className='ri-alert-line text-sm text-amber-600 dark:text-amber-400' />
          <span className='text-xs font-medium'>{t('settings.presets.warnTitle')}</span>
        </div>
        <p className='mt-1.5 text-[12px] leading-relaxed text-muted-foreground'>{t('settings.presets.warnBody')}</p>
      </div>
    </div>
  )
}

export function PresetPane({
  preset,
  installed,
  config,
  values,
  storedIds,
  onChange,
  onReapply,
  onDelete
}: {
  preset: PresetDetail
  installed: boolean
  config: Config
  values: Record<string, unknown>
  storedIds: string[]
  onChange: (id: string, value: unknown) => void
  onReapply: () => void
  onDelete: () => void
}) {
  const schema: RequiredInput[] = preset.schema === undefined ? [] : preset.schema
  const presetConfig = preset.config === undefined ? {} : preset.config
  const missing = missingInputIds(schema, values, storedIds)

  return (
    <div className='min-w-0 overflow-y-auto'>
      <Header preset={preset} installed={installed} onReapply={onReapply} onDelete={onDelete} />

      {preset.description === undefined ? null : (
        <div className='px-6 py-4'>
          <p className='text-xs leading-relaxed text-muted-foreground'>{preset.description}</p>
        </div>
      )}

      <RequiredInputs
        schema={schema}
        presetConfig={presetConfig}
        values={values}
        storedIds={storedIds}
        missingCount={missing.length}
        onChange={onChange}
      />

      <ApplyDiff rows={presetDiff(preset.config, config)} />
      <ApplyWarning />
      <div className='h-6' />
    </div>
  )
}
