/**
 * Access tokens — the credentials that let clients into `/v1/*`.
 *
 * Top level rather than a Settings section. Providers answers "who does
 * Rialto send to"; this answers the same question pointed the other way,
 * and the two belong at the same depth. It also stopped fitting under
 * Settings once the rows carried per-token spend and the page behind
 * them carried rotation and revocation: a list you work through over
 * time is operations, not configuration.
 *
 * Settings → Access keeps the half that really is configuration — who
 * may administer this install: through Cloudflare Access, or from the
 * host itself.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Screen } from '@/components/rialto/Screen'
import { AccessTokensSection } from '@/components/rialto/settings/access/AccessTokensSection'
import { api, type InboundSurfaceWire } from '@/lib/api'

export function AccessTokens() {
  const { t } = useTranslation()
  const [surfaces, setSurfaces] = useState<InboundSurfaceWire[]>([])

  useEffect(() => {
    api
      .getInboundSurfaces()
      .then((res) => setSurfaces(res.surfaces))
      .catch(() => {
        // Labels and the scoping picker only. A failed probe leaves the
        // Endpoint column reading "all" rather than blocking the list.
      })
  }, [])

  return (
    <Screen subtitle={t('settings.access.tokensSubtitle')}>
      <AccessTokensSection surfaces={surfaces} />
      <div className='h-8' />
    </Screen>
  )
}
