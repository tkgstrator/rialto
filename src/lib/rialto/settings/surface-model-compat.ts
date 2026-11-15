import type { InboundSurfaceWire } from '@/lib/api'
import type { Provider } from '@/schemas/domain/provider'

type ApiStyle = 'openai_chat' | 'openai_responses' | 'anthropic' | 'gemini'
type InboundType = InboundSurfaceWire['inboundType']

const INBOUND_FOR_API_STYLE: Readonly<Record<ApiStyle, InboundType>> = {
  openai_chat: 'openai',
  openai_responses: 'openai',
  anthropic: 'anthropic',
  gemini: 'gemini'
}

export function targetApiStyle(target: string, providers: readonly Provider[]): ApiStyle | undefined {
  const comma = target.indexOf(',')
  if (comma < 0) return undefined
  const providerName = target.slice(0, comma)
  const model = target.slice(comma + 1)
  const provider = providers.find((p) => p.name === providerName)
  if (provider === undefined) return undefined
  return provider.modelApiStyles?.[model] ?? provider.api_style
}

/**
 * A target is compatible with a selected set of surfaces when at least one
 * selected surface's inbound type matches the target's api style. An empty
 * selected set means every surface is reachable, so every target passes.
 */
export function targetMatchesSurfaces(
  target: string,
  providers: readonly Provider[],
  allSurfaces: readonly InboundSurfaceWire[],
  selectedSurfaceIds: readonly string[]
): boolean {
  if (selectedSurfaceIds.length === 0) return true
  const style = targetApiStyle(target, providers)
  if (style === undefined) return true
  const expected = INBOUND_FOR_API_STYLE[style]
  return allSurfaces.some((s) => selectedSurfaceIds.includes(s.id) && s.inboundType === expected)
}
