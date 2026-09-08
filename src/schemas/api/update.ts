// The self-update check/perform endpoints.

import { z } from '@hono/zod-openapi'

// `force=true` skips the service's short-lived cache. The UI sends it
// only for the explicit "Check now" button — a screen mount must not be
// able to spend the anonymous GitHub rate limit one paint at a time.
export const UpdateCheckQuerySchema = z.object({
  force: z.enum(['true', 'false']).default('false')
})

export const UpdateCheckResponseSchema = z
  .object({
    // Whether the release feed actually answered. `hasUpdate: false`
    // used to carry both "you are current" and "the check failed", so an
    // install with no egress reported itself up to date and the UI had
    // no way to say otherwise.
    status: z.enum(['ok', 'error']),
    // The version this process is running. The UI used to print the
    // version compiled into its own bundle, which is the version the
    // browser last downloaded — after an image upgrade that is a stale
    // cache talking, not the server.
    currentVersion: z.string().nonempty(),
    // Null whenever the feed did not yield a usable version.
    latestVersion: z.string().nonempty().nullable(),
    hasUpdate: z.boolean(),
    // Release notes and permalink, null when the release carried none.
    changelog: z.string().nonempty().nullable(),
    releaseUrl: z.url().nullable(),
    publishedAt: z.string().nonempty().nullable(),
    checkedAt: z.string().nonempty(),
    // Why the check failed. Null when `status` is 'ok'.
    message: z.string().nonempty().nullable()
  })
  .openapi('UpdateCheckResponse')

export type UpdateCheckResponse = z.infer<typeof UpdateCheckResponseSchema>

export const UpdatePerformResponseSchema = z
  .object({
    success: z.boolean(),
    message: z.string().nonempty()
  })
  .openapi('UpdatePerformResponse')
