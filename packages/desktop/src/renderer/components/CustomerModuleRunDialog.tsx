import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModalDialog } from './useModalDialog.js';

export function CustomerModuleRunDialog({
  open,
  name,
  moduleId,
  version,
  inputSchema,
  permissions,
  onClose,
}: {
  open: boolean;
  name: string;
  moduleId: string;
  version: string;
  inputSchema: { properties: Record<string, unknown>; required?: string[] };
  permissions: Array<Record<string, unknown>>;
  onClose(): void;
}): React.JSX.Element | null {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [output, setOutput] = useState('');
  const [hostAudit, setHostAudit] = useState<Array<Record<string, unknown>>>([]);
  const [busy, setBusy] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [costApproved, setCostApproved] = useState(false);
  const requestClose = useCallback(() => {
    if (runId) void window.otto.customerModuleCancel(runId);
    onClose();
  }, [onClose, runId]);
  const modal = useModalDialog(open, requestClose);
  useEffect(() => { if (open) { setValues({}); setStatus(null); setOutput(''); setHostAudit([]); setCostApproved(false); } }, [open, moduleId, version]);
  if (!open) return null;
  const properties = Object.entries(inputSchema.properties);
  const mayUsePaidModel = permissions.some((permission) => permission.kind === 'model' && permission.paid === true);
  return createPortal(
    <div className="otto-module-marketplace-overlay" onMouseDown={modal.onBackdropMouseDown}>
      <div ref={modal.dialogRef} className="otto-module-marketplace" role="dialog" aria-modal="true" aria-label={`运行${name}`} onKeyDown={modal.onKeyDown}>
        <header className="otto-module-marketplace__header">
          <div><h2>{name}</h2><p>版本 {version}</p></div>
          <button ref={modal.closeRef} type="button" aria-label="关闭客户模块" onClick={requestClose}>×</button>
        </header>
        <div className="otto-module-marketplace__catalog">
          {properties.map(([key, raw]) => {
            const property = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
            const label = typeof property.title === 'string' ? property.title : key;
            if (property.type === 'boolean') return <label key={key}><input type="checkbox" checked={values[key] === true} onChange={(event) => setValues({ ...values, [key]: event.target.checked })} />{label}</label>;
            return <label key={key}>{label}<input aria-label={label} type={property.type === 'number' || property.type === 'integer' ? 'number' : 'text'} value={String(values[key] ?? '')} onChange={(event) => setValues({ ...values, [key]: property.type === 'number' || property.type === 'integer' ? Number(event.target.value) : event.target.value })} required={inputSchema.required?.includes(key)} /></label>;
          })}
          {properties.length === 0 ? <p>此模块不需要输入参数。</p> : null}
          {mayUsePaidModel ? <label><input type="checkbox" checked={costApproved} onChange={(event) => setCostApproved(event.target.checked)} />我确认本次前台运行可能产生模型 Token 费用（最多 4 次模型调用）</label> : null}
          <button type="button" className="otto-module-marketplace__confirm" disabled={busy} onClick={() => {
            const missing = (inputSchema.required ?? []).filter((key) => {
              const value = values[key];
              return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
            });
            if (missing.length > 0) { setStatus(`请填写必填项：${missing.join('、')}`); return; }
            if (mayUsePaidModel && !costApproved) { setStatus('请先确认本次运行可能产生模型 Token 费用'); return; }
            const nextRunId = crypto.randomUUID();
            setRunId(nextRunId); setBusy(true); setStatus('运行中…'); setOutput(''); setHostAudit([]);
            void window.otto.customerModuleRun({ runId: nextRunId, moduleId, version, formInput: values })
              .then((execution) => {
                setStatus(execution.result.status === 'completed' ? '运行完成' : execution.result.error ?? execution.result.status);
                setOutput(execution.result.output);
                setHostAudit(execution.hostAudit);
              })
              .catch((error) => setStatus(error instanceof Error ? error.message : String(error)))
              .finally(() => { setBusy(false); setRunId(null); });
          }}>{busy ? '运行中…' : '运行模块'}</button>
          {busy && runId ? <button type="button" onClick={() => void window.otto.customerModuleCancel(runId).then(() => setStatus('正在取消…'))}>取消运行</button> : null}
          {status ? <p role="status">{status}</p> : null}
          {output ? <pre aria-label="模块输出">{output}</pre> : null}
          {hostAudit.length > 0 ? <section aria-label="调用与费用来源"><h3>调用与费用来源</h3>{hostAudit.map((event, index) => <p key={index}>{String(event.capability ?? '调用')} · {String(event.provider ?? 'local')} · Token {String(Number(event.inputTokens ?? 0) + Number(event.outputTokens ?? 0))} · 重试 {String(event.retryCount ?? 0)} · {event.costEstimateAvailable === false ? '费用估算不可用' : `估算 $${String(event.estimatedCostUsd ?? 0)}`}</p>)}</section> : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
