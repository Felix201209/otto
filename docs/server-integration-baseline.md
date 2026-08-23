# Otto authoritative integration baseline

> Status: release-source contract for SERVER-01 / issue #238.
> Machine-readable source: [`server-integration-baseline.json`](./server-integration-baseline.json).

## Authority

`internal` is the only long-lived product branch. A release candidate must
contain the latest `origin/internal` commit. Additional commits are allowed only
on a reviewed `release/*` branch or a version tag; feature and experiment
branches are never direct release sources.

The current integration candidate contains the fetched `origin/internal` tip
`30e2adab7bf9d647ff69965bbbbcf1044b3e3014`. Historical integration anchor
`1874681db2f108aa6a9b6d47ee62578d4ce37ac2` remains in the ledger so earlier
source dispositions stay auditable. This reviewed short-lived release branch
maps the integrated candidate to product version `1.9.13`; `internal` remains
on its independent 1.10.x development line. The candidate includes the reviewed
SQLCipher/E2EE work, MLS attachments, macOS packaging fixes and the nine 1.9.11
transition release changes.

| Contract                          | Authoritative value | Source                                     |
| --------------------------------- | ------------------- | ------------------------------------------ |
| Desktop/client version            | `1.9.13`            | `packages/desktop/package.json`            |
| Enterprise server product version | `1.9.13`            | root `package.json`                        |
| Internal server package version   | `0.1.0`             | `packages/server/package.json`             |
| Enterprise HTTP API               | `4`                 | `packages/server/src/enterprise/server.ts` |
| Enterprise schema                 | `23`                | `packages/server/src/enterprise/db.ts`     |
| Public capabilities               | 50 exact IDs        | `ENTERPRISE_CAPABILITIES`                  |
| Product modules                   | 17 exact IDs        | `packages/server/src/productModules.ts`    |

## Integrated sources

The JSON ledger records each former source branch, its audited tip, the commit
that integrated or rewrote it, the retained capability and why the old branch
is no longer authoritative. CI verifies every integration commit is an
ancestor of the release candidate.

This means old security and release branches can be deleted without weakening
the audit trail, and they cannot accidentally become permanent competing
release lines. They must not be merged again.

## Security meaning

Code integration is not a claim of production approval. SQLCipher, MLS and
device-trust code are present in the candidate, while the E2EE production gate
remains fail-closed until the required external cryptographic audit and signed
platform artifacts exist. The ledger records those items as external evidence,
not as completed software checks.

## Automated gates

`npm run validate:integration-baseline` verifies:

- root, desktop and server package versions;
- Enterprise API and schema versions, including the supported migration range;
- exact public capability and product-module registries;
- complete source integration evidence and valid dispositions;
- the release workflow's internal-ancestor and reviewed-release-ref policy;
- CI execution of the same gate.

With `--verify-git-refs`, it additionally verifies that the fetched
`origin/internal` matches the live remote, the recorded integration point is
still an ancestor, the candidate contains the latest `origin/internal`, and
every recorded integration commit is present. The recorded integration point
does not need to change after every normal commit on `internal`.

Run before merging or releasing:

```bash
npm run doctor
npm run validate:integration-baseline -- --verify-git-refs
npm run validate:boundaries
npm run lint:ci
npm run build
npm run typecheck
npm run test:ci
git diff --check
```

The 2026-08-14 integration candidate was verified from merge commit
`7fff2c785e08842bdcbac4e6ef0e03acd72edbec` with the commands above, the
desktop production build and `npm run security:e2ee:candidate:verify`. Full
Windows test execution produced 2,725 passing Core tests, 1,334 passing Server
tests and 886 passing Desktop tests (4,945 passing tests total). The Core suite
was executed outside the filesystem sandbox because it intentionally writes
per-user state and launches the installed browser for a real screenshot test.

Real installers, signatures, notarization, database migration, canary upgrade
and rollback evidence remain release-level acceptance work. Unit tests cannot
replace those checks.
