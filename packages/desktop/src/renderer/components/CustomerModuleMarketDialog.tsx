import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CustomerModuleMarketVersion, InstalledCustomerModuleRecord } from '../../preload/index.js';
import { useModalDialog } from './useModalDialog.js';

export function CustomerModuleMarketDialog({
  open,
  installed,
  onInstalled,
  onInstalledChanged,
  onCreate,
  onClose,
}: {
  open: boolean;
  installed: readonly InstalledCustomerModuleRecord[];
  onInstalled(record: InstalledCustomerModuleRecord): void;
  onInstalledChanged(records: InstalledCustomerModuleRecord[]): void;
  onCreate(): void;
  onClose(): void;
}): React.JSX.Element | null {
  const [modules, setModules] = useState<CustomerModuleMarketVersion[]>([]);
  const [selected, setSelected] = useState<CustomerModuleMarketVersion | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setSelected(null); setStatus(null);
    void window.otto.customerModuleList()
      .then(setModules)
      .catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
  }, [open]);
  const modal = useModalDialog(open, onClose, !busy);
  if (!open) return null;
  return createPortal(
    <div className="otto-module-marketplace-overlay" onMouseDown={modal.onBackdropMouseDown}>
      <div ref={modal.dialogRef} className="otto-module-marketplace" role="dialog" aria-modal="true" aria-label="客户模块市场" onKeyDown={modal.onKeyDown}>
        <header className="otto-module-marketplace__header">
          <div><h2>客户模块市场</h2><p>公开审核通过的 WASM 模块</p></div>
          <button ref={modal.closeRef} type="button" aria-label="关闭客户模块市场" disabled={busy} onClick={onClose}>×</button>
        </header>
        <div className="otto-module-marketplace__catalog">
          {installed.length > 0 ? <section aria-label="已安装客户模块"><h3>已安装</h3>{installed.map((module) => <article key={module.id} className="otto-module-marketplace__module">
            <span className="otto-module-marketplace__module-copy"><strong>{module.name}</strong><small>{module.version} · {module.riskStatus ? `风险状态：${module.riskStatus}` : module.enabled ? '已启用' : '已禁用'}</small></span>
            <span>
              <button type="button" onClick={() => void window.otto.customerModuleSetEnabled(module.id, !module.enabled).then((record) => onInstalledChanged(installed.map((item) => item.id === record.id ? record : item))).catch((error) => setStatus(error instanceof Error ? error.message : String(error)))}>{module.enabled ? '禁用' : '启用'}</button>
              {module.permissions.some((permission) => permission.kind === 'background') ? <button type="button" onClick={() => {
                const next = !module.backgroundEnabled;
                if (next && !window.confirm(`开启 ${module.name} 的后台授权？后台任务仍须由 Otto 统一登记，可能产生的费用会单独记录。`)) return;
                void window.otto.customerModuleSetBackgroundEnabled(module.id, next).then((record) => onInstalledChanged(installed.map((item) => item.id === record.id ? record : item))).catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
              }}>{module.backgroundEnabled ? '关闭后台授权' : '开启后台授权'}</button> : null}
              <button type="button" onClick={() => {
                if (!window.confirm(`卸载 ${module.name}？模块数据会保留，可另行清除。`)) return;
                void window.otto.customerModuleUninstall(module.id).then(() => onInstalledChanged(installed.filter((item) => item.id !== module.id))).catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
              }}>卸载</button>
              <button type="button" onClick={() => void window.otto.customerModuleExportData(module.id).then((filePath) => setStatus(filePath ? `模块数据已导出：${filePath}` : '已取消导出')).catch((error) => setStatus(error instanceof Error ? error.message : String(error)))}>导出数据</button>
              <button type="button" onClick={() => {
                if (!window.confirm(`永久清除 ${module.name} 的作用域数据？此操作不可撤销。`)) return;
                void window.otto.customerModuleClearData(module.id).then(() => setStatus('模块作用域数据已清除')).catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
              }}>清除数据</button>
            </span>
          </article>)}</section> : null}
          {modules.map((module) => {
            const manifest = module.manifest;
            const alreadyInstalled = installed.some((item) => item.id === manifest.id && item.version === manifest.version);
            return <article key={`${manifest.id}@${manifest.version}`} className="otto-module-marketplace__module">
              <span className="otto-module-marketplace__module-copy">
                <strong>{manifest.name}</strong>
                <small>{manifest.id}@{manifest.version} · {module.publisherId} · 安装 {module.installCount}</small>
              </span>
              <button type="button" disabled={alreadyInstalled} onClick={() => setSelected(module)}>{alreadyInstalled ? '已安装' : '查看并安装'}</button>
            </article>;
          })}
          {modules.length === 0 && !status ? <p>暂无公开客户模块</p> : null}
          {selected ? <section aria-label="安装权限确认">
            <h3>安装 {selected.manifest.name}</h3>
            <p>版本：{selected.manifest.version}</p>
            <p>发布者：{selected.publisherId} · 审核状态：{selected.status} · 签名：{selected.manifest.signature ? '平台签名有效待本机校验' : '未签名'}</p>
            <p>变更说明：{typeof selected.manifest.releaseNotes === 'string' && selected.manifest.releaseNotes.trim() ? selected.manifest.releaseNotes : '发布者未提供'}</p>
            {(() => {
              const previous = installed.find((item) => item.id === selected.manifest.id);
              if (!previous) return null;
              const oldPermissions = new Set(previous.permissions.map((permission) => JSON.stringify(permission)));
              const added = selected.manifest.permissions.filter((permission) => !oldPermissions.has(JSON.stringify(permission)));
              return <p role={added.length > 0 ? 'alert' : undefined}>从 {previous.version} 升级；新增权限：{added.length === 0 ? '无' : added.map((permission) => JSON.stringify(permission)).join('；')}</p>;
            })()}
            <p>声明权限：{selected.manifest.permissions.length === 0 ? '无' : selected.manifest.permissions.map((permission) => JSON.stringify(permission)).join('；')}</p>
            <p>费用可能性：{selected.manifest.permissions.some((permission) => Boolean(permission) && typeof permission === 'object' && (permission as Record<string, unknown>).kind === 'model' && (permission as Record<string, unknown>).paid === true) ? '可能产生模型 Token 费用；运行后会显示供应商、Token 与估算成本' : '未声明付费模型调用'}</p>
            <p>安装和升级均需手动确认；后台能力保持关闭。</p>
            <button type="button" disabled={busy} onClick={() => {
              setBusy(true); setStatus(null);
              void window.otto.customerModuleInstall({
                moduleId: selected.manifest.id,
                version: selected.manifest.version,
                approvedPermissions: selected.manifest.permissions as Array<Record<string, unknown>>,
              }).then((record) => {
                onInstalled(record); setSelected(null); setStatus('模块已安装，可添加到功能组');
              }).catch((error) => setStatus(error instanceof Error ? error.message : String(error)))
                .finally(() => setBusy(false));
            }}>{busy ? '安装中…' : '确认权限并安装'}</button>
          </section> : null}
          {status ? <p role="status">{status}</p> : null}
        </div>
        <footer className="otto-module-marketplace__footer">
          <button type="button" className="otto-module-marketplace__manage" onClick={onCreate}>创建并投稿模块</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
