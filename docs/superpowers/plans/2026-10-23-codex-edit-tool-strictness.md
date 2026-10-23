# Codex `Edit` Tool Strictness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Rialto from forcing the `Edit` function tool into strict mode while preserving its public name and original JSON Schema requirements.

**Architecture:** Remove the one name-specific branch from the generic Responses tool flattener. The existing Codex request shaper will then apply the same `strict: false` default used for every ordinary function tool.

**Tech Stack:** TypeScript, Bun test, Zod-based wire schemas, Biome

**Spec:** `docs/superpowers/specs/2026-10-23-codex-edit-tool-strictness-design.md`

## Global Constraints

- Target `develop`; do not bump the package version.
- Keep the caller-visible and Codex wire name exactly `Edit`.
- Do not add aliasing, response remapping, or retry behavior.
- Preserve the existing `WebSearch` and hosted `web_search` compatibility branches.
- Use Bun/Bunx only for JavaScript and TypeScript commands.

## Review Focus

- An optional `replace_all` field must remain optional; the new full-chain regression test asserts the original `required` list exactly.
- The exact case-sensitive tool name `Edit` must remain unchanged; the same regression test asserts the final wire name.
- Codex must receive `strict: false`; the same regression test asserts the final wire flag.
- Ordinary function tools must retain their established behavior; the existing `Read` chain assertion runs in the focused test file.
- Hosted `web_search` and `WebSearch` compatibility must not regress; the existing remapping tests run in the focused transformer test file.

---

### Task 1: Remove the legacy `Edit` schema rewrite

**Files:**
- Modify: `src/llms/transformers/openai/responses/request.ts:274`
- Test: `__tests__/llms/transformers/codex-request.test.ts`
- Verify: `__tests__/llms/transformers/openai-responses-request.test.ts`

**Interfaces:**
- Consumes: `remapTools(tools: UnifiedChatRequest['tools']): unknown[]`
- Produces: A flat Responses function tool whose name, parameters, and required list come from the unified tool; `shapeCodexBody` adds `strict: false` when absent.

- [ ] **Step 1: Write the failing full-chain regression test**

Add `does not force the Edit tool into strict mode` to `codex-request.test.ts`. Pass a unified `Edit` tool through the existing `toCodex` helper with properties `file_path`, `old_string`, `new_string`, and optional `replace_all`; assert the final tool has name `Edit`, the original three-entry `required` list, and `strict: false`.

- [ ] **Step 2: Run the regression test and verify RED**

Run: `bun test __tests__/llms/transformers/codex-request.test.ts`

Expected: FAIL because the current branch adds `replace_all` to `required` and returns `strict: true`.

- [ ] **Step 3: Implement the minimal fix**

Delete only the `tool.function.name === 'Edit'` branch from `remapTools` in `request.ts`. Leave generic flattening and both web-search branches unchanged.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `bun test __tests__/llms/transformers/codex-request.test.ts __tests__/llms/transformers/openai-responses-request.test.ts`

Expected: all focused tests pass with no warnings or errors.

- [ ] **Step 5: Run repository verification**

Run:

```bash
RIALTO_SKIP_LIVE_TESTS=1 bun test __tests__/
bunx tsc --noEmit
bunx biome check .
bun run build
```

Expected: every command exits 0. If an existing diagnostic or unrelated failure appears, record it by name and determine whether the change affects it before proceeding.

- [ ] **Step 6: Obtain independent read-only review**

Give a fresh reviewer the exact diff, changed-file hashes, design, plan, and verification output. Resolve every material finding and rerun affected checks.

- [ ] **Step 7: Commit, push, and open the PR**

Before any Git write, apply `/home/vscode/app/.codex/skills/gh-commit-identity/SKILL.md` and its native identity checker. Commit the design, plan, test, and production fix with an English Conventional Commit subject no longer than 128 counted characters, push the feature branch, and open a PR against `develop` with the root-cause evidence and verification results.
