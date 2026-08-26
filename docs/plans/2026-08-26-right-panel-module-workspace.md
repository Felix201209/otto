# Right-Side Module Workspace Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the right-side Expert/Enterprise Memory tab UI with a user-configurable, two-group module workspace while preserving every existing business action, moving contacts into Organization, and staging Agent modules in the composer instead of creating empty conversations immediately.

**Architecture:** Use a strangler migration rather than replacing `RightPanel` early. Introduce a versioned, server/edition/user/organization-scoped local layout model and an edition-aware module catalog, build every replacement activation surface while the current right rail remains intact, and perform one final cutover only after characterization and integration tests pass. Route modules through one of three existing front-end activation adapters: App-level modal, existing full-page navigation, or composer Agent selection. Extract the current enterprise-memory and auto-Skill blocks into dialogs without changing Electron IPC names, payloads, server frames, authorization rules, or persistence of business data.

**Tech Stack:** React 18, TypeScript 5.9, Electron, Vitest, Testing Library, Motion for React (`motion/react`), localStorage for UI layout only, existing Lucide-style local icon components and generated expert icons.

---

## Scope and non-negotiable constraints

- Work only on `feature/ui-improvements` (or a dedicated worktree based on it). Do not commit to or push `main`/`internal`.
- Record the exact starting commit SHA before the first product-code change and use that immutable SHA for every final diff audit. Do not use a moving `internal` merge-base after implementation begins.
- This plan changes front-end information architecture and front-end UI persistence. It must not change backend protocols, IPC channel names, database schemas, server-side Agent profiles, authorization rules, or enterprise-memory/park-service business behavior.
- Persist only module-layout preferences locally: group IDs, names, order, height, and module IDs. Never copy enterprise knowledge, contacts, Agent prompts, park-service records, or authorization data into the layout record.
- Keep Organization as a left-navigation full page. Do not expose Organization as a right-rail module.
- Move the current server-backed Product Workspace “好友” functionality into Organization as “常用联系人”; keep the existing `add_friend` action, server record, and synchronization behavior. Remove the duplicated enterprise/organization drawer from the right rail only at final cutover.
- Enterprise edition starts with exactly two default groups: “园区服务” and “日常办公”, with six pre-added modules in each so the initial 2×3 grid does not scroll. Personal edition receives only modules currently available to personal users and must not synthesize park, enterprise-memory, enterprise-work, or enterprise-only Skill capabilities.
- A group shows two rows by default, may be expanded to three rows, and scrolls internally only when its module count exceeds the selected visible capacity (more than six at two rows, more than nine at three rows).
- A module can occur only once across the workspace. Adding it to a different group moves it rather than duplicating it.
- Cross-group drag-and-drop is deliberately out of scope for v1. Users move modules between groups through the module marketplace. Group order and within-group module order are draggable.
- Removing a module from a group only edits the layout. Deleting a custom expert remains a separate destructive action in the expert manager.
- Clicking a fixed/custom Agent module selects a composer chip. It must not immediately create an empty conversation. The new profile-bound session is created only on send.
- The catalog and defaults are capability-driven. They must be composed from the current edition, authenticated organization feature flags, role/park authorization, and the existing profile registry. UI layout data never grants access.
- The existing `RightPanel` has both narrow `presentation="panel"` and full-page `presentation="page"` consumers. Both forms must remain valid during migration; the new workspace must not assume a fixed rail width.
- All module dialogs are coordinated by one App-level discriminated-union modal state. Opening a module, switching account/organization/server, signing out, or opening a mutually exclusive surface must not leave stacked or stale business dialogs behind.
- Do not package the App or perform manual real-device visual acceptance as part of this plan unless separately requested.

## Final module inventory and activation contract

| Category | Module | Activation | Existing behavior to preserve |
| --- | --- | --- | --- |
| 园区服务 | 园区服务统计 | Dialog | Existing park statistics and authorization |
| 园区服务 | 园区公告 | Dialog/deep link | Existing park service panel |
| 园区服务 | 满意度调查 | Dialog/deep link | Existing survey workflow |
| 园区服务 | 装修管理 | Dialog/deep link | Existing application workflow |
| 园区服务 | 停车办理 | Dialog/deep link | Existing application workflow |
| 园区服务 | 网络与固话 | Dialog/deep link | Existing application workflow |
| 园区服务 | 会议室预约 | Dialog/deep link | Existing reservation workflow |
| 园区服务 | 电卡服务 | Dialog/deep link | Existing application workflow |
| 园区服务 | 物业报修 | Dialog/deep link | Existing repair workflow |
| 园区服务 | 车辆与访客 | Dialog/deep link | Existing visitor/vehicle workflow |
| 园区服务 | 园区待办 | Dialog/deep link | Existing staff task view; visible only when authorized |
| 园区服务 | 我的申请 | Dialog/deep link | Existing current-user history |
| 日常办公 | 企业工作 Agent | Agent chip | Existing `otto-enterprise-work` profile |
| 日常办公 | PPT 创作专家 | Agent chip | Existing fixed Agent profile |
| 日常办公 | 会议 Agent | Agent chip | Existing fixed Agent profile |
| 日常办公 | Word 公文撰写 | Agent chip | Existing fixed Agent profile |
| 日常办公 | Excel 数据表格 | Agent chip | Existing fixed Agent profile |
| 日常办公 | PDF 文档处理 | Agent chip | Existing fixed Agent profile |
| 日常办公 | 数据可视化 | Agent chip | Existing fixed Agent profile |
| 日常办公 | 市场竞品调研 | Agent chip | Existing fixed Agent profile |
| 日常办公 | 品牌营销文案 | Agent chip | Existing fixed Agent profile |
| 日常办公 | 自主开发 | Agent chip | Existing self-development profile |
| 企业能力 | 企业记忆 | Dialog | Current enterprise knowledge list/history/review/revision actions; enterprise capability only |
| 企业能力 | 自动 Skill | Dialog | Current auto-Skill candidate list/actions |
| 企业能力 | Skill 专区 | Route | Existing full-page Skill Zone |
| 我的专家 | One module per saved custom expert | Agent chip | Existing local custom-expert definition and base-profile launch |

“我的专家” is a marketplace category and management entry, not a standalone module. Organization and contacts are intentionally absent from this catalog.

## Edition-aware default layout

```text
┌ 园区服务 ··· ──────────────────────┐
│ [公告] [满意度] [装修]             │
│ [停车] [网络固话] [会议室]         │  default: 2 visible rows / 6 modules
│                              [＋]  │
└───────────────────────────────────┘

┌ 日常办公 ··· ──────────────────────┐
│ [企业工作] [PPT] [会议]            │
│ [Word] [Excel] [企业记忆]          │
│                              [＋]  │
└───────────────────────────────────┘

                     [＋ 添加功能组]
```

The enterprise defaults above intentionally contain six modules per group. `物业报修`, `园区服务统计`, `PDF 文档处理`, and the remaining available modules stay in the marketplace. Adding a seventh item activates internal scrolling in the two-row state; switching to three rows shows up to nine before scrolling.

