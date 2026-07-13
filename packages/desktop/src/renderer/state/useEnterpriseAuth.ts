/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EnterpriseAccount } from '../../preload/index.js';

type AuthStatus = 'loading' | 'signed-out' | 'signed-in';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useEnterpriseAuth(): {
  state: {
    status: AuthStatus;
    busy: boolean;
    serverUrl: string;
    account: EnterpriseAccount | null;
    error: string | null;
  };
  actions: {
    login(input: { serverUrl: string; username: string; password: string }): Promise<void>;
    logout(): Promise<void>;
    clearError(): void;
  };
} {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [busy, setBusy] = useState(false);
  const [serverUrl, setServerUrl] = useState('');
  const [account, setAccount] = useState<EnterpriseAccount | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.otto.enterpriseSession()
      .then((result) => {
        if (cancelled) return;
        setServerUrl(result.serverUrl);
        setAccount(result.account);
        setStatus(result.account ? 'signed-in' : 'signed-out');
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(messageOf(cause));
        setStatus('signed-out');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (input: {
    serverUrl: string;
    username: string;
    password: string;
  }): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.otto.enterpriseLogin(input);
      setServerUrl(result.serverUrl);
      setAccount(result.account);
      setStatus('signed-in');
    } catch (cause) {
      setError(messageOf(cause));
      setStatus('signed-out');
    } finally {
      setBusy(false);
    }
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await window.otto.enterpriseLogout();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setAccount(null);
      setStatus('signed-out');
      setBusy(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);
  return useMemo(() => ({
    state: { status, busy, serverUrl, account, error },
    actions: { login, logout, clearError },
  }), [status, busy, serverUrl, account, error, login, logout, clearError]);
}
