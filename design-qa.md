# Design QA — Sidebar primary navigation

final result: passed

## Source of truth

- User-provided before screenshot: `/var/folders/mg/ctd9153d5_g93y9n6w7tvmf80000gn/T/codex-clipboard-6752c0d0-0989-42fd-87fc-fc2934f252b1.png`
- Fresh full-view before capture: `/Users/yang/.codex/visualizations/2026/08/27/01a040e4-52f9-78d2-b975-ebb285583ff3/sidebar-nav-audit/01-current-sidebar.jpg`
- Final coordinated implementation capture: `/Users/yang/.codex/visualizations/2026/08/27/01a040e4-52f9-78d2-b975-ebb285583ff3/sidebar-nav-implementation/08-coordinated-after.jpg`
- Navigation hover-state capture: `/Users/yang/.codex/visualizations/2026/08/27/01a040e4-52f9-78d2-b975-ebb285583ff3/sidebar-nav-implementation/09-coordinated-hover.jpg`

## Viewport and state

- Browser viewport and screenshot: 1292 x 994 pixels at the preview's captured desktop density; light theme; `工作台` and one task selected.
- Focused comparison: equal 264 x 430 crops of the same sidebar region and state.
- Primary interactions tested: open `组织架构`, verify its region, return to `工作台`, and confirm the conversation view is restored.
- Stable state was captured after the unread attention animation completed.

## Comparison history

1. The original primary navigation used a saturated blue 36 px active block, 13 px medium labels, 12 px outer inset, and an accent hover. It visually overpowered the quieter 32–34 px task list below.
2. The first revised capture aligned the geometry and selected surface, but exposed the existing red attention pulse around `我的消息`; this remained visually inconsistent (P2).
3. The attention pulse was changed to a restrained accent ring. The stable post-fix capture has no competing red halo and the navigation/task hierarchy remains clear.
4. After review, all blue was removed from the primary navigation: active fill/text, unread badge, focus ring, and attention pulse now use neutral graphite tokens. The final focused comparison confirms that the upper navigation is neutral while the task selection remains independently legible.
5. Navigation and task rows now share one neutral interaction ramp: 4% hover, 5% task selection, 7% primary-navigation selection, and 8% primary-navigation selected hover. The task selection no longer uses an accent tint.

## Fidelity review

- Typography: navigation now uses the same system stack and 14/20 rhythm as the task list; normal weight is 400 and active weight is 500.
- Spacing and layout: 34 px navigation rows, 2 px row gap, 8 px radius, 10 px sidebar inset, and 14 px text inset align with the task rows below.
- Colors: shared 4% hover, 5% task-selected, 7% navigation-selected, and 8% navigation-selected-hover surfaces coordinate the two sidebar levels without making them identical; dark text, neutral badge/focus/attention states, and a subtle inset divider replace accent-colored blocks.
- Image and icon fidelity: this surface contains no new image assets or icons; existing visible assets remain unchanged.
- Copy: `工作台`, `组织架构`, `我的消息`, and `我的工作` remain unchanged.
- Accessibility: `aria-current`, keyboard focus, reduced-motion behavior, and functional target size are preserved; the 34 px rows exceed the common 24 px pointer-target minimum.

## Findings

- P0: none.
- P1: none after replacing the saturated active state.
- P2: none after refining the attention pulse, removing blue from the selected task row, and unifying both sections on the shared neutral state ramp.
- Focused Sidebar tests: 26 passed.
- Desktop typecheck, renderer production build, and `git diff --check`: passed.
- Full-view evidence confirms overall hierarchy; the focused equal-size comparison confirms typography, inset, row density, selected state, badge scale, divider, and task-list alignment.
