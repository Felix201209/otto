/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 * Tests for Otto RPA Recorder & Replay tools.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { RPARecorderTool } from './rpa-recorder.js';
import { RPAReplayTool } from './rpa-replay.js';
import type { RPARecipe } from './rpa-recorder.js';

const TEST_NAME = '__otto_test_rpa';
function rpaDir() { const d = path.join(os.homedir(), '.otto', 'rpa'); return d; }
function recipePath(name: string) { return path.join(rpaDir(), name.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json'); }

function cleanup() {
  try { fs.unlinkSync(recipePath(TEST_NAME)); } catch {}
  try { fs.unlinkSync(recipePath(TEST_NAME + '_shell')); } catch {}
  try { fs.unlinkSync(path.join(rpaDir(), '.lock')); } catch {}
}

const mockConfig = { getApprovalMode: () => 'yolo' } as any;

describe('RPA Recorder', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('start → step → stop lifecycle', async () => {
    const r = new RPARecorderTool(mockConfig);
    const s = await r.execute({action:'start',task_name:TEST_NAME,description:'Test',tags:'e2e'}, new AbortController().signal);
    expect(s.llmContent).toContain('开始录制');
    expect(s.llmContent).toContain('#e2e');

    const st1 = await r.execute({action:'step',task_name:TEST_NAME,step:{type:'shell',command:'echo hello'}}, new AbortController().signal);
    expect(st1.llmContent).toContain('shell');
    expect(st1.llmContent).toContain('echo hello');

    const st2 = await r.execute({action:'step',task_name:TEST_NAME,step:{type:'checkpoint',label:'mid'}}, new AbortController().signal);
    expect(st2.llmContent).toContain('checkpoint');

    const stop = await r.execute({action:'stop',task_name:TEST_NAME}, new AbortController().signal);
    expect(stop.llmContent).toContain('录制完成');
    expect(stop.llmContent).toContain('2 步');

    const loaded: RPARecipe = JSON.parse(fs.readFileSync(recipePath(TEST_NAME),'utf-8'));
    expect(loaded.steps.length).toBe(2);
    expect(loaded.replay_count).toBe(0);
    expect(loaded.tags).toEqual(['e2e']);
  });

  it('should list recipes', async () => {
    const r = new RPARecorderTool(mockConfig);
    await r.execute({action:'start',task_name:TEST_NAME,description:'T1'}, new AbortController().signal);
    await r.execute({action:'stop',task_name:TEST_NAME}, new AbortController().signal);
    const list = await r.execute({action:'list'}, new AbortController().signal);
    expect(list.llmContent).toContain(TEST_NAME);
  });

  it('should delete recipe', async () => {
    const r = new RPARecorderTool(mockConfig);
    await r.execute({action:'start',task_name:TEST_NAME}, new AbortController().signal);
    await r.execute({action:'stop',task_name:TEST_NAME}, new AbortController().signal);
    const del = await r.execute({action:'delete',task_name:TEST_NAME}, new AbortController().signal);
    expect(del.llmContent).toContain('已删除');
    expect(fs.existsSync(recipePath(TEST_NAME))).toBe(false);
  });

  it('should error on step without start', async () => {
    const r = new RPARecorderTool(mockConfig);
    const result = await r.execute({action:'step',task_name:TEST_NAME,step:{type:'shell',command:'echo'}}, new AbortController().signal);
    expect(result.llmContent).toContain('没有在录制');
  });

  it('should export as JSON and Markdown', async () => {
    const r = new RPARecorderTool(mockConfig);
    await r.execute({action:'start',task_name:TEST_NAME}, new AbortController().signal);
    await r.execute({action:'stop',task_name:TEST_NAME}, new AbortController().signal);
    const j = await r.execute({action:'export',task_name:TEST_NAME,export_format:'json'}, new AbortController().signal);
    expect(j.llmContent).toContain('"name"');
    const m = await r.execute({action:'export',task_name:TEST_NAME,export_format:'markdown'}, new AbortController().signal);
    expect(m.llmContent).toContain('# 🎬');
  });

  it('should validate missing task_name', async () => {
    const r = new RPARecorderTool(mockConfig);
    const result = await r.execute({action:'start'} as any, new AbortController().signal);
    expect(result.llmContent).toContain('FAIL');
  });
});

describe('RPA Replay', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  async function createRecipe(name: string, steps: any[]) {
    const recipe: RPARecipe = { name, version:1, created_at:Date.now(), replay_count:0, description:'Test', tags:['test'], steps, meta:{platform:os.platform(),osRelease:os.release()} };
    fs.mkdirSync(rpaDir(), {recursive:true});
    fs.writeFileSync(recipePath(name), JSON.stringify(recipe,null,2));
  }

  it('should dry-run', async () => {
    await createRecipe(TEST_NAME, [{type:'shell',command:'echo hello',ts:Date.now()},{type:'checkpoint',label:'mid',ts:Date.now()}]);
    const r = new RPAReplayTool(mockConfig);
    const result = await r.execute({task_name:TEST_NAME,mode:'dry_run'}, new AbortController().signal);
    expect(result.llmContent).toContain('echo hello');
    expect(result.llmContent).toContain('预览');
  });

  it('should execute shell + checkpoint', async () => {
    await createRecipe(TEST_NAME+'_shell', [{type:'shell',command:'echo "hello world"',ts:Date.now()},{type:'checkpoint',label:'done',ts:Date.now()}]);
    const r = new RPAReplayTool(mockConfig);
    const result = await r.execute({task_name:TEST_NAME+'_shell'}, new AbortController().signal);
    expect(result.llmContent).toContain('成功');
  });

  it('should handle missing recipe', async () => {
    const r = new RPAReplayTool(mockConfig);
    const result = await r.execute({task_name:'missing'}, new AbortController().signal);
    expect(result.llmContent).toContain('不存在');
  });

  it('should fail in strict mode on shell error', async () => {
    await createRecipe(TEST_NAME, [{type:'shell',command:'exit 1',ts:Date.now()},{type:'checkpoint',label:'nope',ts:Date.now()}]);
    const r = new RPAReplayTool(mockConfig);
    const result = await r.execute({task_name:TEST_NAME,mode:'strict'}, new AbortController().signal);
    expect(result.llmContent).toContain('中止');
    expect(result.llmContent).not.toContain('nope');
  });

  it('should skip errors in lenient mode', async () => {
    await createRecipe(TEST_NAME, [{type:'shell',command:'exit 1',ts:Date.now()},{type:'checkpoint',label:'survived',ts:Date.now()}]);
    const r = new RPAReplayTool(mockConfig);
    const result = await r.execute({task_name:TEST_NAME,mode:'lenient'}, new AbortController().signal);
    expect(result.llmContent).toContain('成功');
    expect(result.llmContent).toContain('失败');
  });

  it('should increment replay count', async () => {
    await createRecipe(TEST_NAME, [{type:'shell',command:'echo ok',ts:Date.now()}]);
    const r = new RPAReplayTool(mockConfig);
    await r.execute({task_name:TEST_NAME}, new AbortController().signal);
    const recipe: RPARecipe = JSON.parse(fs.readFileSync(recipePath(TEST_NAME),'utf-8'));
    expect(recipe.replay_count).toBe(1);
    expect(recipe.last_replayed_at).toBeDefined();
  });

  it('should interpolate variables', async () => {
    await createRecipe(TEST_NAME, [{type:'shell',command:'echo "{{today}} {{name}}"',ts:Date.now()}]);
    const r = new RPAReplayTool(mockConfig);
    const result = await r.execute({task_name:TEST_NAME,variables:{today:'2026-07-31',name:'sales'}}, new AbortController().signal);
    expect(result.llmContent).toContain('成功');
  });
});