Personal edition does not reuse the enterprise template. Its initial template is built from personal `BASE_AGENT_PROFILES` plus currently available personal capabilities (for example Otto and Auto Skill when enabled). It must never render a disabled enterprise shell merely to preserve the two-group visual. If only one useful personal group exists, render one group and the “添加功能组” action.

Each module is a unique icon/avatar plus a short name. The grid has three columns. The group menu contains: 编辑、添加模块、重命名、显示 2 行/3 行、删除组、恢复默认布局. Any group may be deleted after confirmation except the last remaining group; removal affects layout only and is undoable. “恢复默认布局” restores the current edition/capability template, not a hard-coded enterprise template.

## Module marketplace interaction

```text
┌ 添加模块                                      × ┐
│ [搜索模块……                                  ] │
│                                               │
│ 常用                                          │
│ [企业工作 Agent] [PPT] [会议] [Word]          │
│                                               │
│ 园区服务                                      │
│ [公告] [满意度] [装修] [停车] [网络] [会议室] │
│ [电卡] [报修] [访客] [统计] [待办] [我的申请] │
│                                               │
│ 企业能力                                      │
│ [企业记忆] [自动 Skill] [Skill 专区]          │
│                                               │
│ 我的专家                         [管理专家]    │
│ [招投标助手] [客户成功助手] ...               │
│                                               │
│                          取消  [添加（N）]     │
└───────────────────────────────────────────────┘
```

- Selection is multi-select; clicking “添加（N）” applies the batch once.
- A module already in the current group is marked “已添加” and disabled.
- A module in another group is marked with that group name; selecting it shows “将移动到本组”.
- Unavailable or unauthorized modules remain discoverable only when useful, but are disabled and explain why. Sensitive modules that the user must not discover remain filtered by the existing authorization result.
- Click outside, Escape, and the close button close the dialog. Focus is trapped and restored.

## Editing and drag behavior

- Enter edit mode from the group `…` menu. Do not imitate continuous iOS icon “jiggle”; use a restrained edit-state highlight plus visible drag handles and minus buttons so reduced-motion users receive the same information.
- Minus appears at the top-left of module tiles. Removal is immediate with a 5-second “已从该组移除 — 撤销” toast.
- Drag group cards vertically. Drag modules within the group’s three-column grid.
- Use Motion `Reorder.Group`/`Reorder.Item`, spring layout transitions, a lifted shadow and slight scale on the dragged item, natural sibling reflow, and edge auto-scroll.
- Write localStorage only when the drag finishes, not on every pointer move.
- Provide keyboard reordering through the group/module menu (“上移/下移/移到最前/移到最后”). Disable nonessential motion under `prefers-reduced-motion`.

## Task 1: Freeze the baseline and add layout-domain tests

**Files:**
- Create: `packages/desktop/src/renderer/moduleWorkspace.ts`
- Create: `packages/desktop/src/renderer/moduleWorkspace.test.ts`

**Step 1: Verify the execution branch and clean baseline**

Run:

```bash
git branch --show-current
git status --short
git rev-parse HEAD
```

Expected: branch is `feature/ui-improvements`; status is empty except for this plan document if it has not yet been committed. Copy the exact SHA returned by the third command into the implementation log as `<MODULE_WORKSPACE_BASE_SHA>`; Tasks 14–15 must audit against that exact value.

Run the current focused baseline suite before editing and record the result:

```bash
npm test --workspace=packages/desktop -- \
  src/renderer/components/RightPanel.test.tsx \
  src/renderer/components/Composer.test.tsx \
  src/renderer/components/ChatView.test.tsx \
  src/renderer/state/useOttoStore.test.ts \
  src/renderer/components/ParkServicesPlugin.test.tsx \
  src/renderer/components/OrganizationPage.test.tsx \
  src/renderer/rightPanelPreference.test.ts
```

Expected at planning time: seven files / 159 tests pass. Existing React `act(...)` warnings in Composer tests may be recorded as baseline noise, but new warnings are not accepted.

**Step 2: Write failing tests for defaults, migration, sanitization, and uniqueness**

Create tests covering:

```ts
expect(createDefaultModuleWorkspace(enterpriseCapabilities)).toEqual({
  version: 1,
  groups: [
    {
      id: 'park-services',
      name: '园区服务',
      rows: 2,
      moduleIds: [
        'park-announcement',
        'park-satisfaction',
        'park-renovation',
        'park-parking',
        'park-network-phone',
        'park-meeting-room',
      ],
    },
    {
      id: 'daily-office',
      name: '日常办公',
      rows: 2,
      moduleIds: [
        'agent-enterprise-work',
        'agent-ppt',
        'agent-meeting',
        'agent-word',
        'agent-excel',
        'enterprise-memory',
      ],
    },
  ],
});

expect(createDefaultModuleWorkspace(personalCapabilities))
  .not.toContainEnterpriseOrParkModules();
expect(parseModuleWorkspace('{bad json', enterpriseCapabilities))
  .toEqual(createDefaultModuleWorkspace(enterpriseCapabilities));
expect(parseModuleWorkspace(JSON.stringify({ version: 99 }), enterpriseCapabilities))
  .toEqual(createDefaultModuleWorkspace(enterpriseCapabilities));
expect(normalizeModuleWorkspace(layoutWithDuplicateModuleIds))
  .toHaveNoDuplicateModuleIds();
expect(normalizeModuleWorkspace(layoutWithRowsOutsideRange).groups[0].rows)
  .toBe(2);
```

Also test name length, unique group IDs, retention of unknown module IDs for forward compatibility, and filtering at render time rather than destructive deletion during parse. Do not introduce an arbitrary group-count limit unless an existing product constraint requires one. Test that the last group cannot be deleted, any other group can be deleted with layout-only undo, and restored defaults are recomputed from the current edition/capability snapshot.

**Step 3: Run the focused test and confirm failure**

Run:

```bash
npm test --workspace=packages/desktop -- src/renderer/moduleWorkspace.test.ts
```

Expected: FAIL because the domain module does not exist.

**Step 4: Implement the minimal versioned model**

Implement:

```ts
export const MODULE_WORKSPACE_SCHEMA_VERSION = 1 as const;

export interface ModuleGroupLayout {
  id: string;
  name: string;
  rows: 2 | 3;
  moduleIds: string[];
}

export interface ModuleWorkspaceLayout {
  version: typeof MODULE_WORKSPACE_SCHEMA_VERSION;
  groups: ModuleGroupLayout[];
}

export function getModuleWorkspaceStorageKey(input: {
  serverUrl: string;
  edition: 'personal' | 'enterprise';
  organizationId?: string;
  accountId: string;
}): string {
  return [
    'otto.module-workspace.v1',
    normalizeServerUrlForStorage(input.serverUrl),
    input.edition,
    input.organizationId || 'personal',
    input.accountId,
  ].join(':');
}
```

Add pure helpers for parse, normalize, add/move/remove module, reorder groups, reorder modules, rename group, update row count, and restore defaults. Keep I/O outside these helpers.

