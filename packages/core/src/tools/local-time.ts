/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { Type } from '@google/genai';
import { BaseTool, Icon, ToolResult } from './tools.js';
import { Config } from '../config/config.js';
import { SchemaValidator } from '../utils/schemaValidator.js';

/**
 * Parameters for the LocalTimeTool.
 */
export interface LocalTimeParams {
  /**
   * Optional IANA timezone name (e.g. "Asia/Shanghai", "UTC").
   * If omitted, the system local timezone is used.
   */
  timezone?: string;
}

/**
 * A tool that returns the current wall-clock local time of the host machine.
 * Pure function with no external I/O. Used by /goal mode for elapsed checks
 * but generally useful for any time-stamping or duration calculation.
 */
export class LocalTimeTool extends BaseTool<LocalTimeParams, ToolResult> {
  static readonly Name: string = 'local_time';

  // Config is accepted for parity with other core tools, even though this
  // tool does not need any configuration at runtime.

  constructor(_config: Config) {
    super(
      LocalTimeTool.Name,
      'LocalTime',
      'Returns the current wall-clock local time of the machine running Otto. Use this tool to determine the current real-world time, record a start time at the beginning of a long task, calculate elapsed task duration by comparing two readings, or timestamp checkpoints, logs, or todo updates. The tool is fast, side-effect free, and never requires user confirmation, so you may call it as often as needed. Returned JSON fields: iso (ISO 8601 UTC timestamp), unix_ms (number), unix_s (number), timezone (IANA name), local (YYYY-MM-DD HH:MM:SS), weekday (English).',
      Icon.Info,
      {
        type: Type.OBJECT,
        properties: {
          timezone: {
            type: Type.STRING,
            description:
              'Optional IANA timezone name (e.g. "Asia/Shanghai", "UTC"). If omitted, uses the system local timezone.',
          },
        },
        required: [],
      },
    );
  }

  /**
   * Validates the parameters for the LocalTimeTool.
   */
  validateToolParams(params: LocalTimeParams): string | null {
    const errors = SchemaValidator.validate(
      this.schema.parameters,
      params,
      LocalTimeTool.Name,
    );
    if (errors) {
      return errors;
    }

    if (params.timezone !== undefined) {
      if (
        typeof params.timezone !== 'string' ||
        params.timezone.trim() === ''
      ) {
        return 'Parameter "timezone" must be a non-empty IANA timezone string.';
      }
    }
    return null;
  }

  getDescription(params: LocalTimeParams): string {
    return params.timezone
      ? `Get current time in timezone "${params.timezone}"`
      : 'Get current local time';
  }

  async execute(
    params: LocalTimeParams,
    _signal: AbortSignal,
  ): Promise<ToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        llmContent: `Error: Invalid parameters provided. Reason: ${validationError}`,
        returnDisplay: `Parameter validation failed: ${validationError}`,
      };
    }

    const now = new Date();
    const requestedTz = params.timezone?.trim();
    const systemTz =
      Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

    let tz: string;
    let local: string;
    let weekday: string;
    let warning: string | undefined;

    try {
      tz = requestedTz || systemTz;
      local = formatLocal(now, tz);
      weekday = new Intl.DateTimeFormat('en-US', {
        weekday: 'long',
        timeZone: tz,
      }).format(now);
    } catch (error) {
      // Invalid timezone - fall back to system local but report which one failed.
      tz = systemTz;
      local = formatLocal(now, tz);
      weekday = new Intl.DateTimeFormat('en-US', {
        weekday: 'long',
        timeZone: tz,
      }).format(now);
      const msg = error instanceof Error ? error.message : String(error);
      warning = `Invalid timezone "${requestedTz}" (${msg}); fell back to system timezone.`;
    }

    const data: Record<string, unknown> = {
      iso: now.toISOString(),
      unix_ms: now.getTime(),
      unix_s: Math.floor(now.getTime() / 1000),
      timezone: tz,
      local,
      weekday,
    };
    if (warning) {
      data.warning = warning;
    }

    const display = warning
      ? `Local time: ${local} (${tz}, ${weekday}) - ${warning}`
      : `Local time: ${local} (${tz}, ${weekday})`;

    return {
      llmContent: JSON.stringify(data),
      returnDisplay: display,
      summary: local,
    };
  }
}

/**
 * Formats a Date in the given IANA timezone as "YYYY-MM-DD HH:MM:SS".
 * Throws if `tz` is invalid.
 */
function formatLocal(date: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? '00';

  // Some runtimes return "24" instead of "00" for midnight hour; normalize.
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}:${get('second')}`;
}
