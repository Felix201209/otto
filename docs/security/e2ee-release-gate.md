# E2EE production release gate

Otto separates candidate delivery from production E2EE enablement. Normal
Otto releases run the candidate gate and may include the inactive MLS
transport. They do not advertise `e2ee_mls_v1`.

## Evidence flow

1. Run `npm run security:e2ee:adversarial` from a clean commit. The report is
   written to `artifacts/security/e2ee-adversarial-report.json`.
2. Run `npm run security:e2ee:audit:bundle`. Give the manifest, exact commit,
   source archive, test report, threat model, protocol documents, SBOM, and
   build provenance to an independent cryptography auditor.
3. Add the auditor's Ed25519 public key to
   `security/e2ee-release-trust.json` with role `external-auditor`.
4. Record the signed `otto-e2ee-external-audit` attestation. It must bind the
   protocol, implementation, security-profile digest, report digest, hostile
   server assessment, validity period, and finding counts.
5. Two different keys sign the `otto-e2ee-production-approval` statement: one
   with role `security-approver`, one with role `release-approver`. Approval is
   time limited and binds the audit-attestation digest.
6. Update `security/e2ee-release-status.json`, run
   `node scripts/generate-e2ee-release-policy.mjs`, and submit the generated
   policy in the same reviewed change.
7. Run `npm run security:e2ee:release:verify -- --mode production`. Release CI
   reruns the hostile-server suite and refuses stale, dirty, forged, expired,
   revoked, mismatched, or incomplete evidence.

Private signing keys must stay outside the repository and ordinary build
machines. Use KMS/HSM-backed signing or an isolated offline signer. Trust-store
key changes require protected-branch review and are included in the audited
security-profile digest. Revocation is represented by a non-null `revokedAt`;
a revoked key cannot approve a later build.

## Signed external audit statement

The statement type is `otto-e2ee-external-audit`. Required fields are:

- `protocolId`, `implementation`, and `securityProfileDigest`;
- `threatModel: "server-hostile"`;
- `maliciousServerAssessmentCompleted: true`;
- repository-relative `reportPath`, matching `reportSha256`, `issuedAt`, and
  `expiresAt`;
- `findings` with numeric `critical`, `high`, `medium`, and `low` counts.

The envelope has `format: 1`, the type, the statement, and an array of
Ed25519 signatures over canonical JSON of the statement.

## Signed release approval statement

The statement type is `otto-e2ee-production-approval`. Required fields are:

- `decision: "approve-production-e2ee"`;
- protocol, implementation, and security-profile digest;
- `auditAttestationSha256`;
- `notBefore` and `expiresAt`.

The two required signature roles are `security-approver` and
`release-approver`. One key cannot satisfy both roles.

## What remains external

Repository code can enforce the gate and prepare reproducible evidence. It
cannot truthfully create an independent audit. A qualified third party must
review the protocol and implementation, issue the report, and sign the audit
attestation before production MLS can be enabled.
