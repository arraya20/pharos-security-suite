# P0 Implementation Design

## Understanding

- Restore Address Intelligence explorer enrichment through SocialScan.
- Keep RPC-only analysis functional when SocialScan credentials or service are unavailable.
- Add deterministic CI coverage separately from live explorer availability monitoring.
- Harden the Contract Inspector HTTP boundary and remove bytecode-metadata false positives.
- Correct the Skill Inspector environment-taint false positive and SARIF tool version.
- Preserve the existing public CLI and report shapes unless an additive field is required.

## Assumptions

- SocialScan credentials are supplied only through `SOCIALSCAN_API_KEY`.
- Pull-request tests must not depend on external services.
- A scheduled smoke test may use a repository secret and report upstream outages.
- The three repositories remain independently releasable during P0.
- Existing uncommitted work is preserved and is not reformatted unnecessarily.

## Design

Address Intelligence will translate SocialScan's Etherscan-compatible responses
into the existing internal contract, activity, and token-holding shapes. The
provider owns authentication, pagination inputs, response validation, timeouts,
and error normalization. Missing credentials produce explicit partial
confidence rather than a fatal analysis error.

Contract Inspector will classify malformed input separately from upstream and
internal failures, enforce byte-based request limits, and bound request rate and
duration. Solidity CBOR metadata will be removed only when its trailing length
and complete CBOR map structure are valid; malformed suffixes remain untouched.

Skill Inspector will scope `os.environ[...]` sources to secret-like constant
keys while continuing to treat whole-environment copies as sensitive. SARIF
will import the package version instead of duplicating it.

## Verification

- Unit tests use fixed SocialScan fixtures and cover missing credentials,
  malformed responses, pagination, and graceful degradation.
- HTTP regression tests cover malformed JSON, oversized bodies, rate limits,
  timeouts, and generic internal errors.
- Bytecode tests cover valid metadata, invalid lengths, and selector-like bytes
  inside metadata.
- Python tests cover benign and secret environment subscripts.
- CI runs supported Node releases 22 and 24; live smoke tests are scheduled and
  conditional on the API-key secret.

## Decision Log

1. Use a provider adapter instead of replacing the explorer URL.
2. Keep live monitoring separate from deterministic pull-request CI.
3. Do not introduce a monorepo or shared package during correctness fixes.
4. Treat all explorer data as untrusted and fail enrichment closed.
5. Deliver P0 as independently testable increments.
