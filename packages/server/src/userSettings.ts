/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 全局用户设置读写（server 端自包含副本，只读写 GUI 需要的子集字段）。
 *
 * 与 CLI 共享同一份文件 ~/.otto-user/settings.json
 * （packages/cli/src/config/settings.ts 的 USER_SETTINGS_PATH），但 server
 * 不能反向依赖 otto-cli（会牵入 Ink，破 TUI 回归门），因此这里只处理
 * GUI 面板需要的少数字段：healthyUse / preferredLanguage / mcpServers。
 * 读取时对文件里的其它字段（theme / vimMode / customModels 等）原样保留、
 * 写回时不覆盖，避免 GUI 保存设置时把 CLI 专属字段冲掉。
 *
 * agentStyle 不在本文件管理：它是项目级设置（<cwd>/.otto/settings.json），
 * 走 otto-core 的 ProjectSettingsManager（与 CLI /config agent-style 同源）。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MCPServerConfig, WebSearchProvider } from "otto-core";

const SETTINGS_DIR_NAME = ".otto-user";
const SETTINGS_FILE = "settings.json";

export function userSettingsFilePath(homeDir = os.homedir()): string {
  return path.join(homeDir, SETTINGS_DIR_NAME, SETTINGS_FILE);
}

/** 本文件关心的字段子集（其余字段读时原样保留在 raw 里，写回不丢）。 */
export interface UserSettingsSubset {
  healthyUse?: boolean;
  preferredLanguage?: string;
  mcpServers?: Record<string, MCPServerConfig>;
  /** 桌面端全局自动授权；仅放行非高危操作。 */
  authorizationMode?: "manual" | "auto";
  searchProvider?: WebSearchProvider;
  searchApiUrl?: string;
  searchModel?: string;
  /** 仅用于读取历史 CLI 明文配置；桌面端新保存的密钥不会写入这里。 */
  searchApiKey?: string;
}

/** 极简 JSON 注释剥离（与 customModels.ts 同一套宽容策略）。 */
function stripJsonCommentsLoose(input: string): string {
  let out = input.replace(/\/\*[\s\S]*?\*\//g, "");
  out = out
    .split("\n")
    .map((line) => (line.trimStart().startsWith("//") ? "" : line))
    .join("\n");
  return out;
}

function readRaw(homeDir = os.homedir()): Record<string, unknown> {
  const filePath = userSettingsFilePath(homeDir);
  try {
    if (!fs.existsSync(filePath)) return {};
    const text = fs.readFileSync(filePath, "utf-8");
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return JSON.parse(stripJsonCommentsLoose(text)) as Record<
        string,
        unknown
      >;
    }
  } catch {
    return {};
  }
}

/** 读取本文件关心的字段子集（缺省安全值：healthyUse 默认 true，与 CLI 一致）。 */
export function loadUserSettingsSubset(homeDir = os.homedir()): UserSettingsSubset {
  const raw = readRaw(homeDir);
  const searchProvider = raw["searchProvider"];
  return {
    healthyUse: typeof raw["healthyUse"] === "boolean" ? raw["healthyUse"] as boolean : true,
    preferredLanguage:
      typeof raw["preferredLanguage"] === "string"
        ? (raw["preferredLanguage"] as string)
        : undefined,
    mcpServers:
      raw["mcpServers"] && typeof raw["mcpServers"] === "object"
        ? (raw["mcpServers"] as Record<string, MCPServerConfig>)
        : undefined,
    authorizationMode: raw["authorizationMode"] === "auto" ? "auto" : "manual",
    searchProvider:
      searchProvider === "bing" ||
      searchProvider === "bocha" ||
      searchProvider === "gemini" ||
      searchProvider === "volcengine"
        ? searchProvider
        : undefined,
    searchApiUrl:
      typeof raw["searchApiUrl"] === "string"
        ? raw["searchApiUrl"] as string
        : undefined,
    searchModel:
      typeof raw["searchModel"] === "string"
        ? raw["searchModel"] as string
        : undefined,
    searchApiKey:
      typeof raw["searchApiKey"] === "string"
        ? raw["searchApiKey"] as string
        : undefined,
  };
}

/**
 * 合并写回一个字段（保留文件里其余字段不动）。原子写：.tmp -> rename。
 */
export function patchUserSettings(
  patch: Partial<UserSettingsSubset>,
  homeDir = os.homedir(),
): void {
  const filePath = userSettingsFilePath(homeDir);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const raw = readRaw(homeDir);
  const next = { ...raw, ...patch };
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
}

/** 读取 mcpServers 配置（便于单独调用，不必解构整个子集）。 */
export function loadMcpServers(): Record<string, MCPServerConfig> {
  return loadUserSettingsSubset().mcpServers ?? {};
}

/** 覆盖写回整份 mcpServers（add/remove 都先在内存改好再整体写回）。 */
export function saveMcpServers(
  servers: Record<string, MCPServerConfig>,
): void {
  patchUserSettings({ mcpServers: servers });
}
