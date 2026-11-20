import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { apiKeyVendorName } from '@/shared/custom-provider'
import type { Provider, ProviderTestResponse } from './types'

export function useProviderAccount(provider: Provider): ProviderTestResponse {
  const [account, setAccount] = useState<ProviderTestResponse | null>(null)
  const { name, enabled, api_key: key, auth_mode: authMode } = provider
  const organizationId = provider.organization_id
  const workspaceId = provider.workspace_id
  const projectId = provider.project_id
  const vendor = apiKeyVendorName(name)
  const shouldProbe = vendor === 'anthropic' ? !organizationId || !workspaceId : vendor === 'openai' && !projectId
  useEffect(() => {
    setAccount(null)
    if (enabled === false || authMode === 'subscription' || !key || !shouldProbe) return
    let active = true
    void api.post<ProviderTestResponse>('/providers/test', { name }).then(
      (result) => {
        if (active && result.success) setAccount(result)
      },
      () => {}
    )
    return () => {
      active = false
    }
  }, [key, enabled, name, authMode, shouldProbe])
  return {
    success: true,
    organizationId: organizationId || account?.organizationId,
    workspaceId: workspaceId || account?.workspaceId,
    projectId: projectId || account?.projectId
  }
}
