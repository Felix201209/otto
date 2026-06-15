/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SessionManager,
  type SessionData,
  type SessionMetadata,
} from '../services/sessionManager.js';

/** Info row exposed by {@link SessionSelector.listSessions}. */
export interface SessionInfo {
  id: string;
  startTime: string;
  title?: string;
  messageCount?: number;
}

/** Result returned by {@link SessionSelector.resolveSession}. */
export interface SessionSelectionResult {
  session: SessionInfo;
  data: SessionData;
}

/** Thrown when a session cannot be found or the identifier is malformed. */
export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionError';
  }

  static noSessionsFound(): SessionError {
    return new SessionError('No persisted sessions found.');
  }

  static invalidSessionIdentifier(
    identifier: string,
    searchedDir: string,
  ): SessionError {
    return new SessionError(
      `Session '${identifier}' was not found under ${searchedDir}.`,
    );
  }
}

/** Magic token recognised by {@link SessionSelector.resolveSession}. */
export const RESUME_LATEST = 'latest';

/**
 * Session discovery / selection façade used by the ACP layer.
 *
 * This is a thin wrapper around {@link SessionManager}. It implements only
 * the surface area that the ACP `loadSession` flow needs:
 *
 * - `listSessions()` — enumerate known sessions with minimal metadata.
 * - `findSession(id)` — look up by UUID, or 1-based numeric index.
 * - `resolveSession(arg)` — accept `"latest"` / UUID / index and return
 *   both the discovered row and its fully hydrated {@link SessionData}.
 */
export class SessionSelector {
  constructor(private readonly manager: SessionManager) {}

  /** True if a session with the given id exists on disk. */
  async sessionExists(id: string): Promise<boolean> {
    const sessions = await this.listAllMetadata();
    return sessions.some((m) => m.sessionId === id);
  }

  /** Minimal listing for UI / completion. */
  async listSessions(): Promise<SessionInfo[]> {
    const metadata = await this.listAllMetadata();
    return metadata
      .map((m) => ({
        id: m.sessionId,
        startTime: m.createdAt,
        title: m.title,
        messageCount: m.messageCount,
      }))
      // Oldest first so index numbers are stable as new sessions arrive.
      .sort(
        (a, b) =>
          new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
      );
  }

  async findSession(identifier: string): Promise<SessionInfo> {
    const trimmed = identifier.trim();
    const sorted = await this.listSessions();
    if (sorted.length === 0) throw SessionError.noSessionsFound();

    const byUuid = sorted.find((s) => s.id === trimmed);
    if (byUuid) return byUuid;

    const index = Number.parseInt(trimmed, 10);
    if (
      Number.isInteger(index) &&
      index.toString() === trimmed &&
      index > 0 &&
      index <= sorted.length
    ) {
      return sorted[index - 1];
    }
    throw SessionError.invalidSessionIdentifier(trimmed, 'sessions/');
  }

  async resolveSession(resumeArg: string): Promise<SessionSelectionResult> {
    const trimmed = resumeArg.trim();
    let selected: SessionInfo;

    if (trimmed === RESUME_LATEST) {
      const sessions = await this.listSessions();
      if (sessions.length === 0) throw SessionError.noSessionsFound();
      selected = sessions[sessions.length - 1];
    } else {
      selected = await this.findSession(trimmed);
    }

    const data = await this.manager.loadSession(selected.id);
    if (!data) {
      throw new SessionError(
        `Session '${selected.id}' exists in index but could not be loaded.`,
      );
    }
    return { session: selected, data };
  }

  /**
   * Bridge to {@link SessionManager} — we do not assume a specific listing
   * method name, so we read the public `listSessions` / `getSessionIndex`
   * surface via a duck-typed shim. Whichever exists is used.
   */
  private async listAllMetadata(): Promise<SessionMetadata[]> {
    const mgr = this.manager as unknown as {
      listSessions?: () => Promise<SessionMetadata[]>;
      getSessionIndex?: () => Promise<{ sessions: SessionMetadata[] }>;
    };
    if (typeof mgr.listSessions === 'function') {
      return await mgr.listSessions();
    }
    if (typeof mgr.getSessionIndex === 'function') {
      const idx = await mgr.getSessionIndex();
      return idx?.sessions ?? [];
    }
    return [];
  }
}
