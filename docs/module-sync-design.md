# Module Synchronization Design

## Understanding

- The suite is the source-available proprietary distribution of three canonical security tools.
- Each bundled module must remain independently runnable.
- A normal clone must include all source code without a submodule initialization step.
- Root CI must validate Python, both Node modules, packaging, and module provenance.
- The trust layer and unified deep reports remain roadmap items for a later tranche.
- Updates are reviewed and explicit; CI prevents silent drift after synchronization.

## Assumptions

- Three modules and one primary maintainer keep subtree maintenance manageable.
- Security and reproducibility take priority over fully automatic upstream updates.
- Canonical module APIs remain unchanged during the initial synchronization.
- Live SocialScan monitoring stays in the Address Intelligence workflow and uses a secret.
- Local subtree conversion commits are allowed; nothing is pushed before final validation.

## Approaches Considered

1. **Git subtree (selected):** clone-ready source, upstream provenance, and explicit pulls.
2. Vendored copies plus a lock file: simple, but easier to drift and lose file deletions.
3. Git submodules: strong provenance, but adds clone/setup friction for users and packaging.

## Architecture

The root repository vendors each canonical repository through Git subtree:

| Prefix | Canonical repository | Branch |
| --- | --- | --- |
| `skill-inspector/` | `arraya20/pharos_skill_inspector` | `main` |
| `contract-inspector/` | `arraya20/pharos-contract-inspector` | `master` |
| `address-intelligence/` | `arraya20/pharos-address-intelligence` | `main` |

`modules.lock.json` records the expected upstream URL, branch, and commit for each
prefix. A root drift checker validates the manifest schema, verifies that required
module files exist, and ensures the subtree commit recorded in Git history matches
the lock entry. Synchronization refuses a dirty worktree or unknown module.

Root CI owns suite-wide quality gates. It runs each module in its own working
directory, builds distributable packages, and executes the drift/documentation
checks. Live external-service smoke tests remain separate from deterministic CI.

## Error Handling

- Synchronization exits before mutation when the worktree is dirty.
- Unknown module names, invalid lock entries, missing tools, and failed fetches are fatal.
- Drift validation fails closed when provenance cannot be established.
- No synchronization command force-pushes or rewrites an upstream repository.

## Testing Strategy

1. Add a failing drift test against the stale snapshots.
2. Synchronize and test one module at a time.
3. Add root CI and validate its commands locally.
4. Check documentation versions and module references from the lock manifest.
5. Run all tests, lint, audits, package builds, and `git diff --check`.

## Decision Log

1. Use Git subtree instead of submodules so a normal clone is immediately usable.
2. Keep synchronization explicit instead of automatically pulling unreviewed security code.
3. Store upstream SHAs in a root lock manifest for review and release provenance.
4. Put CI at the repository root because nested workflows are ignored by GitHub.
5. Keep trust-layer and unified composition labeled as roadmap until implemented.
