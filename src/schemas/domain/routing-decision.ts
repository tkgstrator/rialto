import { z } from 'zod'

// The body is the exact serialized classifier request, not a reconstructed
// prompt. Keeping it out of ordinary log metadata preserves that boundary.
export const RoutingDecisionObservationSchema = z.object({
  requestBody: z.string().nonempty(),
  outcome: z.enum(['success', 'fallback']),
  reason: z.enum([
    'accepted',
    'http_error',
    'invalid_json',
    'invalid_response',
    'low_confidence',
    'timeout',
    'network_error'
  ]),
  predictedTier: z.string().nonempty().nullable(),
  confidence: z.number().finite().min(0).max(1).nullable(),
  probabilities: z.record(z.string().nonempty(), z.number().finite().min(0).max(1)).nullable(),
  chosenProbability: z.number().finite().min(0).max(1).nullable(),
  decisionAccepted: z.boolean(),
  minConfidence: z.number().finite().min(0).max(1),
  durationMs: z.number().int().nonnegative(),
  httpStatus: z.number().int().nullable(),
  expectedTier: z.null(),
  evaluationStatus: z.literal('unrated')
})

export type RoutingDecisionObservation = z.infer<typeof RoutingDecisionObservationSchema>