`createDefaultModuleWorkspace(capabilities)` must receive an explicit capability snapshot rather than reading global state. This makes edition/feature/role behavior testable and prevents the layout model from becoming an authorization source.

**Step 5: Run tests**

Run:

```bash
npm test --workspace=packages/desktop -- src/renderer/moduleWorkspace.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/desktop/src/renderer/moduleWorkspace.ts packages/desktop/src/renderer/moduleWorkspace.test.ts
git commit -m "feat(ui): add versioned module workspace layout"
```

## Task 2: Build the centralized module catalog and unique icon registry

**Files:**
- Create: `packages/desktop/src/renderer/moduleCatalog.ts`
- Create: `packages/desktop/src/renderer/moduleCatalog.test.ts`
- Create: `packages/desktop/src/renderer/components/ModuleIcon.tsx`
- Create: `packages/desktop/src/renderer/components/ModuleIcon.test.tsx`
- Modify: `packages/desktop/src/renderer/components/icons.tsx`
- Reuse: `packages/desktop/src/renderer/components/GeneratedIcon.tsx`
- Reuse: `packages/desktop/src/renderer/agents/departmentAgents.ts`
- Reuse: `packages/desktop/src/renderer/customAgents.ts`

**Step 1: Write failing catalog tests**

Test that:

- Every static catalog ID is unique.
- Every visible module has a nonempty label, category, activation kind, and icon key.
- Every icon key resolves to a distinct icon component or generated expert image.
- Organization and contacts are not in the catalog.
- Custom experts are converted to dynamic `agent` modules without changing their stored definitions.
- Existing capability/role checks hide or disable park staff and enterprise-only modules correctly.
- Personal and enterprise inputs produce different catalogs and default templates.
- An untrusted/local layout record cannot change `hidden`/`disabled` to `available`.
- Enterprise feature flags are fail-closed while loading or on request failure; authenticated server results remain authoritative.

Use a discriminated union:

```ts
type ModuleActivation =
  | { kind: 'dialog'; dialog: 'park' | 'enterprise-memory' | 'auto-skill'; target?: string }
  | { kind: 'route'; route: 'skill-zone' }
  | { kind: 'agent'; profileId: string; customAgentId?: string };

interface ModuleCatalogContext {
  edition: 'personal' | 'enterprise';
  profiles: readonly AgentProfile[];
  organizationFeatures: EnterpriseOrganizationFeatures | null;
  parkAuthorization: ParkAuthorization;
  customAgents: readonly CustomAgentDefinition[];
}

interface ModuleDefinition {
  id: string;
  label: string;
  category: 'common' | 'park' | 'capability' | 'custom-agent';
  icon: ModuleIconKey;
  activation: ModuleActivation;
  availability: 'available' | 'disabled' | 'hidden';
  disabledReason?: string;
}
```

**Step 2: Run tests and confirm failure**

```bash
npm test --workspace=packages/desktop -- src/renderer/moduleCatalog.test.ts src/renderer/components/ModuleIcon.test.tsx
```

Expected: FAIL because the catalog and registry do not exist.

**Step 3: Implement capability-driven catalog composition**

Create static metadata for the inventory table above, then compose actionable definitions through `buildModuleCatalog(context)`. Derive fixed Agent entries from the profiles already available for the current edition instead of importing the enterprise registry unconditionally or duplicating profile IDs. Add dynamic custom-agent definitions with the existing generated expert icon mapping.

Availability must be computed from the same authenticated edition, feature-flag, role, and park-brand/organization inputs already used by `RightPanel` and park services. The module catalog may further restrict a capability but may never broaden it.

Add unique local line icons for park/capability entries in `icons.tsx`. Do not add remote icon requests or duplicate one generic icon across unrelated modules.

**Step 4: Run focused tests**

```bash
npm test --workspace=packages/desktop -- src/renderer/moduleCatalog.test.ts src/renderer/components/ModuleIcon.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/desktop/src/renderer/moduleCatalog.ts packages/desktop/src/renderer/moduleCatalog.test.ts packages/desktop/src/renderer/components/ModuleIcon.tsx packages/desktop/src/renderer/components/ModuleIcon.test.tsx packages/desktop/src/renderer/components/icons.tsx
git commit -m "feat(ui): define module catalog and icon registry"
```

## Task 3: Build the scoped layout hook in isolation

**Files:**
- Create: `packages/desktop/src/renderer/state/useModuleWorkspace.ts`
- Create: `packages/desktop/src/renderer/state/useModuleWorkspace.test.ts`

**Step 1: Write failing hook tests**

Test:

- Missing storage returns defaults.
- Different account/organization keys do not leak layouts into one another.
- Different normalized server URLs do not share layouts, even when account and organization IDs match.
- A corrupt record falls back safely without overwriting until the user changes layout.
- Save happens once on a committed operation.
- Hidden/unavailable modules remain in stored layout but are filtered from the view model.

**Step 2: Run and confirm failure**

```bash
npm test --workspace=packages/desktop -- src/renderer/state/useModuleWorkspace.test.ts
```

Expected: FAIL.

**Step 3: Implement the hook**

Expose:

```ts
interface UseModuleWorkspaceResult {
  layout: ModuleWorkspaceLayout;
  setLayout(next: ModuleWorkspaceLayout): void;
  restoreDefaults(): void;
}
```

Use the storage key helper from Task 1. Keep this hook independent of `useOttoStore`; it owns UI preference state only.

**Step 4: Test scope changes without wiring production UI**

Use a hook test harness that changes server URL, edition, organization identity, account identity, and capability snapshot. Assert that it loads the new scoped layout, discards transient edits, and never writes the old transient state under the new key. Production App wiring happens atomically in Task 14, avoiding unused or hidden production state during the migration.

**Step 5: Run tests and typecheck**

```bash
npm test --workspace=packages/desktop -- src/renderer/state/useModuleWorkspace.test.ts
npm run typecheck --workspace=packages/desktop
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/desktop/src/renderer/state/useModuleWorkspace.ts packages/desktop/src/renderer/state/useModuleWorkspace.test.ts
git commit -m "feat(ui): persist scoped module workspace preferences"
```

## Task 4: Build the workspace in isolation; do not switch RightPanel yet

**Files:**
- Create: `packages/desktop/src/renderer/components/ModuleWorkspace.tsx`
- Create: `packages/desktop/src/renderer/components/ModuleWorkspace.test.tsx`
- Modify: `packages/desktop/src/renderer/styles/app.css`

**Step 1: Write failing component tests**

Test that the workspace:

- Renders the enterprise two-group/six-module defaults from injected data.
- Renders a personal capability fixture without enterprise or park modules.
- Uses a three-column module grid.
- Exposes an accessible module button name (`aria-label="打开 PPT 创作专家"`).
- Shows a group-local add button.
- Applies a two-row/three-row class without cutting off keyboard focus.
- Uses internal group scrolling when content exceeds the selected height.
- Supports both narrow `presentation="panel"` and wide `presentation="page"` responsive fixtures without changing activation semantics.

**Step 2: Run and confirm failure**

```bash
npm test --workspace=packages/desktop -- src/renderer/components/ModuleWorkspace.test.tsx src/renderer/components/RightPanel.test.tsx
```

