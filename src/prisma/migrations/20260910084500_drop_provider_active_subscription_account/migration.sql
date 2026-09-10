-- Drop the designated subscription account.
--
-- `activeSubscriptionAccountId` named one SubAccount per Provider, set at
-- Connect time and promoted by hand whenever that row was disabled. Every
-- reader has moved off it: which account serves a request is decided per
-- request by session-account-router, and "can this provider authenticate"
-- is now asked of the provider's accounts as a set
-- (src/shared/subscription-credential.ts).
--
-- Nothing is carried over. The column held a pointer, not data — the
-- SubAccount rows it pointed at are untouched, and after this every one
-- of them is a candidate rather than one being singled out.
ALTER TABLE "Provider" DROP CONSTRAINT IF EXISTS "Provider_activeSubscriptionAccountId_fkey";
ALTER TABLE "Provider" DROP COLUMN IF EXISTS "activeSubscriptionAccountId";
