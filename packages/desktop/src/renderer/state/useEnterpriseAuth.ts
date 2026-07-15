/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  EnterpriseAccount,
  EnterpriseRegistrationIntent,
  EnterpriseSmsChallenge,
} from '../../preload/index.js';

type AuthStatus = 'loading' | 'signed-out' | 'signed-in';

export function friendlyAuthError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const withoutIpcPrefix = message.replace(/^Error invoking remote method '[^']+':\s*/, '');
  return withoutIpcPrefix.replace(/^Error:\s*/, '') || '操作失败，请稍后重试';
}

export function useEnterpriseAuth(): {
  state: {
    status: AuthStatus;
    busy: boolean;
    serverUrl: string;
    account: EnterpriseAccount | null;
    registrationIntent: EnterpriseRegistrationIntent | null;
    error: string | null;
  };
  actions: {
    loginWithPassword(input: { serverUrl: string; identifier: string; password: string }): Promise<void>;
    requestRegistrationCode(input: {
      serverUrl: string;
      phone: string;
      inviteCode: string;
    }): Promise<EnterpriseSmsChallenge>;
    register(input: { challengeId: string; code: string; name: string; password: string }): Promise<void>;
    logout(): Promise<void>;
    clearError(): void;
  };
} {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [busy, setBusy] = useState(false);
  const [serverUrl, setServerUrl] = useState('');
  const [account, setAccount] = useState<EnterpriseAccount | null>(null);
  const [registrationIntent, setRegistrationIntent] = useState<EnterpriseRegistrationIntent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signedInRef = useRef(false);
  const initializedRef = useRef(false);
  const pendingIntentRef = useRef<EnterpriseRegistrationIntent | null>(null);

  useEffect(() => {
    let cancelled = false;
    const applyIntent = (intent: EnterpriseRegistrationIntent): void => {
      if (signedInRef.current) return;
      if (!initializedRef.current) {
        pendingIntentRef.current = intent;
        return;
      }
      setRegistrationIntent(intent);
      setAccount(null);
      setError(null);
      setStatus('signed-out');
    };
    const unsubscribeIntent = window.otto.onEnterpriseRegistrationIntent(applyIntent);

    void Promise.all([
      window.otto.enterpriseSession(),
      window.otto.enterpriseRegistrationIntent(),
    ])
      .then(([session, coldIntent]) => {
        if (cancelled) return;
        initializedRef.current = true;
        setServerUrl(session.serverUrl);
        if (session.account) {
          signedInRef.current = true;
          pendingIntentRef.current = null;
          setRegistrationIntent(null);
          setAccount(session.account);
          setStatus('signed-in');
          return;
        }
        signedInRef.current = false;
        const intent = pendingIntentRef.current ?? coldIntent;
        pendingIntentRef.current = null;
        setRegistrationIntent(intent);
        setAccount(null);
        setStatus('signed-out');
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        initializedRef.current = true;
        signedInRef.current = false;
        setError(friendlyAuthError(cause));
        setStatus('signed-out');
      });
    return () => {
      cancelled = true;
      unsubscribeIntent();
    };
  }, []);

  const loginWithPassword = useCallback(async (input: {
    serverUrl: string;
    identifier: string;
    password: string;
  }): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.otto.enterprisePasswordLogin(input);
      setServerUrl(result.serverUrl);
      setAccount(result.account);
      setRegistrationIntent(null);
      signedInRef.current = true;
      setStatus('signed-in');
    } catch (cause) {
      signedInRef.current = false;
      setError(friendlyAuthError(cause));
      setStatus('signed-out');
    } finally {
      setBusy(false);
    }
  }, []);

  const requestRegistrationCode = useCallback(async (input: {
    serverUrl: string;
    phone: string;
    inviteCode: string;
  }): Promise<EnterpriseSmsChallenge> => {
    setError(null);
    try {
      const result = await window.otto.enterpriseRegistrationRequest(input);
      setServerUrl(result.serverUrl);
      return result;
    } catch (cause) {
      setError(friendlyAuthError(cause));
      throw cause;
    }
  }, []);

  const register = useCallback(async (input: {
    challengeId: string;
    code: string;
    name: string;
    password: string;
  }): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.otto.enterpriseRegister(input);
      setServerUrl(result.serverUrl);
      setAccount(result.account);
      setRegistrationIntent(null);
      signedInRef.current = true;
      setStatus('signed-in');
    } catch (cause) {
      signedInRef.current = false;
      setError(friendlyAuthError(cause));
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
      setError(friendlyAuthError(cause));
    } finally {
      signedInRef.current = false;
      setAccount(null);
      setStatus('signed-out');
      setBusy(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);
  return useMemo(() => ({
    state: { status, busy, serverUrl, account, registrationIntent, error },
    actions: { loginWithPassword, requestRegistrationCode, register, logout, clearError },
  }), [
    status, busy, serverUrl, account, registrationIntent, error,
    loginWithPassword, requestRegistrationCode, register, logout, clearError,
  ]);
}