Expected: FAIL.

**Step 3: Implement the presentational workspace**

Keep actions injectable:

```ts
interface ModuleWorkspaceProps {
  presentation: 'panel' | 'page';
  layout: ModuleWorkspaceLayout;
  modules: readonly ModuleDefinition[];
  onActivate(module: ModuleDefinition): void;
  onOpenMarketplace(groupId: string): void;
  onLayoutChange(next: ModuleWorkspaceLayout): void;
}
```

Do not embed IPC calls or Agent launch logic in this component.

**Step 4: Keep the component isolated**

Keep every current `RightPanel` render path and old UI visible. Exercise the workspace through component tests only; do not add a hidden production feature flag or dormant render branch that could accidentally persist as a second UI path. Typed App adapters are added alongside the business-surface migrations in Tasks 8–13.

**Step 5: Run focused tests and typecheck**

```bash
npm test --workspace=packages/desktop -- src/renderer/components/ModuleWorkspace.test.tsx src/renderer/components/RightPanel.test.tsx
npm run typecheck --workspace=packages/desktop
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/desktop/src/renderer/components/ModuleWorkspace.tsx packages/desktop/src/renderer/components/ModuleWorkspace.test.tsx packages/desktop/src/renderer/styles/app.css
git commit -m "feat(ui): build configurable module workspace"
```

## Task 5: Implement the module marketplace and move semantics

**Files:**
- Create: `packages/desktop/src/renderer/moduleModal.ts`
- Create: `packages/desktop/src/renderer/moduleModal.test.ts`
- Create: `packages/desktop/src/renderer/components/ModuleMarketplaceDialog.tsx`
- Create: `packages/desktop/src/renderer/components/ModuleMarketplaceDialog.test.tsx`
- Modify: `packages/desktop/src/renderer/components/ModuleWorkspace.tsx`
- Modify: `packages/desktop/src/renderer/components/ModuleWorkspace.test.tsx`
- Modify: `packages/desktop/src/renderer/styles/app.css`

**Step 1: Write failing interaction tests**

Cover search, categories, multi-select, Add(N), current-group disabled state, move-from-other-group copy, disabled reason, backdrop click, Escape, focus trap/restore, and “管理专家”. Add pure modal-coordinator tests proving that only one module modal can be active, opening another replaces/closes the prior surface, and identity/server changes reset modal state.

Example:

```ts
await user.click(screen.getByRole('button', { name: '向园区服务添加模块' }));
await user.click(screen.getByRole('checkbox', { name: 'PPT 创作专家' }));
expect(screen.getByRole('button', { name: '添加（1）' })).toBeEnabled();
await user.click(screen.getByRole('button', { name: '添加（1）' }));
expect(onLayoutChange).toHaveBeenCalledWith(
  expectLayoutWhereModuleOccursOnceIn('agent-ppt', 'park-services'),
);
```

**Step 2: Run and confirm failure**

```bash
npm test --workspace=packages/desktop -- src/renderer/components/ModuleMarketplaceDialog.test.tsx src/renderer/components/ModuleWorkspace.test.tsx
```

Expected: FAIL.

**Step 3: Implement the dialog**

Use a portal to `document.body`. Keep selection local until confirmation. Apply a single pure `addOrMoveModules` layout operation on confirm. Define a discriminated union in `moduleModal.ts` for `marketplace | park | enterprise-memory | auto-skill | custom-expert | null`. Test its pure transitions now; begin owning one instance in App when the first migrated business dialog is wired in Task 8. It must not stack with Settings or another business modal. Account/server/organization changes close it without applying the draft.

**Step 4: Verify modal behavior and no duplicate modules**

```bash
npm test --workspace=packages/desktop -- src/renderer/components/ModuleMarketplaceDialog.test.tsx src/renderer/moduleWorkspace.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/desktop/src/renderer/moduleModal.ts packages/desktop/src/renderer/moduleModal.test.ts packages/desktop/src/renderer/components/ModuleMarketplaceDialog.tsx packages/desktop/src/renderer/components/ModuleMarketplaceDialog.test.tsx packages/desktop/src/renderer/components/ModuleWorkspace.tsx packages/desktop/src/renderer/components/ModuleWorkspace.test.tsx packages/desktop/src/renderer/styles/app.css
git commit -m "feat(ui): add searchable module marketplace"
```

## Task 6: Add group management, edit mode, removal undo, and keyboard reorder

**Files:**
- Modify: `packages/desktop/src/renderer/components/ModuleWorkspace.tsx`
- Modify: `packages/desktop/src/renderer/components/ModuleWorkspace.test.tsx`
- Modify: `packages/desktop/src/renderer/moduleWorkspace.ts`
- Modify: `packages/desktop/src/renderer/moduleWorkspace.test.ts`
- Modify: `packages/desktop/src/renderer/styles/app.css`

**Step 1: Write failing tests**

Cover:

- Create group with a unique default name.
- Rename and validate empty/duplicate names.
- Toggle two/three rows.
- Enter/exit edit mode.
- Remove module and undo within five seconds.
- Remove module does not delete a custom expert definition.
- Delete any group except the last one only after confirmation; modules become unassigned/available in marketplace, and the layout deletion can be undone.
- Restore defaults requires confirmation and changes only layout.
- Keyboard move actions update order.

Use fake timers for undo expiration.

**Step 2: Run and confirm failure**

```bash
npm test --workspace=packages/desktop -- src/renderer/components/ModuleWorkspace.test.tsx src/renderer/moduleWorkspace.test.ts
```

Expected: FAIL.

**Step 3: Implement minimal controls**

Render the group menu in a dismissible popup. All list panels must close on outside click and Escape. Keep destructive group reset/delete behind a confirmation dialog.

**Step 4: Run tests**

```bash
npm test --workspace=packages/desktop -- src/renderer/components/ModuleWorkspace.test.tsx src/renderer/moduleWorkspace.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/desktop/src/renderer/components/ModuleWorkspace.tsx packages/desktop/src/renderer/components/ModuleWorkspace.test.tsx packages/desktop/src/renderer/moduleWorkspace.ts packages/desktop/src/renderer/moduleWorkspace.test.ts packages/desktop/src/renderer/styles/app.css
git commit -m "feat(ui): add module group editing and undo"
```

## Task 7: Add Motion reorder with persistence only on drop

**Files:**
- Modify: `packages/desktop/package.json`
- Modify: `package-lock.json`
- Modify: `packages/desktop/src/renderer/components/ModuleWorkspace.tsx`
- Modify: `packages/desktop/src/renderer/components/ModuleWorkspace.test.tsx`
- Modify: `packages/desktop/src/renderer/styles/app.css`

**Step 1: Add failing reorder/reduced-motion tests**

Assert that:

- Group order changes through the reorder callback.
- Module order changes only inside its group.
- The persistence callback is not invoked during transient pointer movement and is invoked once at drag end.
- Reduced-motion mode removes spring/scale decoration but retains reorder controls.

