import { useEffect, useState } from 'react'
import { Screen } from '@/components/rialto/Screen'
import { AccessTokensSection } from '@/components/rialto/settings/access/AccessTokensSection'
import { api, type InboundSurfaceWire } from '@/lib/api'

export function AccessTokens() {
  const [surfaces, setSurfaces] = useState<InboundSurfaceWire[]>([])

  useEffect(() => {
    api
      .getInboundSurfaces()
      .then((res) => setSurfaces(res.surfaces))
      .catch(() => {})
  }, [])

  return (
    <Screen>
      <AccessTokensSection surfaces={surfaces} />
    </Screen>
  )
}
