import { z } from '@hono/zod-openapi'

export const ModelProviderPrioritySchema = z
  .object({
    model: z.string().nonempty(),
    // All providers serving this bare name, preferred first.
    providers: z.array(z.string().nonempty()),
    // Explicitly ranked providers only; [] means unresolved ambiguity.
    preferredProviders: z.array(z.string().nonempty())
  })
  .openapi('ModelProviderPriority')
export type ModelProviderPriority = z.infer<typeof ModelProviderPrioritySchema>

export const ModelProviderPrioritiesResponseSchema = z
  .object({ models: z.array(ModelProviderPrioritySchema) })
  .openapi('ModelProviderPrioritiesResponse')
export type ModelProviderPrioritiesResponse = z.infer<typeof ModelProviderPrioritiesResponseSchema>

export const SetModelProviderPrioritiesSchema = z
  .object({ model: z.string().nonempty(), providers: z.array(z.string().nonempty()) })
  .openapi('SetModelProviderPriorities')

export const ModelProviderPrioritiesErrorSchema = z
  .object({ error: z.string().nonempty() })
  .openapi('ModelProviderPrioritiesError')