Testing Library cannot faithfully measure visual smoothness; test the state contract and keyboard fallback. Reserve animation feel for the user’s later manual test.

**Step 2: Install Motion in the desktop workspace**

Run:

```bash
npm install motion --workspace=packages/desktop
```

Expected: `motion` is added to `packages/desktop/package.json`, and the root lockfile updates.

**Step 3: Run a bounded nested-grid spike before committing to the API**

Implement a test/demo fixture with one vertical group list and one 3-column module grid. Verify pointer drag handles, sibling reflow, two- and three-row containers, internal scroll, panel-edge auto-scroll, keyboard fallback, and reduced motion. If Motion `Reorder` cannot reliably provide 2D grid reflow plus nested scrolling, stop this task and choose a dedicated accessible sortable implementation before modifying production state. Do not force an `axis="xy"` approach that passes unit tests but cannot express the required geometry.

**Step 4: Implement reorder using the validated approach**

If the spike validates Motion `Reorder`, use stable primitive IDs as reorder values rather than mutable group objects:

```tsx
import { Reorder, useReducedMotion } from 'motion/react';

<Reorder.Group axis="y" values={groupIds} onReorder={setTransientGroupIds}>
  {groups.map((group) => (
    <Reorder.Item key={group.id} value={group.id} dragListener={false}>
      {/* explicit group drag handle */}
      <Reorder.Group axis="xy" values={group.moduleIds} onReorder={...}>
        {/* module items with explicit handles in edit mode */}
      </Reorder.Group>
    </Reorder.Item>
  ))}
</Reorder.Group>
```

Keep pointer-down on module activation buttons separate from drag handles. Add edge auto-scroll to the nearest group/right-panel scroller. Commit the final layout from `onDragEnd`.

**Step 5: Run focused tests and renderer build**

```bash
npm test --workspace=packages/desktop -- src/renderer/components/ModuleWorkspace.test.tsx
npm run typecheck --workspace=packages/desktop
npm run build:renderer --workspace=packages/desktop
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/desktop/package.json package-lock.json packages/desktop/src/renderer/components/ModuleWorkspace.tsx packages/desktop/src/renderer/components/ModuleWorkspace.test.tsx packages/desktop/src/renderer/styles/app.css
git commit -m "feat(ui): add smooth module workspace reordering"
```

## Task 8: Add park-service deep links without changing park APIs

**Files:**
- Modify: `packages/desktop/src/renderer/components/ParkServicesPlugin.tsx`
- Modify: `packages/desktop/src/renderer/components/ParkServicesPlugin.test.tsx`
- Modify: `packages/desktop/src/renderer/App.tsx`
- Modify: `packages/desktop/src/renderer/moduleCatalog.ts`

**Step 1: Write failing deep-link tests**

Test opening each module target:

```ts
type ParkModuleTarget =
  | 'overview'
  | 'announcement'
  | 'satisfaction'
  | 'renovation'
  | 'parking'
  | 'network-phone'
  | 'meeting-room'
  | 'electric-card'
  | 'repair'
  | 'vehicle-visit'
  | 'staff-tasks'
  | 'my-applications';
```

Assert that unauthorized staff targets are not activatable and that all existing IPC mocks receive the same payloads as before.

**Step 2: Run and confirm failure**

```bash
npm test --workspace=packages/desktop -- src/renderer/components/ParkServicesPlugin.test.tsx
```

Expected: FAIL because current opening supports only the undifferentiated panel.

**Step 3: Extend the front-end opening contract**

Accept `initialTarget` (or typed event detail) in the App-level park dialog. Route to existing internal tabs/cards; do not create new IPC calls or duplicate service forms. At this point, replace App’s independent park-dialog boolean with the `moduleModal.ts` coordinator. Opening Settings closes the business modal; opening a business modal closes Settings; server/account/organization changes clear both transient surfaces without changing right-panel preference.

**Step 4: Connect catalog dialog activations**

Map every park catalog module to `openParkServices(target)`. Keep the original broad park entry compatible until RightPanel cleanup is complete.

**Step 5: Run tests**

```bash
npm test --workspace=packages/desktop -- src/renderer/components/ParkServicesPlugin.test.tsx src/renderer/moduleCatalog.test.ts
npm run typecheck --workspace=packages/desktop
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/desktop/src/renderer/components/ParkServicesPlugin.tsx packages/desktop/src/renderer/components/ParkServicesPlugin.test.tsx packages/desktop/src/renderer/App.tsx packages/desktop/src/renderer/moduleCatalog.ts
git commit -m "feat(ui): deep link park service modules"
```

## Task 9: Extract enterprise memory into an App-level dialog

**Files:**
- Create: `packages/desktop/src/renderer/components/EnterpriseMemoryDialog.tsx`
- Create: `packages/desktop/src/renderer/components/EnterpriseMemoryDialog.test.tsx`
- Modify: `packages/desktop/src/renderer/App.tsx`
- Modify: `packages/desktop/src/renderer/styles/app.css`

**Step 1: Write characterization tests before moving code**

Copy the existing enterprise-memory behavior expectations from `RightPanel.test.tsx` into the new dialog test. Cover list/search/refresh, recent work log, detail selection, record, review, revise, revision history, archive, role-based buttons, failure notes, unsaved-close guard, backdrop/Escape close, focus trap, and focus restore.

Mock the same APIs currently called:

```ts
window.otto.enterpriseKnowledgeList
window.otto.enterpriseWorkLogRecent
window.otto.enterpriseKnowledgeRecord
window.otto.enterpriseKnowledgeReview
window.otto.enterpriseKnowledgeRevise
window.otto.enterpriseKnowledgeRevisions
```

Do not rename or wrap these IPC APIs in a new backend interface.

**Step 2: Run tests and confirm the new dialog test fails**

```bash
npm test --workspace=packages/desktop -- src/renderer/components/EnterpriseMemoryDialog.test.tsx
```

Expected: FAIL because the dialog does not exist.

**Step 3: Extract, do not rewrite, the business UI**

Move state/effects/handlers from `RightPanel.tsx` into a portal dialog. Use a responsive 960–1200px width and about 80vh height, with list/detail internal panes. Preserve all authorization inputs and API payloads.

**Step 4: Wire activation at App level**

`enterprise-memory` module activation opens the dialog. Opening/closing the dialog must not change right-panel collapsed state.

**Step 5: Keep the old RightPanel memory branch until final cutover**

After the characterization suite passes, verify the new dialog through its dormant activation adapter, but retain the current tab state and rendering. Removal happens atomically in Task 14 only after all replacement surfaces pass integration tests. Do not delete backend APIs or preload types.

**Step 6: Run tests**

```bash
npm test --workspace=packages/desktop -- src/renderer/components/EnterpriseMemoryDialog.test.tsx src/renderer/components/RightPanel.test.tsx
npm run typecheck --workspace=packages/desktop
```

Expected: PASS.

**Step 7: Commit**

```bash
git add packages/desktop/src/renderer/components/EnterpriseMemoryDialog.tsx packages/desktop/src/renderer/components/EnterpriseMemoryDialog.test.tsx packages/desktop/src/renderer/App.tsx packages/desktop/src/renderer/styles/app.css
git commit -m "refactor(ui): move enterprise memory into dialog"
```

