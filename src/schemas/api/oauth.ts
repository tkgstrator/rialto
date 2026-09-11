/**
 * Request / response shapes for the Codex device-code endpoints the
 * add-provider screen drives (POST /api/oauth/device/start,
 * POST /api/oauth/device/poll). The upstream shapes these are built from
 * live in wire/oauth.ts; this layer is what the browser actually sees,
 * so it never carries device_auth_id or anything else scoped to a
 * single poll against auth.openai.com.
 */

import { z } from '@hono/zod-openapi'

export const CodexDeviceStartResponseSchema = z
  .object({
    flowId: z.string().nonempty(),
    userCode: z.string().nonempty(),
    verificationUri: z.string().nonempty(),
    // Epoch ms. The client renders its own mm:ss countdown off this
    // rather than trusting a server-pushed timer, since the poll is
    // client-driven and no connection is held open to tick one down.
    expiresAt: z.number().int().nonnegative(),
    intervalSeconds: z.number().int().positive()
  })
  .openapi('CodexDeviceStartResponse')
export type CodexDeviceStartResponse = z.infer<typeof CodexDeviceStartResponseSchema>

export const CodexDevicePollRequestSchema = z
  .object({ flowId: z.string().nonempty() })
  .openapi('CodexDevicePollRequest')
export type CodexDevicePollRequest = z.infer<typeof CodexDevicePollRequestSchema>

// A failed poll (bad flowId aside) answers through the same
// `{ success: false, error }` shape every other /api/oauth/* failure
// uses, not a fourth member here — this union is only the three
// outcomes that mean "keep polling or stop", not "the request failed".
export const CodexDevicePollResponseSchema = z
  .discriminatedUnion('status', [
    z.object({ status: z.literal('pending') }),
    z.object({ status: z.literal('connected') }),
    z.object({ status: z.literal('expired') })
  ])
  .openapi('CodexDevicePollResponse')
export type CodexDevicePollResponse = z.infer<typeof CodexDevicePollResponseSchema>
