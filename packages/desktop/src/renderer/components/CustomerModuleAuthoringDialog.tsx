import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  buildCustomerModuleSubmission,
  locallyValidateCustomerModuleWasm,
  type CustomerModuleAuthoringDraft,
} from '../customerModuleAuthoring.js';
import { useModalDialog } from './useModalDialog.js';

const STEPS = ['基本信息', '上传 WASM', '输入表单', '权限与费用', '本地测试', '提交审核'];

export function CustomerModuleAuthoringDialog({
  open,
  publisher,
  onSubmit,
  onClose,
}: {
  open: boolean;
  publisher: { id: string; name: string };
  onSubmit(input: { manifest: Record<string, unknown>; files: Record<string, string> }): Promise<void>;
  onClose(): void;
}): React.JSX.Element | null {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<CustomerModuleAuthoringDraft>({
    id: '', name: '', version: '1.0.0', description: '', releaseNotes: '', minimumOttoVersion: '1.15.3',
    permissions: [], inputSchema: { type: 'object', properties: {} },
  });
  const [wasm, setWasm] = useState<Uint8Array | null>(null);
  const [schemaText, setSchemaText] = useState('{\n  "type": "object",\n  "properties": {}\n}');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testTrace, setTestTrace] = useState<Array<Record<string, unknown>>>([]);
  const [testPassed, setTestPassed] = useState(false);
  const [httpHosts, setHttpHosts] = useState('');
  const [httpWrites, setHttpWrites] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStep(0); setStatus(null); setBusy(false); setWasm(null); setHttpHosts(''); setHttpWrites(false); setTestTrace([]); setTestPassed(false);
  }, [open]);
  const modal = useModalDialog(open, onClose, !busy);
  if (!open) return null;

  const advance = async (): Promise<void> => {
    try {
      setStatus(null);
      if (step === 0 && (!draft.id.trim() || !draft.name.trim() || !draft.description.trim())) {
        throw new Error('请完整填写模块 ID、名称和说明');
      }
      if (step === 1) {
        if (!wasm) throw new Error('请选择 WASM 文件');
        const imports = await locallyValidateCustomerModuleWasm(wasm);
        setStatus(`本地静态检查通过；Host 调用 ${imports.length} 项`);
      }
      if (step === 2) {
        const schema = JSON.parse(schemaText) as CustomerModuleAuthoringDraft['inputSchema'];
        if (schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object') {
          throw new Error('输入表单必须是 object JSON Schema');
        }
        setDraft((current) => ({ ...current, inputSchema: schema }));
        setTestPassed(false);
      }
      if (step === 3) {
        const http = draft.permissions.find((permission) => permission.kind === 'http');
        if (http && (!Array.isArray(http.hosts) || http.hosts.length === 0)) throw new Error('申请 HTTP 权限时必须填写至少一个明确域名');
      }
      if (step === 4 && !testPassed) throw new Error('提交前必须完成一次本地沙箱测试');
      setStep((current) => Math.min(STEPS.length - 1, current + 1));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const togglePermission = (kind: 'model' | 'http' | 'storage' | 'file' | 'background'): void => {
    setTestPassed(false);
    setDraft((current) => {
      const exists = current.permissions.some((permission) => permission.kind === kind);
      const permission = kind === 'model' ? { kind, paid: true }
        : kind === 'http' ? { kind, hosts: [], writes: false }
          : kind === 'storage' ? { kind, access: 'read-write' }
            : kind === 'file' ? { kind, access: 'user-selected-read' }
              : { kind, defaultEnabled: false };
      return {
        ...current,
        permissions: exists
          ? current.permissions.filter((item) => item.kind !== kind)
          : [...current.permissions, permission],
      };
    });
  };

  const updateHttpPermission = (hostsText: string, writes: boolean): void => {
    setTestPassed(false);
    setHttpHosts(hostsText); setHttpWrites(writes);
    const hosts = [...new Set(hostsText.split(/[\s,]+/u).map((host) => host.trim().toLowerCase()).filter(Boolean))];
    setDraft((current) => ({
      ...current,
      permissions: current.permissions.map((item) => item.kind === 'http' ? { kind: 'http', hosts, writes } : item),
    }));
  };

  return createPortal(
    <div className="otto-module-marketplace-overlay" onMouseDown={modal.onBackdropMouseDown}>
      <div ref={modal.dialogRef} className="otto-module-marketplace" role="dialog" aria-modal="true" aria-label="创建客户模块" onKeyDown={modal.onKeyDown}>
        <header className="otto-module-marketplace__header">
          <div><h2>创建客户模块</h2><p>步骤 {step + 1}/6 · {STEPS[step]}</p></div>
          <button ref={modal.closeRef} type="button" aria-label="关闭创建模块" disabled={busy} onClick={onClose}>×</button>
        </header>
        <div className="otto-module-marketplace__catalog">
          {step === 0 ? <div className="otto-settings-form">
            <label>稳定模块 ID<input aria-label="稳定模块 ID" value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value })} placeholder="com.company.module" /></label>
            <label>模块名称<input aria-label="模块名称" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
            <label>版本<input aria-label="版本" value={draft.version} onChange={(event) => setDraft({ ...draft, version: event.target.value })} placeholder="1.0.0" /></label>
            <label>模块说明<textarea aria-label="模块说明" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
            <label>本版本变更说明<textarea aria-label="本版本变更说明" value={draft.releaseNotes} onChange={(event) => setDraft({ ...draft, releaseNotes: event.target.value })} /></label>
          </div> : null}
          {step === 1 ? <label>WASM 文件<input aria-label="WASM 文件" type="file" accept=".wasm,application/wasm" onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void file.arrayBuffer().then((body) => { setWasm(new Uint8Array(body)); setTestPassed(false); });
          }} /></label> : null}
          {step === 2 ? <label>输入表单 JSON Schema<textarea aria-label="输入表单 JSON Schema" rows={12} value={schemaText} onChange={(event) => setSchemaText(event.target.value)} /></label> : null}
          {step === 3 ? <fieldset><legend>申请权限（安装时用户必须逐项确认）</legend>{(['model', 'http', 'storage', 'file', 'background'] as const).map((kind) => <label key={kind}><input type="checkbox" checked={draft.permissions.some((permission) => permission.kind === kind)} onChange={() => togglePermission(kind)} />{kind}{kind === 'model' ? '（可能产生费用）' : kind === 'background' ? '（默认关闭，安装后仍需用户单独开启）' : ''}</label>)}
            {draft.permissions.some((permission) => permission.kind === 'http') ? <div className="otto-settings-form">
              <label>允许的 HTTPS 域名<input aria-label="允许的 HTTPS 域名" value={httpHosts} placeholder="api.company.com, files.company.com" onChange={(event) => updateHttpPermission(event.target.value, httpWrites)} /></label>
              <label><input type="checkbox" checked={httpWrites} onChange={(event) => updateHttpPermission(httpHosts, event.target.checked)} />允许 POST/PUT/PATCH/DELETE 外部写操作（必须携带幂等键）</label>
            </div> : null}
            <p>后台授权默认关闭；即使声明，安装后也必须由用户另行开启，任务仍需通过 Otto 后台任务登记。</p>
          </fieldset> : null}
          {step === 4 ? <div><p>本地测试使用空白隔离数据；网络、模型、文件和正式存储调用会被拦截并记录。</p>
            <button type="button" disabled={busy || !wasm} onClick={() => {
              if (!wasm) return;
              setBusy(true); setStatus('沙箱测试中…'); setTestTrace([]); setTestPassed(false);
              void buildCustomerModuleSubmission({ draft, publisher, wasm }).then((submission) => window.otto.customerModuleTest(submission)).then((execution) => {
                setStatus(`退出状态：${execution.result.status} · 退出码 ${execution.result.exitCode ?? '无'}${execution.result.error ? ` · ${execution.result.error}` : ''}`);
                setTestTrace([...execution.audit, ...execution.hostAudit]);
                setTestPassed(execution.result.status === 'completed');
              }).catch((error) => setStatus(error instanceof Error ? error.message : String(error))).finally(() => setBusy(false));
            }}>{busy ? '测试中…' : '运行本地沙箱测试'}</button>
            <p role="status">{status ?? '尚未运行。测试数据不会进入正式账号。'}</p>
            {testTrace.length > 0 ? <pre aria-label="本地测试调用轨迹">{JSON.stringify(testTrace, null, 2)}</pre> : null}
          </div> : null}
          {step === 5 ? <div><p>发布者：{publisher.name}</p><p>{draft.id}@{draft.version}</p><p>权限：{draft.permissions.length === 0 ? '无' : draft.permissions.map((item) => String(item.kind)).join('、')}</p></div> : null}
          {status && step !== 4 ? <p role="alert">{status}</p> : null}
        </div>
        <footer className="otto-module-marketplace__footer">
          <button type="button" disabled={step === 0 || busy} onClick={() => setStep((current) => current - 1)}>上一步</button>
          {step < 5 ? <button type="button" className="otto-module-marketplace__confirm" onClick={() => void advance()}>下一步</button> : <button type="button" className="otto-module-marketplace__confirm" disabled={busy || !wasm} onClick={() => {
            if (!wasm) return;
            setBusy(true); setStatus(null);
            void buildCustomerModuleSubmission({ draft, publisher, wasm })
              .then(onSubmit)
              .then(() => { setStatus('已提交，等待平台人工审核'); })
              .catch((error) => setStatus(error instanceof Error ? error.message : String(error)))
              .finally(() => setBusy(false));
          }}>{busy ? '提交中…' : '提交审核'}</button>}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
