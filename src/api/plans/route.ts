/**
 * Plans — what a token on one may spend. Admin-only (/api/*).
 *
 * An edit reaches every token on the plan at its next request. Delete is refused for a plan anything still uses,
 * because removing it would lift those tokens' limits.
 */

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { createPlan, deletePlan, getPlan, listPlans, updatePlan } from '../../services/plan-service'
import { validationErrorHook } from '../zod-response'

const RequestLimit = z.number().int().positive().max(2_147_483_647).nullable()
const SpendLimit = z.number().positive().nullable()

const LimitFields = {
  fiveHourRequestLimit: RequestLimit,
  fiveHourSpendLimitUsd: SpendLimit,
  sevenDayRequestLimit: RequestLimit,
  sevenDaySpendLimitUsd: SpendLimit
}

const PlanSchema = z
  .object({
    id: z.string().nonempty(),
    name: z.string().nonempty(),
    // `provider,model` ids a request may name.
    models: z.array(z.string().nonempty()),
    // Where any other model name, or none, is sent. Always one of `models`.
    defaultModel: z.string().nonempty(),
    // Limits per usage window (5 hours, 7 days), each null = no limit:
    // completions admitted, and USD spent at Rialto's pricing.
    ...LimitFields,
    tokenCount: z.number().int().nonnegative(),
    createdAt: z.string().nonempty(),
    updatedAt: z.string().nonempty()
  })
  .openapi('Plan')

const PlanBodySchema = z
  .object({
    name: z.string().nonempty(),
    models: z.array(z.string().nonempty()).nonempty(),
    defaultModel: z.string().nonempty(),
    ...LimitFields
  })
  .openapi('PlanRequest')

const ErrorSchema = z.object({ error: z.string().nonempty(), message: z.string().nonempty() })

const IdParams = z.object({ id: z.string().nonempty() })

export const plansRoute = new OpenAPIHono({ defaultHook: validationErrorHook })

plansRoute.openapi(
  createRoute({
    method: 'get',
    path: '/api/plans',
    responses: {
      200: {
        description: 'Every plan',
        content: { 'application/json': { schema: z.object({ plans: z.array(PlanSchema) }) } }
      }
    }
  }),
  async (c) => c.json({ plans: await listPlans() }, 200)
)

plansRoute.openapi(
  createRoute({
    method: 'post',
    path: '/api/plans',
    request: { body: { content: { 'application/json': { schema: PlanBodySchema } } } },
    responses: {
      200: { description: 'The new plan', content: { 'application/json': { schema: PlanSchema } } },
      400: { description: 'Not a valid plan', content: { 'application/json': { schema: ErrorSchema } } },
      409: { description: 'A plan with that name exists', content: { 'application/json': { schema: ErrorSchema } } }
    }
  }),
  async (c) => {
    const result = await createPlan(c.req.valid('json'))
    if (result.ok) return c.json(result.plan, 200)
    if (result.reason === 'duplicate-name') return c.json({ error: result.reason, message: result.message }, 409)
    return c.json({ error: result.reason, message: result.message }, 400)
  }
)

plansRoute.openapi(
  createRoute({
    method: 'get',
    path: '/api/plans/{id}',
    request: { params: IdParams },
    responses: {
      200: { description: 'One plan', content: { 'application/json': { schema: PlanSchema } } },
      404: { description: 'No such plan', content: { 'application/json': { schema: ErrorSchema } } }
    }
  }),
  async (c) => {
    const plan = await getPlan(c.req.valid('param').id)
    if (plan === null) return c.json({ error: 'not-found', message: 'No such plan.' }, 404)
    return c.json(plan, 200)
  }
)

plansRoute.openapi(
  createRoute({
    method: 'patch',
    path: '/api/plans/{id}',
    request: {
      params: IdParams,
      body: { content: { 'application/json': { schema: PlanBodySchema.partial().openapi('PlanUpdateRequest') } } }
    },
    responses: {
      200: { description: 'The updated plan', content: { 'application/json': { schema: PlanSchema } } },
      400: { description: 'Not a valid plan', content: { 'application/json': { schema: ErrorSchema } } },
      404: { description: 'No such plan', content: { 'application/json': { schema: ErrorSchema } } },
      409: { description: 'A plan with that name exists', content: { 'application/json': { schema: ErrorSchema } } }
    }
  }),
  async (c) => {
    const result = await updatePlan(c.req.valid('param').id, c.req.valid('json'))
    if (result.ok) return c.json(result.plan, 200)
    if (result.reason === 'not-found') return c.json({ error: result.reason, message: result.message }, 404)
    if (result.reason === 'duplicate-name') return c.json({ error: result.reason, message: result.message }, 409)
    return c.json({ error: result.reason, message: result.message }, 400)
  }
)

plansRoute.openapi(
  createRoute({
    method: 'delete',
    path: '/api/plans/{id}',
    request: { params: IdParams },
    responses: {
      200: { description: 'Deleted', content: { 'application/json': { schema: z.object({ deleted: z.boolean() }) } } },
      404: { description: 'No such plan', content: { 'application/json': { schema: ErrorSchema } } },
      409: { description: 'Tokens still use it', content: { 'application/json': { schema: ErrorSchema } } }
    }
  }),
  async (c) => {
    const result = await deletePlan(c.req.valid('param').id)
    if (result.ok) return c.json({ deleted: true }, 200)
    if (result.reason === 'not-found') return c.json({ error: result.reason, message: result.message }, 404)
    return c.json({ error: result.reason, message: result.message }, 409)
  }
)
