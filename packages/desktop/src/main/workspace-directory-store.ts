import fs from 'node:fs';
import path from 'node:path';

const MAX_RECENT_WORKSPACES = 12;

/**
 * 主进程持有的工作目录授权账本。renderer 只能使用用户主目录，或经原生目录
 * 选择器明确登记过的目录；账本落盘后，重启仍能安全恢复“最近使用”。
 */
export class WorkspaceDirectoryStore {
  private recent: string[];

  constructor(
    private readonly stateFile: string,
    private readonly homeDirectory: string,
  ) {
    this.recent = this.load();
  }

  defaultPath(): string {
    return this.canonicalDirectory(this.homeDirectory);
  }

  list(): string[] {
    const home = this.defaultPath();
    return [...new Set([...this.recent, home])].slice(0, MAX_RECENT_WORKSPACES);
  }

  grant(directory: string): string {
    const canonical = this.canonicalDirectory(directory);
    const home = this.defaultPath();
    this.recent = [canonical, ...this.recent.filter((item) => item !== canonical && item !== home)]
      .slice(0, MAX_RECENT_WORKSPACES - 1);
    this.persist();
    return canonical;
  }

  authorize(directory: string): string {
    const canonical = this.canonicalDirectory(directory);
    if (!this.list().includes(canonical)) {
      throw new Error('该工作目录未获得授权，请通过“添加工作目录”重新选择');
    }
    return canonical;
  }

  private canonicalDirectory(directory: string): string {
    if (!directory || !path.isAbsolute(directory)) throw new Error('工作目录必须是绝对路径');
    const canonical = fs.realpathSync(directory);
    if (!fs.statSync(canonical).isDirectory()) throw new Error('所选路径不是目录');
    return canonical;
  }

  private load(): string[] {
    try {
      const value = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as { recent?: unknown };
      if (!Array.isArray(value.recent)) return [];
      return value.recent
        .filter((item): item is string => typeof item === 'string' && path.isAbsolute(item))
        .filter((item) => {
          try { return this.canonicalDirectory(item) === item; } catch { return false; }
        })
        .slice(0, MAX_RECENT_WORKSPACES - 1);
    } catch {
      return [];
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, JSON.stringify({ recent: this.recent }, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.stateFile);
  }
}
