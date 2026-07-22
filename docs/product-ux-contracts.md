# Product UX Contracts

Status: living product contract.

Performance work must not make Otto feel slower, more opaque, or less capable. The product should be lightweight internally while remaining instant and legible to users.

## Tool availability

User-facing tools must feel ready once a session is created.

- Lazy optional tools are loaded during registry setup after `coreTools` / `excludeTools` filtering.
- Do not replace user-facing tools with first-use proxy shells unless the UI clearly marks them as pre-warmed and ready.
- Main-agent tool availability and sub-agent tool availability are different concepts. A tool omitted from a lightweight sub-agent profile is not “missing” from the product.

Core helper: `describeToolAvailability()` in `packages/core/src/ux/agentExperienceContract.ts`.

## Agent activity language

The UI should summarize what Otto is doing in human language, not raw internal events.

Recommended states:

- `Ready`
- `Thinking`
- `Using a tool`
- `Working with N sub-agents`
- `Needs your input`
- `Done`
- `Needs attention`

Core helper: `summarizeAgentActivity()`.

## Notifications and red dots

Unread indicators should be useful, not noisy.

- Show a red dot when a background agent or external channel produces a new update outside the focused session.
- Show a red dot when user action is required.
- Do not show a red dot for passive system noise.
- Do not show a red dot for the currently focused session.

Core helper: `shouldShowUnreadDot()`.

## Sub-agent UX

Default sub-agents are intentionally lightweight. They should:

- Use a narrow read-only toolset by default.
- Report concise findings back to the main agent.
- Avoid exposing raw tool chatter to users unless the user asks for detail.
- Surface progress as “working with sub-agents,” not as a dump of internal tool names.

Full-access sub-agents remain available only through explicit agent types such as `workflow-orchestrator`.

## GUI customization

GUI shells may change layout, theme, routes, and branding, but should preserve the semantic contracts above. This lets organizations build their own private Otto without confusing users or forking core behavior.
