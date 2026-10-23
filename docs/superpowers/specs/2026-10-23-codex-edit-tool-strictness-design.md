# Codex Request Compatibility Design

## Intent

Stop Rialto from changing the semantics of a caller's `Edit` function tool, and preserve a caller's supported Cyber access-program selection on Codex requests. Artex sends `Edit` with `strict: false`, but Rialto currently forces `strict: true` and makes `replace_all` required. Rialto's Codex shaper also omits the modern CLI's `access_programs` field, so an explicit `daybreak_blue` selection cannot reach the backend.

## Goals

- Treat `Edit` like every other ordinary function tool in the OpenAI Responses conversion.
- Preserve the caller-visible and upstream-visible name `Edit`; no alias is needed.
- Let the Codex request shaper apply its normal `strict: false` default.
- Add a regression test that exercises the full Responses-to-Codex request chain.
- Forward `access_programs.cyber` for the official `standard`, `daybreak_blue`, and `daybreak_red` values.
- Keep invalid, unknown, or null Cyber selections out of the upstream Codex request.

## Non-goals

- Renaming Norma or Artex tools.
- Adding request-local tool-name aliases or response remapping.
- Changing retry behavior for transient empty or incomplete upstream responses.
- Changing the existing `WebSearch` or hosted `web_search` compatibility handling.
- Enabling Daybreak access for accounts or projects that do not already have it.
- Selecting Daybreak implicitly when the caller did not request an access program.

## Constraints

- The change targets `develop` and does not bump the package version.
- Generic OpenAI Responses behavior outside the obsolete `Edit` branch must remain unchanged.
- Access-program state must remain confined to the Codex OAuth request path and must be recovered from the original request before the unified conversion drops provider-specific fields.
- The implementation follows the existing Bun test, TypeScript, Biome, and build gates.

## Approaches considered

1. Rename `Edit` in Norma/Artex. This is broad because permissions, prompts, and tool dispatch all depend on the public tool name. Live forced-tool tests also showed that Codex accepts `Edit` unchanged.
2. Alias `Edit` only on the Codex wire and restore it on responses. This adds request-history, tool-choice, collision, and streaming-response machinery for a name that the upstream accepts.
3. Remove Rialto's legacy `Edit` schema rewrite. This is the selected approach because it fixes the deterministic mutation at its source and lets the existing Codex `strict: false` shaping apply uniformly.

For Cyber access programs, reading the converted unified body is insufficient because provider-specific top-level fields are intentionally discarded. Passing the raw object through would also relay unsupported keys and values. The selected approach is to capture a validated `access_programs.cyber` value in `CodexCallerIntent`, alongside the caller options already recovered from the original request, and restore that normalized object only in the final Codex body.

## Design

Delete the `Edit`-specific branch in `remapTools`. The generic function-tool branch will flatten the tool without manufacturing a strict schema. Later, `shapeCodexBody` will add `strict: false`, exactly as it does for `Read` and other ordinary tools.

The regression test will send an `Edit` schema whose `replace_all` field is optional through `OpenAIResponsesTransformer` and `CodexOauthTransformer`, then assert that the final Codex body keeps the name, keeps the original required list, and carries `strict: false`. Existing focused transformer tests and the repository's required gates will guard unrelated behavior.

A second full-chain regression test will send `access_programs: { cyber: 'daybreak_blue' }` from a Responses caller and assert that the final Codex request contains the same selection. Table-driven negative cases will assert that null, unknown, and malformed values do not escape the Codex allow-list. The value is request-local; Rialto will not infer it from a model name or account state.
