import { apiKeyProviderBaseName } from './api-key-provider-id'

export const PROVIDER_PRIORITY_GROUPS = ['openai', 'anthropic'] as const
export type ProviderPriorityGroup = (typeof PROVIDER_PRIORITY_GROUPS)[number]

export function providerPriorityGroup(name: string): ProviderPriorityGroup | undefined {
  const vendor = apiKeyProviderBaseName(name)
  if (vendor === 'openai' || name === 'codex') return 'openai'
  if (vendor === 'anthropic' || name === 'claude-code') return 'anthropic'
}

export function compareProviderPriority(
  left: { name: string; routingPriority: number | null },
  right: { name: string; routingPriority: number | null }
): number {
  const a = left.routingPriority === null ? Infinity : left.routingPriority
  const b = right.routingPriority === null ? Infinity : right.routingPriority
  return a - b || left.name.localeCompare(right.name)
}
