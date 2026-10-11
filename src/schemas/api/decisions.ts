/** The admin API's System One wire contract, kept separate from LLM inbound surfaces. */
import { z } from '@hono/zod-openapi'

const InputDescriptionSchema = z.string().nonempty().max(8_000)
const CriterionSchema = z.string().nonempty().max(500)
const ResponseDescriptionSchema = z.union([
  z.string().nonempty(),
  z.record(z.string().nonempty(), z.unknown()),
  z.array(z.unknown())
])
const ProbabilitySchema = z.number().finite().min(0).max(1)

export const DecisionQuestionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('choice'),
    instructions: CriterionSchema.optional(),
    criteria: z
      .record(z.string().nonempty().max(40), CriterionSchema.nullable())
      .refine((values) => Object.keys(values).length >= 2 && Object.keys(values).length <= 254)
  }),
  z.strictObject({
    type: z.literal('noul'),
    instructions: CriterionSchema.optional(),
    criteria: z
      .strictObject({
        true: CriterionSchema.nullable().optional(),
        false: CriterionSchema.nullable().optional()
      })
      .nullable()
      .optional()
  }),
  z.strictObject({
    type: z.literal('score'),
    instructions: CriterionSchema.optional(),
    criteria: z.array(CriterionSchema).min(2).max(10)
  })
])

export const DecisionEvaluateRequestSchema = z
  .strictObject({
    state: InputDescriptionSchema,
    model: z.string().nonempty().max(100),
    questions: z
      .record(z.string().nonempty().max(40), DecisionQuestionSchema)
      .refine((values) => Object.keys(values).length > 0 && Object.keys(values).length <= 4)
  })
  .openapi('DecisionEvaluateRequest')
export type DecisionEvaluateRequest = z.infer<typeof DecisionEvaluateRequestSchema>

const AnswerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('choice'),
    choice: z.string().nonempty(),
    confidence: ProbabilitySchema,
    probabilities: z.record(z.string().nonempty(), ProbabilitySchema)
  }),
  z.object({ type: z.literal('noul'), noul: ProbabilitySchema }),
  z.object({
    type: z.literal('score'),
    score: z.number().finite().min(0),
    confidence: ProbabilitySchema,
    probabilities: z.record(z.string().nonempty(), ProbabilitySchema),
    legend: z.record(z.string().nonempty(), ResponseDescriptionSchema.nullable())
  })
])

export const DecisionEvaluateResponseSchema = z
  .object({
    model: z.string().nonempty(),
    answers: z.record(z.string().nonempty(), AnswerSchema),
    usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() })
  })
  .openapi('DecisionEvaluateResponse')
export type DecisionEvaluateResponse = z.infer<typeof DecisionEvaluateResponseSchema>

export const DecisionStatusResponseSchema = z
  .object({
    configured: z.boolean(),
    ready: z.boolean(),
    shadowEnabled: z.boolean(),
    model: z.string().nonempty().nullable(),
    error: z.string().nonempty().nullable()
  })
  .openapi('DecisionStatusResponse')
export type DecisionStatusResponse = z.infer<typeof DecisionStatusResponseSchema>

export const DecisionUpstreamErrorSchema = z.object({ error: z.string().nonempty() }).openapi('DecisionUpstreamError')
