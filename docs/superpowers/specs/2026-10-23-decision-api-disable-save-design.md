# Save Disabled Decisions API Design

## Intent

When an operator clears **Prefer tiers with a Decisions API** and saves a routing profile, the persisted write must carry `decisionEnabled: false`. The same guarantee applies to every Decisions API field edited before Save.

## Constraints

- Keep the existing profile PUT contract and screen layout.
- Preserve server-owned routing constraint fields copied from the loaded profile.
- Add no dependencies and do not change the package version.

## Approaches

- **Selected:** keep the existing memoized `save` callback and declare every Decisions API state value it reads as a dependency. This is the smallest change and lets React recreate the callback whenever an editable field changes.
- Remove `useCallback`. This would also avoid stale captures, but changes callback identity on every render and is broader than the bug requires.
- Mirror the draft in a ref. This keeps a stable callback but adds synchronization state and more ways for the UI and write payload to diverge.

## Verification

Add a Routing screen browser regression that starts from an enabled Decisions API, unchecks it, saves, and inspects the actual PUT payload for `decisionEnabled: false`. Run the relevant routing tests, typecheck, build, and the repository test suite.
