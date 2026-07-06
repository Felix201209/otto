import * as fs from 'fs/promises';
import * as path from 'path';
import type { CompanyRecord, LicenseRecord, OrgMemoryRecord, ProjectRecord, SkillRecord, TeamRecord, UsageRecord, UserProfileRecord } from './orgMemoryTypes.js';

export interface OrgMemoryStoreData {
  companies: CompanyRecord[];
  teams: TeamRecord[];
  users: UserProfileRecord[];
  projects: ProjectRecord[];
  memories: OrgMemoryRecord[];
  skills: SkillRecord[];
  usage: UsageRecord[];
  licenses: LicenseRecord[];
}

export const EMPTY_ORG_MEMORY_STORE: OrgMemoryStoreData = {
  companies: [],
  teams: [],
  users: [],
  projects: [],
  memories: [],
  skills: [],
  usage: [],
  licenses: [],
};

function cloneStore(data: OrgMemoryStoreData): OrgMemoryStoreData {
  return JSON.parse(JSON.stringify(data)) as OrgMemoryStoreData;
}

export class OrgMemoryStore {
  constructor(private readonly rootDir: string) {}

  private get storePath(): string {
    return path.join(this.rootDir, '.otto', 'org', 'memory-store.json');
  }

  async load() {
    try {
      const raw = await fs.readFile(this.storePath, 'utf-8');
      return { ...cloneStore(EMPTY_ORG_MEMORY_STORE), ...JSON.parse(raw) } as OrgMemoryStoreData;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return cloneStore(EMPTY_ORG_MEMORY_STORE);
      }
      throw error;
    }
  }

  async save(data: OrgMemoryStoreData) {
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    await fs.writeFile(this.storePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  }

  async upsertProject(project: ProjectRecord) {
    const data = await this.load();
    const index = data.projects.findIndex((item) => item.id === project.id);
    if (index !== -1) {
      data.projects[index] = project;
    } else {
      data.projects.push(project);
    }
    await this.save(data);
    return project;
  }

  async addMemory(memory: OrgMemoryRecord) {
    const data = await this.load();
    data.memories.push(memory);
    await this.save(data);
    return memory;
  }

  async listProjectMemories(projectId: string) {
    const data = await this.load();
    return data.memories.filter((memory) => memory.projectId === projectId);
  }

  async addUsage(record: UsageRecord) {
    const data = await this.load();
    data.usage.push(record);
    await this.save(data);
    return record;
  }

  async addSkill(skill: SkillRecord) {
    const data = await this.load();
    data.skills.push(skill);
    await this.save(data);
    return skill;
  }
}
