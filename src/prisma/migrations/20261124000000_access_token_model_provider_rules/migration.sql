-- Per-model billing-method rules on an access token. Existing tokens start
-- with none, so they keep following their token-wide provider mode.
ALTER TABLE "AccessToken" ADD COLUMN "modelProviderRules" JSONB NOT NULL DEFAULT '[]';
