# Otto Server integration baseline

> Status: authoritative integration decision for SERVER-01 / issue #238.
> Machine-readable source: [`server-integration-baseline.json`](./server-integration-baseline.json).

## Authority

Formal Otto releases and subsequent Server work start from `internal`. The
audited baseline was `c45c181bfed507d645b17169ec7253c59fbf1d19`
(`v1.10.0`) on 2026-08-03. A later descendant may become the current baseline,
but an unmerged feature branch never becomes a release source: the release
workflow fetches `origin/internal` and rejects any source commit that is not
exactly its latest head.

The active product contract at the audited baseline is:

| Contract                               | Authoritative value | Source                                                          |
| -------------------------------------- | ------------------- | --------------------------------------------------------------- |
| Desktop/client version                 | `1.10.0`            | `packages/desktop/package.json`                                 |
| Enterprise server product version      | `1.10.0`            | root `package.json`, injected as `OTTO_APP_VERSION`             |
| Internal `otto-server` package version | `0.1.0`             | `packages/server/package.json`; not the product release version |
| Enterprise HTTP API                    | `4`                 | `packages/server/src/enterprise/server.ts`                      |
| Enterprise SQLite schema               | `18`                | `packages/server/src/enterprise/db.ts`                          |
| Public health capabilities             | 42 exact IDs        | `ENTERPRISE_CAPABILITIES`                                       |
| Product modules                        | 16 exact IDs        | `packages/server/src/productModules.ts`                         |

`npm run validate:integration-baseline` compares the ledger with these source
contracts. CI and Release Build both run it.

## Branch decisions

`codex/mature-agent-safety-controls` and `uiux-preview` have no commits ahead of
`internal`; their active behavior already has one authority in `internal` and
the branches must not be merged again. `codex/release-1.10.0` was likewise
absorbed by PR #262.

The remaining experimental branches are deliberately non-authoritative:

| Branch                | Ahead / behind current `internal` at audit | Decision                                                                                                                      |
| --------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `codex/sqlcipher`     | 27 / 63                                    | Drop two obsolete merge commits; rewrite every functional commit through #239, #235, #240 or #248.                            |
| `codex/e2ee-openmls`  | 21 / 71                                    | Rewrite overlapping E2EE behavior through #235; manually integrate only the independent ToolCalls timer cleanup through #256. |
| `agent/e2ee-internal` | 3 / 71                                     | Rewrite through #235/#253; never introduce its parallel `secure_messaging` authority.                                         |

The former `codex/unsigned-release-1.10.0` branch was integrated by PR #263 and
then deleted; PR #264 disabled implicit tagged publishing, and PR #265
configured the explicit generic publisher. These changes and
their merge commits are recorded under `authority.recentIntegratedHistory`.
The current release workflow is configured to disclose unsigned artifacts and
verify checksums, the desktop update manifest, and the enterprise License trust
anchor. This is source policy, not proof that v1.10.0 artifacts have been built
or published. Authenticode, Developer ID/notarization and enterprise detached
signatures remain future work tracked by #247, not evidence that current
artifacts already possess those signatures.

The JSON ledger is exhaustive for the 33 commits unique to the active audited
branches. Every commit has exactly one of the required dispositions:
`integrate`, `rewrite`, or `drop`, with its reason and replacement commit or
follow-up issue. Merge commits are not implementation slices and are dropped.

## Integration order

1. **#238 SERVER-01** — this baseline and release contract.
2. **#239 SERVER-02** — one PostgreSQL migration manifest, complete current
   schema mapping, fail-closed import/promotion, and real dual-instance tests.
3. **#235 SERVER-03** — one approved-device MLS authority using the completed
   database model; no production claim before multi-device, revocation,
   forward-secrecy and post-compromise-recovery evidence.
4. **#240 SERVER-04** — freeze the integrated source commit, then build and
   verify SQLCipher and Rust MLS assets on all five target platforms.
5. **#241/#242/#243/#244/#245/#246/#248** — build durable workflow, evaluation,
   identity, authorization, park concurrency and object coordination on the
   same authority.
6. **#247/#249** — formal signing and independent cryptographic audit remain
   external release gates; internal unit tests cannot substitute for them.

## Updating the baseline

When an issue lands in `internal`:

1. Change the affected commit decision from `rewrite`/`integrate` to `drop`
   only after recording the real replacement commit, or remove the retired
   branch in a reviewed ledger update.
2. Update client/server/schema/capability values in the same commit that
   changes their source contract.
3. Attach test, migration count/hash, real health, platform, signing or audit
   evidence to the owning issue. A local build is not release evidence.
4. Run:

   ```bash
   npm run doctor
   npm run validate:integration-baseline
   git diff --check
   npm run test:scripts
   ```

Do not resolve ledger drift by weakening the release-source, schema or security
gates, or by misrepresenting the current artifact signature policy.