## Task 10: Extract auto-Skill and keep Skill Zone navigation

**Files:**
- Create: `packages/desktop/src/renderer/components/AutoSkillDialog.tsx`
- Create: `packages/desktop/src/renderer/components/AutoSkillDialog.test.tsx`
- Modify: `packages/desktop/src/renderer/App.tsx`
- Modify: `packages/desktop/src/renderer/styles/app.css`

**Step 1: Write failing characterization tests**

Move current auto-Skill candidate expectations out of RightPanel tests. Assert identical analyze/refresh/action/error behavior and permission gating in the dialog. Add a separate assertion that the Skill Zone module still invokes the existing full-page navigation callback.

**Step 2: Run and confirm failure**

```bash
npm test --workspace=packages/desktop -- src/renderer/components/AutoSkillDialog.test.tsx
```

Expected: FAIL.

**Step 3: Extract the UI and wire activations**

Open `AutoSkillDialog` for `auto-skill`; route `skill-zone` through the current main-view navigation. Preserve feature flags and APIs.

**Step 4: Keep the old long-list markup until final cutover**

Test the replacement dialog and existing route adapter while leaving the production RightPanel entry intact. Delete it only in Task 14.

**Step 5: Verify**

```bash
npm test --workspace=packages/desktop -- src/renderer/components/AutoSkillDialog.test.tsx src/renderer/components/RightPanel.test.tsx
npm run typecheck --workspace=packages/desktop
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/desktop/src/renderer/components/AutoSkillDialog.tsx packages/desktop/src/renderer/components/AutoSkillDialog.test.tsx packages/desktop/src/renderer/App.tsx packages/desktop/src/renderer/styles/app.css
git commit -m "refactor(ui): move auto skill into dialog"
```

## Task 11: Stage Agent modules as a composer chip and send attachments into the new profile session

**Files:**
- Modify: `packages/desktop/src/renderer/App.tsx`
- Modify: `packages/desktop/src/renderer/components/ChatView.tsx`
- Modify: `packages/desktop/src/renderer/components/ChatView.test.tsx`
- Modify: `packages/desktop/src/renderer/components/Composer.tsx`
- Modify: `packages/desktop/src/renderer/components/Composer.test.tsx`
- Modify: `packages/desktop/src/renderer/state/useOttoStore.ts`
- Modify: `packages/desktop/src/renderer/state/useOttoStore.test.ts`

**Step 1: Write failing composer tests**

Test:

- Selecting an Agent module renders one chip inside the composer.
- Selecting another replaces the current chip.
- Clicking the chip close button clears it.
- Switching sessions clears the pending selection.
- Selecting an Agent does not call `create_session`.
- Sending text/attachments with a selected Agent creates one profile-bound session, correlates the exact server response, and sends the task once after that exact session is confirmed.
- Two rapid launches cannot exchange kickoff payloads or send into each other’s session.
- Server rejection/disconnect clears only the matching pending launch and never leaks its task into a later session.
- Slash Agent commands keep their current immediate-launch behavior in v1; only clicks from the new module workspace stage a chip. Changing slash semantics is a separate product decision.
- Empty text with an image/file attachment is valid.
- A selected enterprise Agent uses the same enterprise-knowledge lookup/authorization pipeline as ordinary `handleSend`.
- Folder/file/image-only tasks preserve the current attachment validation and content mapping.

Represent selection as:

```ts
interface PendingAgentSelection {
  moduleId: string;
  title: string;
  profileId: string;
  icon: ModuleIconKey;
  customAgentId?: string;
  kickoffPrefix?: string;
}
```

**Step 2: Run and confirm failure**

```bash
npm test --workspace=packages/desktop -- src/renderer/components/Composer.test.tsx src/renderer/components/ChatView.test.tsx src/renderer/state/useOttoStore.test.ts
```

Expected: FAIL.

**Step 3: Extract one message-content and authorization preparation path**

The current `sendMessage` already converts text, image, folder, and file attachments into message content. Extract that conversion into a pure helper and reuse it for profile kickoff:

```ts
function buildUserMessageContent(
  text: string,
  attachments: Attachment[],
): OttoMessage['content'] {
  const content: OttoMessage['content'] = [];
  if (text.trim()) content.push({ type: 'text', value: text.trim() });
  // preserve existing image_reference/folder_reference/file_reference mapping
  return content;
}
```

Do not duplicate the enterprise-memory lookup currently performed by `App.handleSend`. Extract an App-level `prepareOutgoingTask(text, attachments)` helper (or an equivalent tested adapter) that returns both the existing content and `authorizedContext`. Ordinary sends and module-selected Agent sends must call the same helper. Preserve current attachment-only validation and error messages.

**Step 4: Correlate profile launches by the protocol’s existing `clientRequestId`**

The current server protocol already echoes `clientRequestId` in `session_created`. Replace the single guessed `profileLaunchRef` association with a map keyed by a generated request ID:

```ts
interface PendingProfileLaunch {
  clientRequestId: string;
  profileId: string;
  content: OttoMessage['content'];
  authorizedContext?: AuthorizedContext;
  source?: MessageSource;
}
```

Send the existing `create_session` frame with `clientRequestId`; when `session_created` arrives, consume only the matching pending launch and send one existing `send_user_message` frame to that returned session. No backend schema or frame type change is required. Clear matching entries on error, disconnect, sign-out, and account/server change. Add time-bounded cleanup so abandoned entries cannot affect future sessions.

Change only the front-end action signature:

```ts
launchAgentProfileWithPrompt(
  title: string,
  agentProfileId: string,
  prompt: string,
  source?: MessageSource,
  attachments?: Attachment[],
  authorizedContext?: AuthorizedContext,
): { accepted: boolean; clientRequestId?: string };
```

Reuse the extracted content builder and send the same existing `create_session` and `send_user_message` frame shapes. Do not alter the backend frame protocol.

**Step 5: Add App-level pending selection**

Keep this state in `App.tsx` because both RightPanel and Composer use it. On submit:

- Fixed Agent: send the user text/attachments unchanged through its profile.
- Custom expert: prepend `buildCustomAgentKickoff(...)`, then append `用户当前任务：` and the user text; keep attachments unchanged.
- No selected Agent: execute the existing `handleSend` through the same preparation helper.

Clear pending selection only after the launch action returns `accepted: true`, or on session change/removal/account switch. Keep the composer draft when the launch is rejected synchronously. Do not promise draft restoration for an asynchronous server failure unless an explicit retry/draft mechanism is implemented and tested.

**Step 6: Make only module-tile activations stage selection**

Add a distinct `onSelectAgentProfile` callback for module tiles. Do not silently rename or repurpose the existing `onLaunchAgentProfile` used by slash commands and current entries; keeping separate callbacks prevents an unrelated behavior change.

**Step 7: Run tests**

```bash
npm test --workspace=packages/desktop -- src/renderer/components/Composer.test.tsx src/renderer/components/ChatView.test.tsx src/renderer/state/useOttoStore.test.ts
npm run typecheck --workspace=packages/desktop
```

