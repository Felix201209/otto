# Design QA — Enterprise management nested workspace

## Source of truth

- Reference image: `/var/folders/mg/ctd9153d5_g93y9n6w7tvmf80000gn/T/codex-clipboard-1a22c2d8-996f-4df2-a488-d9d55353bf41.png`
- Browser-rendered members state: `/Users/yang/.codex/visualizations/2026/08/27/01a04100-3fc9-72c0-b593-8a42954fec6e/enterprise-management-nested-nav/implementation-members.png`
- Browser-rendered organization state: `/Users/yang/.codex/visualizations/2026/08/27/01a04100-3fc9-72c0-b593-8a42954fec6e/enterprise-management-nested-nav/implementation-organization.png`
- Combined source/implementation comparison: `/Users/yang/.codex/visualizations/2026/08/27/01a04100-3fc9-72c0-b593-8a42954fec6e/enterprise-management-nested-nav/comparison.png`

## Viewport and normalization

- Source pixels: 3840 x 1916.
- Implementation pixels: 1280 x 720 JPEG at a 1280 x 720 CSS viewport and 1x screenshot density.
- Normalization: the source was proportionally downsampled to 1280 x 639, aligned to the top of a 1280 x 720 white canvas, then placed beside the 1280 x 720 implementation in one comparison image.
- State: light theme, authenticated enterprise administrator, `成员目录` selected. A second capture verifies the `组织结构` selected state.

## Full-view comparison evidence

- The reference establishes a three-part hierarchy: product sidebar, attached secondary navigation, and a continuous main canvas.
- The implementation now uses the same hierarchy. Otto's existing sidebar remains unchanged; the enterprise rail is attached through a shared divider rather than a floating card; the active section renders in the adjacent page canvas.
- The main content intentionally retains Otto's enterprise-management copy, data cards, and controls. The reference is used for information architecture and containment, not for copying Monica-specific content.

## Focused-region evidence

- A separate crop was not needed because the 2560 x 720 combined image keeps both secondary navigation regions readable at the same normalized height.
- The implementation capture clearly shows the rail title, four icon-labelled sections, selected state, metadata, divider, section header, and the start of the shared content canvas.

## Fidelity review

- Fonts and typography: Otto's established font stack is preserved. The secondary-rail title is reduced to 20 px/650 weight, section labels to 13 px/560, and metadata to 10 px/400, matching the reference's compact navigation hierarchy without introducing a foreign display font.
- Spacing and layout rhythm: the 218 px rail forms a fixed nested column; the right canvas owns scrolling and uses a centered 1120 px content limit. The former 26 px gap, outer navigation border, radius, and shadow were removed so the rail reads as part of the application frame.
- Colors and visual tokens: the rail uses the existing sidebar/background, border, text, hover, selected-row, and focus tokens. Local content cards retain their semantic surfaces; no new gradient or elevation system was introduced.
- Image quality and assets: no raster or decorative assets are required for this structural target. Navigation and action glyphs use Otto's existing vector icon set; text symbols for back and add actions were replaced by registered icons.
- Copy and content: all Otto section names, descriptions, member data, enterprise invitation copy, and controls remain unchanged. Only containment and hierarchy changed.
- Interaction and accessibility: all four controls remain a roving tablist with arrow/Home/End keyboard support, selected state, `aria-controls`, and a named tabpanel. Browser verification switched from `成员目录` to `组织结构` successfully.

## Findings

- P0: none.
- P1: none.
- P2: none. The floating-card separation identified by the user is removed, and no persistent controls are clipped at the verified desktop viewport.
- P3: the enterprise rail is intentionally a little narrower than the reference's model list because Otto's primary sidebar already consumes more horizontal space; metadata truncates safely when needed.

## Comparison history

1. Before implementation, the enterprise navigation was a bordered, rounded, shadowed 184 px card separated from the content by a 26 px gap.
2. The page skeleton was changed to a full-height `218 px + minmax(0, 1fr)` nested workspace. Title/back navigation and the four sections moved into the attached rail; the content became a shared scrolling canvas.
3. The first combined visual comparison found no actionable P0/P1/P2 mismatch for the requested structural target, so no post-comparison visual correction was required.
4. Browser-preview API fixtures were completed after verification exposed an empty page; the final browser capture renders member and organization states without the earlier runtime failure.

## Verification

- `AccountManagementPage.test.tsx`: 27 tests passed.
- Desktop TypeScript check: passed.
- Renderer production build: passed.
- `git diff --check`: passed.
- Primary browser interactions: opened `企业管理`, verified the nested rail and member directory, switched to `组织结构`, and confirmed its editable department/position controls remained present.

final result: passed
