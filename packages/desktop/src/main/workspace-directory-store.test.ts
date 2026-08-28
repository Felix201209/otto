import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceDirectoryStore } from './workspace-directory-store.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('WorkspaceDirectoryStore', () => {
  it('默认包含用户主目录，并持久化用户明确选择过的最近目录', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-workspaces-'));
    roots.push(root);
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    const store = new WorkspaceDirectoryStore(path.join(root, 'state.json'), root);
    const canonicalRoot = fs.realpathSync(root);
    expect(store.list()).toEqual([canonicalRoot]);
    expect(store.grant(project)).toBe(fs.realpathSync(project));
    expect(new WorkspaceDirectoryStore(path.join(root, 'state.json'), root).list())
      .toEqual([fs.realpathSync(project), canonicalRoot]);
  });

  it('拒绝未由用户选择登记的目录', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-workspaces-'));
    roots.push(root);
    const untrusted = path.join(root, 'untrusted');
    fs.mkdirSync(untrusted);
    const store = new WorkspaceDirectoryStore(path.join(root, 'state.json'), root);
    expect(() => store.authorize(untrusted)).toThrow('未获得授权');
  });
});
