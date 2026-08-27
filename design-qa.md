# Design QA — Task view options

final result: passed

## Source of truth

- Selected icon screenshot: `/var/folders/mg/ctd9153d5_g93y9n6w7tvmf80000gn/T/codex-clipboard-57579884-4810-40d1-a953-84f7afa5f524.png`
- Reference implementation: `anywhere-labs/dsh-desktop@681ba66`, pinned `deepseek-harness@b150a551`, `WorkspaceBrowser.tsx`, `Menu.module.css`, and `IconPersonalizationOutline16`.
- Implementation open-state screenshot: `/Users/yang/.codex/visualizations/2026/08/27/01a040e4-52f9-78d2-b975-ebb285583ff3/otto-view-options-open.jpg`
- Focused menu screenshot: `/Users/yang/.codex/visualizations/2026/08/27/01a040e4-52f9-78d2-b975-ebb285583ff3/otto-view-options-menu-normalized.png`
- Focused icon comparison, left reference / right implementation: `/Users/yang/.codex/visualizations/2026/08/27/01a040e4-52f9-78d2-b975-ebb285583ff3/view-options-icon-comparison.png`

## Viewport and state

- Browser viewport: 1292 x 994 screenshot pixels; light theme; task list expanded.
- Source icon: 74 x 60 pixels. Implementation comparison crop: normalized to 74 x 74 pixels with the 16 x 16 icon centered in its 28 x 28 trigger.
- Menu state: open, current `按时间` option focused and selected; both `按时间` and `按工作目录` visible.
- Primary interactions tested: open, select workspace grouping, verify the visible workspace group, reopen, restore time grouping, outside-click close, and Escape close through the focused component tests.

## Comparison history

1. First implementation pass matched the reference menu tokens but rendered inside the sidebar's clipped scrolling region, cutting off the second option.
2. The menu was moved to a fixed portaled surface aligned to the trigger. The revised capture shows the complete 218 x 102 menu with both options visible and no clipping.

## Fidelity review

- Typography: reference-equivalent 14/22 option text and 12/16 section label using Otto's system font stack.
- Spacing and layout: 218 px card, 4 px inset, 34 px minimum option rows, 10 px row radius, 12 px card radius, and 4 px trigger gap.
- Colors: neutral elevated surface, subtle inverted border, neutral 6% hover/focus fill, and plain selected row with a trailing check.
- Icon: source `PersonalizationOutline16` geometry is used at 16 x 16; the focused comparison shows the same three-slider silhouette and control positions.
- Copy: trigger/menu are named `视图选项`; menu heading is `分组方式`; options remain `按时间` and `按工作目录`, matching Otto's actual capabilities.

## Findings

- P0: none.
- P1: none after the portal clipping fix.
- P2: none.
- Focused Sidebar tests: 26 passed.
- Focused ESLint: passed.
- Renderer production build and `git diff --check`: passed.
- Full desktop typecheck is currently blocked by a pre-existing `RightPanel.tsx:536` handler type mismatch outside this change.
