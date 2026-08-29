#!/usr/bin/env node
/** Prevent new unmanaged recurring work while the legacy inventory is migrated. */
const { execFileSync } = require('node:child_process');

const legacyMaximums = new Map(Object.entries({
  'packages/core/src/acp-client/acpAgentClient.ts': 2,
  'packages/core/src/core/proxyAuth.ts': 1,
  'packages/core/src/core/subAgent.ts': 1,
  'packages/core/src/lsp/binaryManager.ts': 1,
  'packages/core/src/orchestration/autoSkillGenerator.ts': 1,
  'packages/core/src/orchestration/enterpriseSync.ts': 1,
  'packages/core/src/orchestration/proactiveService.ts': 1,
  'packages/core/src/services/mcpResponseGuard.ts': 1,
  'packages/core/src/services/memoryPressureMonitor.ts': 1,
  'packages/core/src/services/taskWatchdog.ts': 1,
  'packages/core/src/tools/generate-document.ts': 1,
  'packages/core/src/tools/shell.ts': 1,
  'packages/desktop/src/main/index.ts': 5,
  'packages/desktop/src/main/server-manager.ts': 1,
  'packages/desktop/src/renderer/App.tsx': 4,
  'packages/desktop/src/renderer/components/AccountManagementPage.tsx': 1,
  'packages/desktop/src/renderer/components/Composer.tsx': 1,
  'packages/desktop/src/renderer/components/EnterpriseLoginPage.tsx': 2,
  'packages/desktop/src/renderer/components/FeishuStatusBadge.tsx': 1,
  'packages/desktop/src/renderer/components/InboxPage.tsx': 1,
  'packages/desktop/src/renderer/components/OrganizationPage.tsx': 1,
  'packages/desktop/src/renderer/components/OrganizationTree.tsx': 2,
  'packages/desktop/src/renderer/components/ParkServicesPlugin.tsx': 6,
  'packages/desktop/src/renderer/components/ProactiveToast.tsx': 1,
  'packages/desktop/src/renderer/components/hub/FeishuPanel.tsx': 1,
  'packages/server/src/enterprise/adminAccountsPage.ts': 1,
  'packages/server/src/enterprise/adminDashboardPage.ts': 1,
  'packages/server/src/enterprise/clusteredAttachmentMaintenance.ts': 1,
  'packages/server/src/enterprise/clusteredMlsMaintenance.ts': 1,
  'packages/server/src/enterprise/server.ts': 2,
  'packages/server/src/feishu/feishuAdapter.ts': 1,
  'packages/server/src/modules/commercial_control/privateDeploymentRuntime.ts': 1,
  'packages/server/src/modules/data_platform/keyRotationCoordinator.ts': 1,
  'packages/server/src/modules/federation_gateway/federationRuntime.ts': 1,
  'packages/server/src/server.ts': 1,
}));

const output = execFileSync('rg', [
  '-n', '(?:window\\.)?setInterval\\(', 'packages',
  '--glob', '!**/*.test.*', '--glob', '!**/dist/**', '--glob', '!**/*.js',
], { encoding: 'utf8' }).trim();
const counts = new Map();
for (const line of output ? output.split('\n') : []) {
  const file = line.slice(0, line.indexOf(':'));
  counts.set(file, (counts.get(file) ?? 0) + 1);
}
const violations = [];
for (const [file, count] of counts) {
  const maximum = legacyMaximums.get(file) ?? 0;
  if (count > maximum) violations.push(`${file}: ${count} direct timers (legacy maximum ${maximum})`);
}
if (violations.length) {
  console.error('New production setInterval usage is forbidden. Use RecurringTaskRegistry.');
  console.error(violations.join('\n'));
  process.exit(1);
}
console.log('Recurring task policy passed: no new unmanaged production intervals.');
