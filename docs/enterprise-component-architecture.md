# Enterprise Component Architecture

Status: living architecture contract.

Otto should support organizations that want their own private agent without forcing them to fork the whole product. The intended shape is a stable, lightweight kernel plus independently replaceable external components.

## Ownership model

| Layer | Owner | Update pattern | Examples |
| --- | --- | --- | --- |
| Kernel | Otto upstream | Regular upstream kernel updates | turn lifecycle, tool execution engine, policy gate, model routing, memory budget, component manifest validation |
| Components | Organization or vendor | Independent install/update/remove | private connectors, document runtime, local knowledge source, workflow pack, custom tool pack |
| GUI shell | Organization or vendor | Themed or replaced per deployment | desktop routes, design tokens, branding, government/enterprise landing pages |

The kernel should be boring and stable. Components should be where organizations express local policy, integrations, branding, and distribution needs.

## Locked kernel distribution

Enterprise distributions should consume the Otto kernel as a compiled, signed artifact. This gives organizations a stable update path without turning every deployment into a private fork.

Kernel distribution manifests use `KernelDistributionManifest` from `packages/core/src/kernel/kernelDistributionManifest.ts`.

Minimum shape:

```json
{
  "manifestVersion": 1,
  "kernelVersion": "2.0.0",
  "sourceCommit": "ffd69a433bd7924f9cf60b64d539ab7a818353c7",
  "channel": "lts",
  "artifact": {
    "format": "native-binary",
    "path": "dist/otto-kernel.exe",
    "sha256": "<64-char-sha256>",
    "signature": "ed25519:<detached-signature>",
    "publicKeyId": "otto-kernel-prod-2026",
    "sourceIncluded": false
  },
  "performanceBudget": {
    "coldStartMs": 1200,
    "registryReadyMs": 500,
    "maxIdleRssMb": 180,
    "maxSubAgentRssDeltaMb": 80,
    "maxToolSchemaChars": 120000,
    "maxDistributionMb": 10
  },
  "componentApiVersion": 1,
  "generatedAt": "2026-07-22T11:00:00.000Z"
}
```

Security wording must stay honest:

- Do say: tamper-evident, signed, source-free enterprise artifact, reverse-engineering resistant.
- Do not say: impossible to inspect, impossible to crack, mathematically unbreakable.

Any local software can be reverse engineered with enough effort. The product guarantee is that official enterprise kernels are signed compiled artifacts and unauthorized modification is detectable.

## Rust native hot-path takeover

The native core takeover is intentionally narrow. Rust owns the paths that must stay small, predictable, and fast across many concurrent agents:

| Hot path | Rust module | Old TypeScript fallback |
| --- | --- | --- |
| Agent pool and memory accounting | `otto-native/src/agent_pool.rs` | `packages/core/src/core/subAgent.ts`, `packages/core/src/core/agentResourceBudget.ts` |
| Session storage and bounded history | `otto-native/src/session_store.rs` | `packages/core/src/services/sessionManager.ts` |
| Tokenizer and schema/history budget counting | `otto-native/src/tokenizer.rs` | `packages/core/src/core/tokenLimits.ts` callers |

`packages/core/src/native/nativeHotPaths.ts` is the source-of-truth method list. `packages/core/src/native/nativeCoreBridge.ts` controls runtime selection:

- `OTTO_NATIVE_CORE=auto`: prefer Rust when present, otherwise use the safe TypeScript fallback.
- `OTTO_NATIVE_CORE=required`: enterprise/release mode; fail fast if the Rust binary is missing.
- `OTTO_NATIVE_CORE=off`: development escape hatch for comparing behavior.

The release distribution budget is 10MB. Optional tools, GUI shells, connectors, and organization-specific integrations must stay outside the kernel artifact unless they are required for all distributions.

Current migration status:

- `agent_pool` is wired into `TaskTool` through `packages/core/src/native/nativeAgentPoolRuntime.ts`.
- `session_store` and `tokenizer` remain on compatibility fallbacks until their persisted data and token-count tests are strong enough for a hard swap.

## Component manifest

Optional components use the versioned `OttoComponentManifest` contract from `packages/core/src/components/componentManifest.ts`.

Minimum shape:

```json
{
  "manifestVersion": 1,
  "id": "gov.local.gui",
  "displayName": "Local Government GUI",
  "version": "1.0.0",
  "kind": "gui-shell",
  "updateOwner": "organization",
  "entrypoints": {
    "desktopRoutes": ["components/gov-gui/routes.tsx"],
    "themeTokens": ["components/gov-gui/tokens.css"]
  },
  "permissions": []
}
```

Rules:

- Organization/vendor components must not claim kernel-owned paths such as `packages/core/src/core/*`, `packages/core/src/policy/*`, `packages/core/src/config/config.ts`, or `packages/core/src/tools/tool-registry.ts`.
- Private deployments should update the kernel from upstream instead of carrying long-lived core forks.
- Local integrations belong in components, connectors, MCP servers, bundled runtimes, or GUI shells.
- GUI customization should prefer routes, layout slots, and tokens over edits to kernel or server session logic.
- Kernel updates are accepted only through signed compiled artifacts that pass integrity, component API, and performance budget validation.

## Distribution guidance

For state-owned enterprise and private deployments:

- Keep kernel updates common and boring: security fixes, resource budgets, state machine changes, policy enforcement.
- Keep organization-specific behavior outside the kernel: intranet connectors, approval workflows, document templates, and branded GUI surfaces.
- Treat components as separately reviewable artifacts with explicit permissions.
- Prefer additive components over patching existing core files.

If a requested change requires modifying the kernel, it should answer: "Would every Otto distribution benefit from this?" If not, it probably belongs in a component.
