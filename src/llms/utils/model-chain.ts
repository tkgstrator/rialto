import { isProviderModelBlock, type RuntimeProvider } from '@/schemas/domain/pipeline'

/**
 * Whether a model has a conversion chain of its own on top of its provider's.
 *
 * A model whose `Model.apiStyle` differs from the provider's gets one
 * (`modelTransformerChains`), and the provider-level step has to stand aside
 * for it: the body must reach the model's step still unified, not already
 * shaped for the provider's wire format. The Chat step, for one, moves the
 * effort to `reasoning_effort` and deletes `reasoning` — a Responses step
 * after it would send that scalar upstream and lose the object.
 */
export function hasOwnModelChain(provider: RuntimeProvider, model: string | undefined): boolean {
  if (model === undefined) return false
  const block: unknown = provider.transformer?.[model]
  return isProviderModelBlock(block) && Array.isArray(block.use) && block.use.length > 0
}
