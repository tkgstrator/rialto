# Repository instructions

<!-- non-code-verification -->
## Verification for non-code changes

- For changes limited to audited development documentation, do not start heavy
  local or CI builds, simulator/UI suites, integration tests, or benchmarks.
  Run the lightweight scope/policy checks and record a documentation-only
  exemption; do not report unexecuted tests as passing.
- Source, tests, runtime/build inputs, assets, dependencies, lockfiles, signing,
  and CI configuration changes still require the applicable verification.
  Determine the actual changed inputs; an unknown or incomplete diff runs heavy.
- Use the repository's explicit documentation allowlist and adopted change-scope
  workflow. Markdown consumed by the product or tests is an input, not a blanket
  exemption. Keep required status names, lightweight checks, and existing
  manual, scheduled, release, and deployment gates intact.
- See `docs/development/ci-change-scope.md` for the common classifier contract.
<!-- /non-code-verification -->

<!-- gh-commit-identity -->
Before creating, rewriting, signing, pushing, or delegating Git commits, read and apply gh-commit-identity at /home/vscode/app/.codex/skills/gh-commit-identity/SKILL.md. Its native checker is mandatory for new or rewritten local commits: printable ASCII English Conventional Commits, 128 counted characters maximum excluding validated final Co-Authored-By lines and their otherwise empty separator; original ASCII and attribution checks cover the whole message and other trailers remain counted, and raw Author/Committer matching the verified human github.com gh identity. Normal checks use the credential-bound cache without API calls; missing or changed cache requires --strict account. Push and native fix apply always verify online without cache fallback. Preserve recognized AI attribution. Use installed guarded Git for ordinary commits and V1 fix. Only explicitly owner-approved existing-history bulk-write may skip per-commit hooks/API; it requires frozen candidates and complete mapping verification before operator-controlled backup/CAS promotion. Never use a global ignore for new commits. Automatically correct only the skill's proven own unpublished safe subset, preserving trees and backup refs, and recheck before one authorized normal push retry. Missing tools/authentication or uncertain refs stops; repairing public/foreign history requires separate authorization. Verify actual delegated new or rewritten local commits. GitHub-generated published merge/squash/rebase history has standing authorization for preservation: establish exact OIDs and origin from live github.com refs and merged-PR metadata, retain original identities/signatures/messages, and automatically skip agent correction and approval requests for those differences. Names, emails, subjects and parent counts alone do not prove origin. Do not use standalone commits checks on this inherited history to trigger repair; use the mandatory native push/pre-push checker on actual outgoing commits. This exception grants no rewrite, force-push, ownership or migration authority and never bypasses a failed native check.
<!-- /gh-commit-identity -->
