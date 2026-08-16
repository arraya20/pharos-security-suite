# Security Remediation Design

## Understanding

- Preserve fast caller-facing deadlines without releasing capacity before upstream work settles.
- Keep identical work coalesced for the full upstream lifecycle.
- Require authentication for every configured API secret and for every non-loopback bind.
- Keep unauthenticated loopback-only development available when no secret is configured.
- Report incomplete security and metadata probes conservatively as partial results.
- Prefer validated resolved dependency versions, while falling back to manifests when a lockfile is unusable.
- Preserve module-integrity checks; do not hide subtree drift by weakening verification.

## Assumptions and non-goals

- Existing response schemas, cache keys, timeout codes, and local CLI workflows remain compatible.
- Concurrency limits bound unique upstream jobs, not HTTP waiters.
- This change supports npm `package-lock.json` and `npm-shrinkwrap.json`; adding every package-manager lock format is a separate extension.
- No upstream repository push, deployment, or secret creation is performed here.

## Design

1. Store a coordinator in-flight record containing a caller-facing result promise and an upstream-settlement promise. Remove it only after all registered upstream promises settle.
2. Enforce auth when an API key exists, regardless of bind host. Continue to reject a non-loopback configuration without a key.
3. Include transient metadata read failures in Contract Inspector's `incomplete` collection so standalone and coordinated reports agree.
4. Parse supported npm lockfiles only after structural validation. A malformed or dependency-empty lockfile cannot suppress its adjacent manifest.
5. Add regression tests for the externally observable outcomes before implementation.

## Decision log

- Chose cooperative cancellation plus settlement accounting over forceful termination because JavaScript promises cannot be safely killed.
- Chose secret-presence auth enforcement over host-only inference because reverse proxies commonly expose loopback-bound services.
- Chose manifest fallback over silent lockfile trust because scanner inputs are untrusted and may be intentionally malformed.
- Chose explicit partial status over only increasing the risk score because confidence and severity are separate concepts.
- Kept subtree verification strict; local security overlays must be synchronized through the existing module workflow rather than exempted.
