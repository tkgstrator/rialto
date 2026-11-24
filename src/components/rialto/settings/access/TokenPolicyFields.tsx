import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { useConfig } from '@/components/ConfigProvider'
import { vendorLabel } from '@/components/rialto/providers/vendor-labels'
import { SelectPicker } from '@/components/rialto/SelectPicker'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import type { PlanWire } from '@/lib/api'
import { groupTargets, modelOf, providerOf } from '@/lib/rialto/settings/plans'
import {
  TOKEN_PROVIDER_MODES,
  type TokenFolder,
  type TokenPolicy,
  type TokenProviderMode,
  tokenProviderGroup
} from '@/shared/access-token-policy'
import { ModelProviderRules } from './ModelProviderRules'

function tokenFolderPath(folder: TokenFolder, folders: ReadonlyMap<string, TokenFolder>): string {
  const path = [folder.name]
  const next = { id: folder.parentId }
  // The server rejects cycles. The bound also handles an incomplete or stale listing.
  for (const _entry of folders) {
    if (next.id === null) break
    const parent = folders.get(next.id)
    if (parent === undefined) break
    path.unshift(parent.name)
    next.id = parent.parentId
  }
  return path.join(' / ')
}

export function FolderPicker({
  id,
  className,
  folders,
  value,
  onChange,
  label,
  disabled
}: {
  id?: string
  className?: string
  folders: readonly TokenFolder[]
  value: string | null
  onChange: (value: string | null) => void
  label?: string
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  return (
    <SelectPicker
      id={id}
      className={className || 'min-w-0 max-w-full'}
      label={label === undefined ? t('settings.access.folder') : label}
      value={value === null ? '' : value}
      disabled={disabled}
      onChange={(next) => onChange(next === '' ? null : next)}
      options={[
        { value: '', label: t('settings.access.folderRoot') },
        ...folders.map((folder) => ({ value: folder.id, label: tokenFolderPath(folder, byId) }))
      ]}
    />
  )
}

export function ProviderModeFields({
  value,
  onChange,
  disabled
}: {
  value: TokenProviderMode
  onChange: (value: TokenProviderMode) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const providerId = useId()
  return (
    <div className='grid gap-1'>
      <Label htmlFor={providerId} className='text-xs'>
        {t('settings.access.providerMode')}
      </Label>
      <SelectPicker
        id={providerId}
        className='w-full'
        label={t('settings.access.providerMode')}
        value={value}
        disabled={disabled}
        onChange={(next) => {
          const mode = TOKEN_PROVIDER_MODES.find((item) => item === next)
          if (mode !== undefined) onChange(mode)
        }}
        options={TOKEN_PROVIDER_MODES.map((mode) => ({
          value: mode,
          label: t(`settings.access.providerModes.${mode}`)
        }))}
      />
    </div>
  )
}

export function TokenPolicyFields({
  policy,
  onChange,
  available,
  plan,
  disabled
}: {
  policy: TokenPolicy
  onChange: (policy: TokenPolicy) => void
  available: readonly string[]
  plan: PlanWire | undefined
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const id = useId()
  const { config } = useConfig()
  const providers = config?.Providers || []
  const allowedByPlan = new Set(plan?.models)
  const targets = available.flatMap((target) => {
    if (plan !== undefined && !allowedByPlan.has(target)) return []
    const name = providerOf(target)
    const provider = providers.find((entry) => entry.name === name)
    const group = tokenProviderGroup(name, provider?.auth_mode || 'api_key')
    return [`${group},${modelOf(target)}`]
  })
  const groups = groupTargets(
    targets,
    policy.allowedModels.filter((model) => model.includes(','))
  )
  const legacy = policy.allowedModels.filter((model) => !model.includes(','))
  const selected = new Set(policy.allowedModels)
  const setModels = (models: readonly string[], checked: boolean) => {
    const next = new Set(policy.allowedModels)
    for (const model of models) {
      if (checked) next.add(model)
      else next.delete(model)
    }
    onChange({ ...policy, allowedModels: [...next] })
  }
  const modelRow = (model: string) => (
    <Label key={model} className='flex items-start gap-2 py-1 text-xs'>
      <Checkbox
        disabled={disabled}
        checked={selected.has(model)}
        onCheckedChange={(checked) => setModels([model], checked === true)}
      />
      <span className='break-all'>{modelOf(model)}</span>
    </Label>
  )

  return (
    <fieldset disabled={disabled} className='grid min-w-0 gap-3 text-xs'>
      <Label htmlFor={id} className='text-xs'>
        <Checkbox
          id={id}
          disabled={disabled}
          checked={policy.restrictModels}
          onCheckedChange={(checked) => onChange({ ...policy, restrictModels: checked === true })}
        />
        {t('settings.access.restrictModels')}
      </Label>
      {policy.restrictModels ? (
        <div className='grid max-h-56 gap-3 overflow-y-auto rounded-md border border-border p-3'>
          {groups.length === 0 && legacy.length === 0 ? t('settings.access.noEligibleModels') : null}
          {legacy.length > 0 ? (
            <div>
              <div className='font-medium'>{t('settings.access.anyProvider')}</div>
              {legacy.map(modelRow)}
            </div>
          ) : null}
          {groups.map((group) => {
            const label = vendorLabel(group.provider, group.provider)
            const count = group.targets.filter((target) => selected.has(target)).length
            return (
              <div key={group.provider}>
                <Label className='gap-2 text-xs font-medium'>
                  <Checkbox
                    disabled={disabled}
                    checked={count === group.targets.length ? true : count > 0 ? 'indeterminate' : false}
                    onCheckedChange={(checked) => setModels(group.targets, checked === true)}
                  />
                  {label}
                </Label>
                <div className='ml-6 mt-1'>{group.targets.map(modelRow)}</div>
              </div>
            )
          })}
        </div>
      ) : null}
      <ProviderModeFields
        value={policy.providerMode}
        disabled={disabled}
        onChange={(providerMode) => onChange({ ...policy, providerMode })}
      />
      <ModelProviderRules
        policy={policy}
        available={available}
        providers={providers}
        plan={plan}
        disabled={disabled}
        onChange={(modelProviderRules) => onChange({ ...policy, modelProviderRules })}
      />
    </fieldset>
  )
}
