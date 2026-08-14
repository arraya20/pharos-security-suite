# Proprietary License Transition Design

## Understanding

- The suite and all bundled modules are moving away from permissive licensing.
- Current and future versions must not grant public rights to use, copy, modify,
  publish, distribute, sublicense, sell, or create derivative works.
- Authorized use remains possible only with prior written permission from the
  copyright holder.
- Package metadata and documentation must describe the same proprietary terms.
- Accidental publication of Node packages to the public npm registry must be blocked.
- Third-party dependency licenses remain intact and are outside this transition.

## Assumptions

- Arraya owns the copyright or has authority to relicense every bundled module.
- The transition applies to versions containing the new proprietary notice.
- Earlier copies remain governed by the license included with those copies.
- No paid, evaluation, contributor, or source-available grant is being introduced.
- Runtime behavior, performance, security controls, and availability are unchanged.

## Approaches Considered

1. **Explicit proprietary license (selected):** clear restrictions, consistent
   package metadata, and an explicit warranty disclaimer.
2. Delete every license file: default copyright would apply, but users and package
   tooling would receive less explicit guidance.
3. Custom commercial/evaluation license: supports external licensing workflows,
   but introduces permissions the owner has not requested.

## Final Design

Each distribution root contains the same `LICENSE` notice headed
`Proprietary Software License`. It reserves all rights and requires prior written
permission for use or redistribution. Node manifests use `UNLICENSED` and
`private: true`; the Python project uses proprietary license metadata. User-facing
license sections point to the applicable local file.

The module documentation checker validates license headers and package metadata so
a later synchronization cannot silently restore permissive terms. Dependency lock
entries retain their upstream licenses because those terms apply to dependencies,
not to this project.

## Verification

1. Run the documentation/module consistency tests.
2. Search for stale project-level permissive-license and open-source claims.
3. Run each affected package's tests and lint checks.
4. Run package metadata checks and `git diff --check`.

## Decision Log

1. Use an explicit proprietary notice instead of relying only on default copyright.
2. Reserve all rights and require prior written authorization for any use.
3. Mark Node packages private and unlicensed to block accidental npm publication.
4. Preserve dependency license metadata and historical licensing of earlier copies.
5. Keep one identical notice across the root and all bundled modules.
