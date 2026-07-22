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

## Distribution guidance

For state-owned enterprise and private deployments:

- Keep kernel updates common and boring: security fixes, resource budgets, state machine changes, policy enforcement.
- Keep organization-specific behavior outside the kernel: intranet connectors, approval workflows, document templates, and branded GUI surfaces.
- Treat components as separately reviewable artifacts with explicit permissions.
- Prefer additive components over patching existing core files.

If a requested change requires modifying the kernel, it should answer: “Would every Otto distribution benefit from this?” If not, it probably belongs in a component.
