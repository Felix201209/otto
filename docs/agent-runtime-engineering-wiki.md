# Agent Runtime Engineering Wiki

> Internal engineering reference for Otto's agent runtime: architecture decisions, component contracts, and integration patterns.

This document captures engineering-level knowledge for developers working on or integrating with Otto's agent runtime.

---

## Runtime architecture

See [architecture.md](./architecture.md) for the high-level system design.

- [DSH full-feature runtime integration plan](./dsh-full-feature-runtime-integration-plan.md)

## Building & testing

- [Build workflow](./build-workflow.md) — build scripts and pipeline
- [Integration tests](./integration-tests.md) — E2E testing approach

## Contributing

For issue filing, PR checklists, local verification, and CI gates — follow the
[Contributing Guide](./CONTRIBUTING.md). Every change must pass the mechanical
checks described there before merge.

## Model integration

- [Custom models guide](./custom-models-guide.md)
- [Custom models architecture](./custom-models-architecture.md)

## Hooks & extensibility

- [Hooks architecture](./HOOKS_ARCHITECTURE.md)
- [Hooks user guide](./hooks-user-guide.md)

## MCP (Model Context Protocol)

- [MCP async loading](./mcp-async-loading.md)
- [MCP sequential startup](./mcp-sequential-startup.md)
- [MCP improvements summary](./mcp-improvements-summary.md)

## Skills system

- [Skills usage guide](./skills-usage.md)
- [Skills context injection](./skills-context-injection.md)
