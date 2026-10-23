# Codex `Edit` Tool Strictness Design

## Intent

Stop Rialto from changing the semantics of a caller's `Edit` function tool. Artex sends this tool with `strict: false`, but Rialto currently singles out the exact name `Edit`, forces `strict: true`, and changes the schema so the optional `replace_all` argument becomes required.

## Goals

- Treat `Edit` like every other ordinary function tool in the OpenAI Responses conversion.
- Preserve the caller-visible and upstream-visible name `Edit`; no alias is needed.
- Let the Codex request shaper apply its normal `strict: false` default.
- Add a regression test that exercises the full Responses-to-Codex request chain.

## Non-goals

- Renaming Norma or Artex tools.
- Adding request-local tool-name aliases or response remapping.
- Changing retry behavior for transient empty or incomplete upstream responses.
- Changing the existing `WebSearch` or hosted `web_search` compatibility handling.

## Constraints

- The change targets `develop` and does not bump the package version.
- Generic OpenAI Responses behavior outside the obsolete `Edit` branch must remain unchanged.
- The implementation follows the existing Bun test, TypeScript, Biome, and build gates.

## Approaches considered

1. Rename `Edit` in Norma/Artex. This is broad because permissions, prompts, and tool dispatch all depend on the public tool name. Live forced-tool tests also showed that Codex accepts `Edit` unchanged.
2. Alias `Edit` only on the Codex wire and restore it on responses. This adds request-history, tool-choice, collision, and streaming-response machinery for a name that the upstream accepts.
3. Remove Rialto's legacy `Edit` schema rewrite. This is the selected approach because it fixes the deterministic mutation at its source and lets the existing Codex `strict: false` shaping apply uniformly.

## Design

Delete the `Edit`-specific branch in `remapTools`. The generic function-tool branch will flatten the tool without manufacturing a strict schema. Later, `shapeCodexBody` will add `strict: false`, exactly as it does for `Read` and other ordinary tools.

The regression test will send an `Edit` schema whose `replace_all` field is optional through `OpenAIResponsesTransformer` and `CodexOauthTransformer`, then assert that the final Codex body keeps the name, keeps the original required list, and carries `strict: false`. Existing focused transformer tests and the repository's required gates will guard unrelated behavior.
