/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { SandboxConfig } from 'otto-core';
import commandExists from 'command-exists';
import * as os from 'node:os';
import { getPackageJson } from '../utils/package.js';
import { Settings } from './settings.js';

// This is a stripped-down version of the CliArgs interface from config.ts
// to avoid circular dependencies.
interface SandboxCliArgs {
  sandbox?: boolean | string;
  sandboxImage?: string;
}

const VALID_SANDBOX_COMMANDS: ReadonlyArray<SandboxConfig['command']> = [
  'docker',
  'podman',
  'sandbox-exec',
];

function isSandboxCommand(value: string): value is SandboxConfig['command'] {
  return (VALID_SANDBOX_COMMANDS as readonly string[]).includes(value);
}

function getSandboxCommand(
  sandbox?: boolean | string,
): SandboxConfig['command'] | '' {
  // If the SANDBOX env var is set, we're already inside the sandbox.
  if (process.env.SANDBOX) {
    return '';
  }

  // note environment variable takes precedence over argument (from command line or settings)
  const environmentConfiguredSandbox =
    process.env.GEMINI_SANDBOX?.toLowerCase().trim() ?? '';
  sandbox =
    environmentConfiguredSandbox?.length > 0
      ? environmentConfiguredSandbox
      : sandbox;
  if (sandbox === '1' || sandbox === 'true') sandbox = true;
  else if (sandbox === '0' || sandbox === 'false' || !sandbox) sandbox = false;

  if (sandbox === false) {
    return '';
  }

  if (typeof sandbox === 'string' && sandbox) {
    if (!isSandboxCommand(sandbox)) {
      console.error(
        `ERROR: invalid sandbox command '${sandbox}'. Must be one of ${VALID_SANDBOX_COMMANDS.join(
          ', ',
        )}`,
      );
      process.exit(1);
    }
    // confirm that specified command exists
    if (commandExists.sync(sandbox)) {
      return sandbox;
    }
    console.error(
      `ERROR: missing sandbox command '${sandbox}' (from GEMINI_SANDBOX)`,
    );
    process.exit(1);
  }

  // look for seatbelt, docker, or podman, in that order
  // for container-based sandboxing, require sandbox to be enabled explicitly
  if (os.platform() === 'darwin' && commandExists.sync('sandbox-exec')) {
    return 'sandbox-exec';
  } else if (commandExists.sync('docker') && sandbox === true) {
    return 'docker';
  } else if (commandExists.sync('podman') && sandbox === true) {
    return 'podman';
  }

  // throw an error if user requested sandbox but no command was found
  if (sandbox === true) {
    console.error(
      'ERROR: GEMINI_SANDBOX is true but failed to determine command for sandbox; ' +
        'install docker or podman or specify command in GEMINI_SANDBOX',
    );
    process.exit(1);
  }

  return '';
}

export async function loadSandboxConfig(
  settings: Settings,
  argv: SandboxCliArgs,
): Promise<SandboxConfig | undefined> {
  const sandboxOption = argv.sandbox ?? settings.sandbox;
  const command = getSandboxCommand(sandboxOption);

  const packageJson = await getPackageJson();
  // 用户显式指定的镜像：命令行参数 > OTTO_SANDBOX_IMAGE > GEMINI_SANDBOX_IMAGE（上游兼容）
  const userConfiguredImage =
    argv.sandboxImage ??
    process.env.OTTO_SANDBOX_IMAGE ??
    process.env.GEMINI_SANDBOX_IMAGE;
  const image = userConfiguredImage ?? packageJson?.config?.sandboxImageUri;

  // 容器沙箱（docker/podman）会真正拉取并运行镜像；用户显式启用沙箱、
  // 却没指定自有镜像而回落到 package.json 里的上游默认镜像时给出提示。
  // macOS 的 sandbox-exec（seatbelt）不使用容器镜像，无需提示。
  if (command && command !== 'sandbox-exec' && image && !userConfiguredImage) {
    console.warn(
      '提示：当前沙箱镜像为上游第三方镜像（Otto 尚未自建），' +
        '建议通过 OTTO_SANDBOX_IMAGE 环境变量指定自有镜像。',
    );
  }

  return command && image ? { command, image } : undefined;
}
