# Design QA — Skill chip inside composer

final result: passed

## Source of truth

- User-provided before screenshot: `/var/folders/mg/ctd9153d5_g93y9n6w7tvmf80000gn/T/codex-clipboard-a6e02951-86e7-4b9e-a943-e701a93bb163.png`
- Final implementation capture: `/Users/yang/.codex/visualizations/2026/08/27/01a04100-3fc9-72c0-b593-8a42954fec6e/composer-skill-chip/skill-chip-final.png`
- Focused before/after comparison: `/Users/yang/.codex/visualizations/2026/08/27/01a04100-3fc9-72c0-b593-8a42954fec6e/composer-skill-chip/skill-chip-comparison-final.png`

## Viewport and state

- Source pixels: 1378 x 464, supplied as a focused composer crop.
- Implementation pixels and CSS viewport: 1280 x 720 at 1:1 screenshot output.
- State: light theme, `企业工作 Agent` selected from the module workspace, empty composer draft.
- Full-view evidence: the implementation capture confirms the module tile, context controls, composer, right panel, and attached Skill state remain coherent at the desktop viewport.
- Focused evidence: both source and implementation were normalized to 720 x 270 canvases and placed side by side to compare attachment hierarchy, chip density, and composer height.

## Comparison history

1. The source showed a large 34 px Agent control floating outside the composer and above the workspace and authorization controls.
2. The Agent state was moved into a dedicated composer-internal slot above the textarea.
3. The visual treatment was reduced to a 27 px neutral capsule with a 14 px registered module icon, 11.5 px medium text, and a 12 px Lucide close icon.
4. Browser measurement confirmed the chip is contained by `.otto-composer__inner`, the slot ends before the textarea begins, and the composer grows from 90 px to 127 px only while a Skill is attached.

## Fidelity review

- Fonts and typography: the Skill label uses the existing Otto font at 11.5 px and 500 weight; the textarea, model label, context controls, and helper copy are unchanged.
- Spacing and layout rhythm: the internal Skill slot uses 10 px top and 14 px horizontal padding; the capsule is 27 px high. Context controls remain outside and above the composer.
- Colors and visual tokens: the capsule uses the standard border token, a 3% neutral surface tint, secondary icon color, and no persistent blue outline.
- Image quality and assets: the existing registered `ModuleIcon` is preserved at 14 px; the remove glyph was replaced with the project's existing Lucide-based `IconClose`.
- Copy and content: `企业工作 Agent`, placeholder text, model label, context labels, and helper copy are unchanged.
- Interaction and accessibility: the remove button retains the explicit `移除 企业工作 Agent` accessible name and a neutral focus-visible ring.

## Findings

- P0: none.
- P1: none.
- P2: none after moving the Skill state inside the composer and reducing its visual weight.
- P3: the preview fixture contains a persistent notification card at the far-right edge of the focused crop; it does not overlap the Skill chip or input text.

## Verification

- Composer focused tests: 28 passed. The new assertion verifies that the Agent status is contained by the composer inner element.
- Desktop typecheck: passed.
- Renderer production build: passed.
- Browser interaction: attaching the Agent grows the composer to 127 px; removing it restores 90 px; the draft remains intact; reattaching restores the internal chip.
- `git diff --check`: passed.
