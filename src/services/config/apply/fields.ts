/**
 * Pure field-normalization helpers used while diffing an incoming UI
 * payload against DB state. No Prisma transaction dependency, so these
 * stay free of the `Tx` type and avoid a circular import with apply.ts.
 */

// Normalize an incoming api_key for storage. "Unset" is always NULL in
// the DB — an empty / whitespace-only value from the wire is collapsed
// to null so '' can never creep back. A real null stays null (never
// coerced to ''); a present value is stored verbatim.
export const apiKeyForStorage = (raw: string | null): string | null => {
  if (raw === null) return null
  return raw.trim().length === 0 ? null : raw
}
