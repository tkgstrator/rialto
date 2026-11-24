-- A `_first` provider mode now always allows falling back to the other billing
-- method, so the separate fallback flag goes away. A preferred method with the
-- flag off already behaved exactly like `_only`, so it is rewritten to that and
-- no token or folder changes behavior.

UPDATE "AccessToken" SET "providerMode" = 'subscription_only'
  WHERE "providerMode" = 'subscription_first' AND NOT "providerFallback";
UPDATE "AccessToken" SET "providerMode" = 'api_key_only'
  WHERE "providerMode" = 'api_key_first' AND NOT "providerFallback";

UPDATE "AccessTokenFolder" SET "defaultProviderMode" = 'subscription_only'
  WHERE "defaultProviderMode" = 'subscription_first' AND NOT "defaultProviderFallback";
UPDATE "AccessTokenFolder" SET "defaultProviderMode" = 'api_key_only'
  WHERE "defaultProviderMode" = 'api_key_first' AND NOT "defaultProviderFallback";

-- Per-model rules: the same rewrite inside the JSON, then drop each rule's
-- `fallback` key. Rule order is kept.
UPDATE "AccessToken" SET "modelProviderRules" = (
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'model', rule->'model',
        'mode', CASE
          WHEN rule->>'mode' LIKE '%\_first' AND (rule->>'fallback') IS DISTINCT FROM 'true'
            THEN to_jsonb(replace(rule->>'mode', '_first', '_only'))
          ELSE rule->'mode'
        END
      )
      ORDER BY position
    ),
    '[]'::jsonb
  )
  FROM jsonb_array_elements("modelProviderRules") WITH ORDINALITY AS rules(rule, position)
)
WHERE jsonb_typeof("modelProviderRules") = 'array' AND jsonb_array_length("modelProviderRules") > 0;

ALTER TABLE "AccessToken" DROP COLUMN "providerFallback";
ALTER TABLE "AccessTokenFolder" DROP COLUMN "defaultProviderFallback";
