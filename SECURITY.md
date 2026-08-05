# Security Policy

## Supported versions

Security fixes are applied to the latest commit on the `main` branch. Until the
suite reaches version 1.0, older snapshots are not maintained separately.

## Reporting a vulnerability

Please use GitHub's private **Report a vulnerability** flow in the repository's
Security tab. Do not open a public issue for an unpatched vulnerability and do
not include private keys, access tokens, wallet recovery phrases, or production
customer data in a report.

Include the affected module and version, reproduction steps, expected impact,
and a minimal proof of concept when it is safe to share. Reports will be
acknowledged through the private advisory thread.

## Scope

Reports concerning unintended writes or signatures, SSRF, secret exposure,
incorrect security conclusions, bypasses of resource limits, and unsafe skill
package handling are in scope. Heuristic disagreements without a reproducible
security impact may be handled as ordinary issues after disclosure is safe.