Expected: PASS.

**Step 8: Commit**

```bash
git add packages/desktop/src/renderer/App.tsx packages/desktop/src/renderer/components/ChatView.tsx packages/desktop/src/renderer/components/ChatView.test.tsx packages/desktop/src/renderer/components/Composer.tsx packages/desktop/src/renderer/components/Composer.test.tsx packages/desktop/src/renderer/state/useOttoStore.ts packages/desktop/src/renderer/state/useOttoStore.test.ts
git commit -m "feat(ui): stage agent modules in composer"
```

## Task 12: Add custom-expert modules and a dedicated manager dialog

**Files:**
- Create: `packages/desktop/src/renderer/components/CustomAgentManagerDialog.tsx`
- Create: `packages/desktop/src/renderer/components/CustomAgentManagerDialog.test.tsx`
- Modify: `packages/desktop/src/renderer/App.tsx`
- Modify: `packages/desktop/src/renderer/moduleCatalog.ts`
- Modify: `packages/desktop/src/renderer/moduleCatalog.test.ts`
- Modify: `packages/desktop/src/renderer/styles/app.css`

**Step 1: Write failing tests**

Cover create, validation, maximum 12, delete confirmation, dynamic catalog appearance/disappearance, icon assignment, and the distinction between layout removal and expert deletion.

**Step 2: Run and confirm failure**

```bash
npm test --workspace=packages/desktop -- src/renderer/components/CustomAgentManagerDialog.test.tsx src/renderer/moduleCatalog.test.ts
```

Expected: FAIL.

**Step 3: Extract existing create/manage UI into the dialog**

Reuse `customAgents.ts`, the existing scoped localStorage key, creation function, validation, and kickoff builder. Do not introduce a new backend model or rename existing profiles.

**Step 4: Connect marketplace “管理专家”**

New experts immediately become available in the “我的专家” category. Deleting an expert removes its module ID from the layout as a cleanup operation after confirmation.

**Step 5: Keep the old “我的专家” section until final cutover**

Verify the manager and dynamic catalog in isolation. Delete the old UI only in Task 14, never `customAgents.ts` or its persistence.

**Step 6: Verify and commit**

```bash
npm test --workspace=packages/desktop -- src/renderer/components/CustomAgentManagerDialog.test.tsx src/renderer/customAgents.test.ts src/renderer/moduleCatalog.test.ts
npm run typecheck --workspace=packages/desktop
git add packages/desktop/src/renderer/components/CustomAgentManagerDialog.tsx packages/desktop/src/renderer/components/CustomAgentManagerDialog.test.tsx packages/desktop/src/renderer/App.tsx packages/desktop/src/renderer/moduleCatalog.ts packages/desktop/src/renderer/moduleCatalog.test.ts packages/desktop/src/renderer/styles/app.css
git commit -m "refactor(ui): manage custom experts in dialog"
```

## Task 13: Surface server-backed Product Workspace contacts in Organization

**Files:**
- Modify: `packages/desktop/src/renderer/components/OrganizationPage.tsx`
- Create: `packages/desktop/src/renderer/components/OrganizationPage.test.tsx`
- Modify: `packages/desktop/src/renderer/App.tsx`
- Modify: `packages/desktop/src/renderer/styles/app.css`

**Step 1: Write characterization tests for existing Organization behavior**

Before adding contacts, cover organization tree, department/member selection, search, unread/online indicators, direct message opening, and park tenant overview. These guard against regressions while editing this large page.

**Step 2: Add failing contact tests**

Test a “常用联系人” section that:

- Lists the existing `ProductWorkspaceStore` friend entries supplied by current App state.
- Adds a name/note through the existing `add_friend` action and waits for the current server/store update path.
- Does not claim that entries are local-only, verified accounts, or chat-capable when the existing schema contains only the current name/note record.
- Does not duplicate the “打开组织架构” action.

Do not invent direct chat/edit/delete capabilities unless they already exist in current code.

**Step 3: Run and confirm failure**

```bash
npm test --workspace=packages/desktop -- src/renderer/components/OrganizationPage.test.tsx
```

Expected: FAIL for the new contacts section.

**Step 4: Move the unique friend UI into Organization**

Pass the existing friend data/actions from App to `OrganizationPage`. Preserve `add_friend`, Product Workspace synchronization, organization business logic, and all current data sources. This is a presentation relocation, not a persistence migration.

**Step 5: Keep the RightPanel drawer until final cutover**

Keep the old drawer reachable until Task 14 so a partially completed branch never loses the feature. Task 14 removes the duplicated enterprise summary/open-organization markup and friend markup only after the Organization integration tests pass.

**Step 6: Verify**

```bash
npm test --workspace=packages/desktop -- src/renderer/components/OrganizationPage.test.tsx src/renderer/components/RightPanel.test.tsx
npm run typecheck --workspace=packages/desktop
```

Expected: PASS.

**Step 7: Commit**

```bash
git add packages/desktop/src/renderer/components/OrganizationPage.tsx packages/desktop/src/renderer/components/OrganizationPage.test.tsx packages/desktop/src/renderer/App.tsx packages/desktop/src/renderer/styles/app.css
git commit -m "refactor(ui): move contacts into organization"
```

## Task 14: Perform the atomic RightPanel cutover and then remove obsolete UI

**Files:**
- Modify: `packages/desktop/src/renderer/components/RightPanel.tsx`
- Modify: `packages/desktop/src/renderer/components/RightPanel.test.tsx`
- Modify: `packages/desktop/src/renderer/App.tsx`
- Modify: `packages/desktop/src/renderer/rightPanelPreference.ts`
- Modify: `packages/desktop/src/renderer/rightPanelPreference.test.ts`
- Modify: `packages/desktop/src/renderer/styles/app.css`

**Step 1: Write regression tests for panel state**

Assert:

- Right panel defaults expanded for a user without a saved preference.
- The existing `PanelRight` button toggles it.
- Opening/closing settings, enterprise memory, auto-Skill, custom expert manager, park services, or marketplace does not mutate the preference.
- Reopening the App restores the saved preference.
- Module activation still works after collapse/expand.
- `presentation="panel"` renders the narrow module workspace; `presentation="page"` renders the responsive wide form with the same catalog and actions.
- Personal edition contains no enterprise/park leakage; enterprise edition obeys loaded feature/role/park authorization.
- Switching server/account/organization closes transient UI and loads the correct scoped layout.

**Step 2: Add cutover integration tests before changing production render paths**

For every old entry that will be removed, prove its replacement path while the old UI still exists:

1. Park module → correct deep-linked park surface.
2. Enterprise Memory → dialog with existing list/record/review/revision APIs.
3. Auto Skill → dialog with current actions.
4. Skill Zone → existing full-page route.
5. Fixed/custom Agent → composer chip; no session before send.
6. Custom expert create/manage → dynamic marketplace module.
7. Product Workspace contact → Organization section and existing `add_friend` path.

Do not begin deletion if any replacement path lacks a passing integration test.

