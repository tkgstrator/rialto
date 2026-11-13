# Decisions API Disable Save Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Save the latest Decisions API routing settings, including an explicit disabled state.

**Architecture:** Keep the current routing profile hook and PUT shape. Make the memoized save callback follow all Decisions API state values, and cover the user-visible edit/save flow with a browser test that observes the request body.

**Tech Stack:** React 19, TypeScript, Bun test, Playwright

**Spec:** `docs/superpowers/specs/2026-10-23-decision-api-disable-save-design.md`

## Global Constraints

- Keep the profile PUT API unchanged.
- Add no dependency or version changes.
- Preserve all non-Decisions routing constraints.

## Review Focus

- Turning Decisions API off writes `false`, not the previously loaded `true`.
- Editing any Decisions API text or numeric field recreates the save callback with the latest value.
- Saving still re-reads the profile after a successful PUT.
- Empty optional text fields remain `null` on the wire.
- Existing route and escalation edits retain their current behavior.

---

### Task 1: Save current Decisions API state

**Files:**
- Modify: `src/components/rialto/routing/data.ts`
- Create: `__tests__/e2e/routing-decision-save.test.ts`

**Interfaces:**
- Consumes: `ScenarioProfileState` setters and `api.putTierProfile(key, profile)`
- Produces: a PUT whose `constraints` contain the latest Decisions API editor values

- [ ] **Step 1: Write the failing browser regression**

Start with a profile whose `decisionEnabled` is `true`, enter edit mode, uncheck it, save, and assert the intercepted PUT carries the literal `false`.

- [ ] **Step 2: Run the regression against the current implementation**

Run: `bun test __tests__/e2e/routing-decision-save.test.ts`

Expected: FAIL when an E2E server is available because the PUT carries `true`; otherwise document the environment skip and use the existing lint diagnostic as red evidence.

- [ ] **Step 3: Fix the callback dependencies**

Add `decisionEnabled`, `decisionApiBaseUrl`, `decisionApiKeyEnv`, `decisionModel`, `decisionMinConfidence`, and `decisionTimeoutMs` to the `save` callback dependency list.

- [ ] **Step 4: Verify the focused behavior and static checks**

Run the E2E regression where available, `bunx biome check src/components/rialto/routing/data.ts __tests__/e2e/routing-decision-save.test.ts`, `bunx tsc -b --noEmit`, and relevant routing tests.

- [ ] **Step 5: Verify the repository gates**

Run `RIALTO_SKIP_LIVE_TESTS=1 bun test __tests__/` and `bun run build`.
