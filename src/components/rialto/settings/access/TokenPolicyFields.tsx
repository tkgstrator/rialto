import { cn } from 'cn'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { RButton } from '@/components/rialto/primitives'
import { vendorLabel } from '@/components/rialto/providers/vendor-labels'
import { SelectPicker } from '@/components/rialto/SelectPicker'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import type { PlanWire } from '@/lib/api'
import { api, type TokenModelChoice } from '@/lib/api'
import { modelOf } from '@/lib/rialto/settings/plans'
import { TOKEN_PROVIDER_MODES, type TokenFolder, type TokenPolicy } from '@/shared/access-token-policy'
import { apiKeyVendorName } from '@/shared/custom-provider'

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
  value: Pick<TokenPolicy, 'providerMode' | 'providerFallback'>
  onChange: (value: Pick<TokenPolicy, 'providerMode' | 'providerFallback'>) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const fallbackId = useId()
  const providerId = useId()
  return (
    <div className='grid gap-2'>
      <div className='grid gap-1'>
        <Label htmlFor={providerId} className='text-xs'>
          {t('settings.access.providerMode')}
        </Label>
        <SelectPicker
          id={providerId}
          className='w-full'
          label={t('settings.access.providerMode')}
          value={value.providerMode}
          disabled={disabled}
          onChange={(next) => {
            const mode = TOKEN_PROVIDER_MODES.find((item) => item === next)
            if (mode !== undefined) onChange({ providerMode: mode, providerFallback: false })
          }}
          options={TOKEN_PROVIDER_MODES.map((mode) => ({
            value: mode,
            label: t(`settings.access.providerModes.${mode}`)
          }))}
        />
      </div>
      {value.providerMode.endsWith('_first') ? (
        <Label htmlFor={fallbackId} className='text-xs'>
          <Checkbox
            id={fallbackId}
            disabled={disabled}
            checked={value.providerFallback}
            onCheckedChange={(checked) => onChange({ ...value, providerFallback: checked === true })}
          />
          {t('settings.access.providerFallback')}
        </Label>
      ) : null}
    </div>
  )
}

export function TokenPolicyFields({
  policy,
  onChange,
  available,
  plan,
  scopes,
  disabled
}: {
  policy: TokenPolicy
  onChange: (policy: TokenPolicy) => void
  available: readonly string[]
  plan: PlanWire | undefined
  scopes: readonly string[]
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const id = useId()
  const [preview, setPreview] = useState<{ key: string; choices: TokenModelChoice[] } | null>(null)
  const [loading, setLoading] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const input = { scopes, planId: plan === undefined ? null : plan.id, policy }
  const previewKey = JSON.stringify(input)
  const shownPreview = preview?.key === previewKey ? preview : null
  const expanded = previewOpen && shownPreview !== null
  const requestPreview = async () => {
    setLoading(true)
    try {
      const { choices } = await api.previewTokenPolicy(input)
      setPreview({ key: previewKey, choices })
      setPreviewOpen(true)
    } catch (error) {
      toast.error(t('settings.access.listFailed', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setLoading(false)
    }
  }
  const targets = plan === undefined ? available : plan.models
  const models = [...new Set([...targets.map(modelOf), ...policy.allowedModels])].sort()

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
        <div className='max-h-40 overflow-y-auto rounded-md border border-border p-2'>
          {models.length === 0
            ? t('settings.access.noEligibleModels')
            : models.map((model, index) => (
                <label key={model} htmlFor={`${id}-model-${index}`} className='flex items-start gap-2 py-1'>
                  <Checkbox
                    id={`${id}-model-${index}`}
                    disabled={disabled}
                    checked={policy.allowedModels.includes(model)}
                    onCheckedChange={(checked) =>
                      onChange({
                        ...policy,
                        allowedModels:
                          checked === true
                            ? [...policy.allowedModels, model]
                            : policy.allowedModels.filter((name) => name !== model)
                      })
                    }
                  />
                  <span className='break-all'>{model}</span>
                </label>
              ))}
        </div>
      ) : null}
      <ProviderModeFields value={policy} disabled={disabled} onChange={(mode) => onChange({ ...policy, ...mode })} />
      <div>
        <RButton
          variant='outline'
          onClick={() => {
            if (expanded) setPreviewOpen(false)
            else if (shownPreview !== null) setPreviewOpen(true)
            else void requestPreview()
          }}
          disabled={loading}
          aria-expanded={expanded}
          aria-controls={`${id}-preview`}
        >
          {t(expanded ? 'settings.access.hidePolicyPreview' : 'settings.access.previewPolicy')}
        </RButton>
        <div
          id={`${id}-preview`}
          aria-hidden={!expanded}
          className={cn(
            'grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none',
            expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
          )}
        >
          <div className='min-h-0 overflow-hidden'>
            {shownPreview !== null ? (
              <ul className='mt-3 max-h-40 space-y-2 overflow-y-auto rounded-md border border-border p-2'>
                {shownPreview.choices.length === 0 ? (
                  <li>{t('settings.access.noEligibleModels')}</li>
                ) : (
                  shownPreview.choices.map((choice) => {
                    const vendor = choice.chosen === null ? null : apiKeyVendorName(choice.chosen)
                    return (
                      <li key={choice.model} className='break-all'>
                        {choice.model}
                        <span className='ml-2 text-muted-foreground'>
                          {vendor === null ? t('settings.access.ambiguousProvider') : vendorLabel(vendor, vendor)}
                        </span>
                      </li>
                    )
                  })
                )}
              </ul>
            ) : null}
          </div>
        </div>
      </div>
    </fieldset>
  )
}