**Step 3: Run the tests before cleanup**

```bash
npm test --workspace=packages/desktop -- src/renderer/rightPanelPreference.test.ts src/renderer/components/RightPanel.test.tsx
```

Expected: current preference tests pass; new dialog-preservation assertions may fail until wiring is corrected.

**Step 4: Switch both RightPanel presentations to ModuleWorkspace**

Instantiate `useModuleWorkspace` in App with normalized server URL, edition, organization, account, and capability inputs. Make `RightPanel` a thin adapter that receives the capability-derived catalog, scoped layout, presentation mode, and activation callbacks. Wire marketplace opening into the same App modal coordinator used by the migrated dialogs. Verify the production UI no longer exposes Expert/Enterprise Memory tabs before deleting any supporting markup.

**Step 5: Delete dead branches and props**

Remove:

- Expert/enterprise-memory tab state and markup.
- Old park service accordion entry.
- Old fixed Agent long list.
- Old auto-Skill long list.
- Old custom expert section.
- Old Skill Zone footer entry.
- Old enterprise/friend drawer.
- CSS selectors used only by those blocks.

Retain only the thin module-workspace boundary and required App callbacks. Remove the old friend drawer only because its server-backed functionality is now covered in Organization. Confirm with `rg` that removed labels are not still rendered by RightPanel; do not infer dead backend/preload code from UI removal.

**Step 6: Run focused tests and inspect diff**

```bash
npm test --workspace=packages/desktop -- src/renderer/rightPanelPreference.test.ts src/renderer/components/RightPanel.test.tsx
git diff --check
```

Expected: PASS and no whitespace errors.

**Step 7: Commit**

```bash
git add packages/desktop/src/renderer/components/RightPanel.tsx packages/desktop/src/renderer/components/RightPanel.test.tsx packages/desktop/src/renderer/App.tsx packages/desktop/src/renderer/rightPanelPreference.ts packages/desktop/src/renderer/rightPanelPreference.test.ts packages/desktop/src/renderer/styles/app.css
git commit -m "refactor(ui): remove obsolete right panel navigation"
```

## Task 15: Accessibility, integration, and regression gate

**Files:**
- Modify tests created in Tasks 4–13 as needed
- Modify: `packages/desktop/src/renderer/styles/app.css`
- Modify: `packages/desktop/src/renderer/App.tsx`

**Step 1: Add final integration tests**

Add one App-level integration path (using existing App test infrastructure if present; otherwise keep it at the nearest component boundary) for each activation kind:

1. Module → park deep-linked dialog → existing submit API.
2. Module → enterprise memory dialog → existing record/review API.
3. Module → auto-Skill dialog → existing action.
4. Module → Skill Zone route.
5. Module → Agent chip → send text/file/image → profile-bound session.
6. Custom expert → chip → existing custom kickoff.
7. Organization → server-backed Product Workspace contacts and existing `add_friend` action.
8. Personal/enterprise edition switch fixtures → no capability leakage.
9. `panel`/`page` presentations → same activation behavior at different widths.
10. Two concurrent Agent launch requests → exact `clientRequestId` correlation and no kickoff crossover.

Add accessibility assertions for focus trap/restore, Escape/outside dismissal, descriptive button names, keyboard reorder, visible focus, and reduced motion.

**Step 2: Run the complete desktop test suite**

```bash
npm test --workspace=packages/desktop
```

Expected: all tests pass; no snapshots or tests are deleted merely to make the suite green.

**Step 3: Run static and build gates**

```bash
npm run typecheck --workspace=packages/desktop
npm run lint --workspace=packages/desktop
npm run build:renderer --workspace=packages/desktop
git diff --check
```

Expected: all commands exit 0.

**Step 4: Audit backend-surface preservation against the frozen SHA**

Run:

```bash
git diff --name-only <MODULE_WORKSPACE_BASE_SHA>..HEAD
git diff <MODULE_WORKSPACE_BASE_SHA>..HEAD -- packages/desktop/src/main packages/desktop/src/preload packages/server native
```

Expected: no backend/preload/native changes for this feature. The literal SHA recorded in Task 1 must be used; do not recompute a merge-base against a branch that may have moved.

Search for accidental API renames:

```bash
rg -n "enterpriseKnowledge(List|Record|Review|Revise|Revisions)|enterpriseWorkLogRecent|create_session|send_user_message" packages/desktop/src/renderer
```

Expected: calls remain present in the extracted dialogs/store and retain their existing payload contracts.

**Step 5: Review for scope drift**

Confirm:

- No Organization module exists in the marketplace.
- No enterprise business data is written into module-layout localStorage.
- Layout keys include normalized server URL, edition, organization scope, and account scope.
- No Agent module creates a session before send.
- Agent kickoff content and authorized context are correlated by the existing `clientRequestId`, including concurrent launches and failure cleanup.
- Existing slash-command Agent behavior is unchanged.
- No custom expert is deleted when only its tile is removed.
- No unauthorized park/enterprise module becomes actionable.
- No cross-group drag implementation was added.
- Both `RightPanel` presentation modes still render and activate modules.
- No App package/version/release/signing files changed.

**Step 6: Commit the final test hardening**

Review `git status --short`, then stage only the explicit test and implementation files changed by this task. Do not use broad `git add packages/desktop/src/renderer`, which could capture unrelated user work.

```bash
git add <explicit-reviewed-files>
git diff --cached --stat
git diff --cached --check
git commit -m "test(ui): cover module workspace integration"
```

## Acceptance checklist for the user’s later local test

This is not executed as part of this planning turn. After automated gates pass, the user should be able to verify locally:

- Enterprise edition renders two default groups with six pre-added modules each; personal edition renders only its currently available personal capabilities.
- Groups and within-group modules reorder smoothly; siblings naturally make space.
- Two/three-row height and internal scrolling work with more than nine modules.
- Marketplace search, batch add, move, disabled reasons, and outside-click dismissal feel predictable.
- Edit mode is obvious without distracting continuous animation; remove/undo is safe.
- Park modules open the correct existing park content.
- Enterprise Memory and Auto Skill open independent dialogs, and their existing operations still work.
- Skill Zone still opens its full page.
- Fixed/custom Agent modules create only a chip; the conversation is created on send and includes attachments.
- Enterprise memory no longer occupies a right-panel tab.
- Organization remains a left page and now contains the existing server-backed Product Workspace contacts feature.
- Right-panel collapse state is unchanged when any dialog or Settings opens.

## Execution boundary

The implementation should stop and request product direction instead of guessing if any of these are discovered during execution:

- The current Product Workspace friend schema/API must change (for example verified identity, edit/delete, or direct-chat semantics); this plan only relocates the existing name/note behavior.
- Enterprise-memory or park deep linking requires a new IPC payload or backend endpoint.
- True in-place Agent switching inside the current server session is required; this plan deliberately uses a new profile-bound session on send because that matches the current protocol.
- Product requires cross-device layout synchronization or cross-group direct drag in v1.
- The nested 3-column reorder spike cannot meet pointer, scroll, accessibility, and reduced-motion requirements with the chosen library.
