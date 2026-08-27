# Design QA — Sidebar task list

final result: passed

## Source of truth

- Reference screenshot: `/var/folders/mg/ctd9153d5_g93y9n6w7tvmf80000gn/T/codex-clipboard-ae8a1a43-13b3-4b61-8777-213998b36385.png`
- Product screenshot: `/var/folders/mg/ctd9153d5_g93y9n6w7tvmf80000gn/T/codex-clipboard-9338cdfd-0ad9-4d70-8676-713b72799108.png`
- Implementation screenshot: `/Users/yang/.codex/visualizations/2026/08/27/01a040e4-52f9-78d2-b975-ebb285583ff3/otto-sidebar-after-normalized.png`
- Combined comparison, left reference / right implementation: `/Users/yang/.codex/visualizations/2026/08/27/01a040e4-52f9-78d2-b975-ebb285583ff3/sidebar-comparison.png`

## Validation state

- Viewport: 1280 x 720 browser preview, captured at the app preview's 0.5 screenshot scale and normalized to 264 x 206 for comparison.
- Theme: light.
- Data state: three local task rows, time grouping, first row selected.
- Interaction state: default, selected, and hover behavior checked. Hover hides the 12 px timestamp and reveals the absolute-positioned 22 x 22 action target with a 16 px icon.

## Comparison history

1. Initial product screenshot showed a 240 px sidebar, 13.5 px semibold task titles, 11 px timestamps, square blue selection, and a 2 px active bar.
2. Final implementation uses a 264 px sidebar, 14/20 regular titles, 12/20 timestamps, 32 px rows, 8 px radius, 2 px row spacing, neutral hover, and a soft blue-gray selected surface. Header and date labels were reduced to a calmer hierarchy while retaining Otto's time grouping.

## Findings

- P0: none.
- P1: none.
- P2: none.
- Intentional difference: Otto retains its task header controls and time-based grouping instead of copying the reference workspace-only hierarchy.
- Automated checks: 34 focused tests passed; desktop typecheck passed; renderer production build passed; `git diff --check` passed.
