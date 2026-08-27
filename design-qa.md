# Design QA — Composer context popovers

final result: passed

## Source of truth

- User-provided workspace reference: `/var/folders/mg/ctd9153d5_g93y9n6w7tvmf80000gn/T/codex-clipboard-219d9c6f-6528-4886-9483-b471765da954.png`
- User-provided authorization reference: `/var/folders/mg/ctd9153d5_g93y9n6w7tvmf80000gn/T/codex-clipboard-a3d03078-4e01-4d58-9e67-3299f60973a0.png`
- Final workspace capture: `/Users/yang/.codex/visualizations/2026/08/27/01a04100-3fc9-72c0-b593-8a42954fec6e/compact-composer-popovers/workspace-popover.png`
- Final authorization capture: `/Users/yang/.codex/visualizations/2026/08/27/01a04100-3fc9-72c0-b593-8a42954fec6e/compact-composer-popovers/authorization-popover.png`
- Focused comparison: `/Users/yang/.codex/visualizations/2026/08/27/01a04100-3fc9-72c0-b593-8a42954fec6e/compact-composer-popovers/focused-comparison.png`

## Viewport and state

- Workspace source pixels: 1286 x 720; authorization source pixels: 1254 x 694.
- Implementation viewport and screenshot pixels: 1280 x 720.
- Focused comparison uses centered equal-size 620 x 470 canvases for each source/implementation crop.
- State: light theme, composer visible, workspace menu open and authorization menu open in separate captures.
- Interaction tested: open each menu, switch authorization from all-session automatic to manual, verify the trigger label updates, restore all-session automatic, and reopen the menu.

## Comparison history

1. The source implementation used two different trigger treatments, oversized menu geometry, heavier type, and inconsistent selected-state color.
2. Both triggers were normalized to the same 30 px context-pill geometry, 12 px type, border, radius, and shadow tokens.
3. The workspace menu was reduced to 284 px with 42 px rows; the authorization menu was reduced to 344 px with 50 px rows.
4. Type weight, line height, icon columns, spacing, hover states, and neutral selected backgrounds were aligned across both menus.
5. The final captures were placed beside the supplied references in one comparison image and inspected together.

## Fidelity review

- Typography: titles use 500 weight instead of heavy display weight; supporting copy is 10.5–11 px with compact line height and safe ellipsis handling.
- Spacing and layout: both menus use 6 px shells, 8–9 px internal gaps, 8 px option radii, and an 8 px trigger-to-menu offset.
- Colors and tokens: menu surfaces, borders, shadows, neutral selection backgrounds, and accent checkmarks use existing Otto tokens.
- Icons: the workspace add action now uses the project's Lucide-based `IconPlus`; existing folder, shield, hand, chevron, and check icons remain intact.
- Copy and content: all user-facing wording remains unchanged.
- Behavior: selection callbacks, workspace picking, authorization persistence, menu semantics, and keyboard focus styles are unchanged.
- Boundary safety: measured authorization menu width is 344 px, all three rows are 50 px, and the open menu remains inside the 1280 x 720 viewport.

## Findings

- P0: none.
- P1: none.
- P2: none after unifying trigger geometry and reducing popover density.
- P3: the preview fixture contains one recent workspace rather than the two entries in the user's source screenshot; this is data-dependent and does not affect layout behavior.

## Verification

- Composer focused tests: 28 passed.
- Desktop typecheck: passed.
- Renderer production build: passed.
- `git diff --check`: passed.
- Browser interaction verification: passed; authorization selection and restoration both updated the trigger correctly.
