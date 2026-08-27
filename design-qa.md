# Design QA — Sidebar primary navigation

final result: passed

## Source of truth

- User-provided before screenshot: `/var/folders/mg/ctd9153d5_g93y9n6w7tvmf80000gn/T/codex-clipboard-f790ae43-7c37-4980-8211-bc4391d8d68f.png`
- Normalized source capture: `/Users/yang/.codex/visualizations/2026/08/27/01a04100-3fc9-72c0-b593-8a42954fec6e/sidebar-primary-nav/sidebar-source-normalized.png`
- Final implementation capture: `/Users/yang/.codex/visualizations/2026/08/27/01a04100-3fc9-72c0-b593-8a42954fec6e/sidebar-primary-nav/sidebar-primary-nav-full.png`
- Full-view comparison: `/Users/yang/.codex/visualizations/2026/08/27/01a04100-3fc9-72c0-b593-8a42954fec6e/sidebar-primary-nav/sidebar-full-comparison.png`
- Focused equal-size comparison: `/Users/yang/.codex/visualizations/2026/08/27/01a04100-3fc9-72c0-b593-8a42954fec6e/sidebar-primary-nav/sidebar-focused-comparison.png`

## Viewport and state

- Source pixels: 2400 x 1600 at macOS 2x density; normalized to 1200 x 800.
- Implementation pixels and CSS viewport: 1200 x 800 at 1:1 screenshot output.
- Focused comparison: equal 264 x 800 sidebar crops.
- State: light theme, `工作台` selected, unread attention animation completed.
- Primary interactions tested: open `组织架构`, verify its region, return to `工作台`, and create a new conversation.
- Fresh preview console: no warnings or errors.

## Comparison history

1. The source showed `新建对话` as a detached blue action with a large gap before the text-only navigation.
2. The first implementation placed all six actions in one navigation but retained the existing 264 px sidebar width; measurement confirmed each row is 40 px high with a matching 18 px icon.
3. A width guard was added to the navigation and rows so their 10 px sidebar insets remain stable if the sidebar width changes.
4. The final stable capture was taken after the unread attention animation completed and compared against the source at the same normalized viewport.

## Fidelity review

- Typography: all primary-navigation entries share the existing 14/20 system type, weight, and selected-state hierarchy.
- Spacing and layout: six entries now use the same 40 px row, 4 px vertical gap, 10 px navigation inset, 12 px row padding, and 8 px radius. `新建对话` no longer has a separate margin or button treatment.
- Colors and tokens: the new-conversation action now uses the same neutral default, hover, focus, and selected-state token system as adjacent navigation entries.
- Image and icon fidelity: no raster assets were added. Official Lucide geometries are used for SquarePen, LayoutDashboard, Network, MessageCircle, BriefcaseBusiness, and Building2, rendered through the project's existing icon component system at 18 px and 1.75 stroke width.
- Copy and content: all navigation labels remain unchanged.
- Accessibility: each icon is decorative, button names remain text-based, `aria-current` remains intact, and every row provides a 40 px pointer target.

## Findings

- P0: none.
- P1: none.
- P2: none after unifying row geometry and constraining the navigation width.
- P3: the unread count remains visible by design and does not alter row alignment.

## Verification

- Sidebar focused tests: 31 passed.
- Desktop typecheck: passed.
- Renderer production build: passed.
- `git diff --check`: passed.
- The `企业管理` destination currently throws inside a separate, already-modified account-management implementation in this shared worktree. The sidebar callback and selected-state contract remain covered by the focused test; this unrelated page error was not changed as part of this task.
