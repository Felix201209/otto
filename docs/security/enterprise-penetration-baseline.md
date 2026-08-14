# Otto Enterprise penetration baseline

This baseline is a repeatable, credential-free security probe for the Otto
Enterprise HTTP layer. It is intended for pull-request and release gating. It
does not replace an independent penetration test or a cryptographic audit.

## Isolation guarantee

Run:

```bash
npm run build:packages
npm run security:enterprise:probe
```

The probe creates a temporary SQLite database, binds only to `127.0.0.1` on an
ephemeral port, generates disposable organizations and credentials, and deletes
the temporary database on exit. It does not accept a remote target URL, so it
cannot accidentally scan a customer or production deployment.

## Covered attack paths

The probe verifies all of the following against a running server:

- public health output does not disclose deployment, license, machine, token,
  or private-key data;
- account, audit, organization, privacy export, and direct-message routes deny
  anonymous access;
- administrator tokens in URL query strings are rejected;
- cross-origin administrator mutations are rejected and leave no data behind;
- an ordinary member cannot call administrator routes;
- one tenant cannot enumerate another tenant's direct messages;
- a forged `Host` header cannot bypass tokenless loopback administration;
- malformed and oversized JSON fail closed without stack disclosure or server
  loss;
- traversal and encoded script payloads are not reflected;
- password spraying is rate-limited even when `X-Forwarded-For` is forged; and
- local Agent pairing routes are disabled unless explicitly enabled.

Additional automated security coverage is provided by:

```bash
npm run security:e2ee:adversarial
npx vitest run packages/core/src/tools/web-fetch-security.test.ts \
  packages/server/src/authorizationBoundary.test.ts \
  packages/server/src/authorizationPolicy.test.ts \
  packages/server/src/modules/authorization/commercialRoutePolicy.test.ts \
  packages/server/src/modules/control_commands/controlCommandBoundary.test.ts \
  packages/desktop/src/preload/outbound-file-authorization.test.ts \
  packages/desktop/src/main/incremental-component-store.test.ts
npm audit --omit=dev
```

## Release interpretation

A green result means the listed controls behaved correctly in the isolated
test environment. It is not evidence that an Internet-facing deployment,
reverse proxy, cloud account, operating system, or customer identity provider
is correctly configured.

Before a commercial production launch, an independent tester must still assess
the deployed topology, TLS and proxy configuration, cloud IAM, object storage,
database access, secret management, denial-of-service limits, and business
authorization workflows. E2EE also remains subject to its separate signed
release gate and third-party cryptographic review.

## Current dependency exception

`pptxgenjs@4.0.1` declares `image-size`, for which the upstream advisory has no
fixed release. Otto's current PPT path feeds `pptxgenjs` only PNG screenshots
rendered by Otto itself with explicit dimensions; the library's image-size
helper is unused in the shipped runtime. Do not downgrade to the audit tool's
suggested `pptxgenjs@1.1.5`, because that would be a breaking functional
regression. Keep monitoring upstream and remove this exception when a fixed
release is available.
