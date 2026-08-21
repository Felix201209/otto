/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  EnterpriseAccount,
  EnterpriseLegalDocumentReference,
  EnterpriseRegistrationIntent,
  EnterpriseSmsChallenge,
  EnterpriseSmsLoginChallenge,
  EnterpriseServerPreparationResult,
} from '../../preload/index.js';

type AuthStatus = 'loading' | 'signed-out' | 'signed-in';

// main 与 renderer 属于独立 TypeScript rootDir，IPC 只传递 Error.message。
// 这里使用稳定的人类可读前缀识别“中心已提交”的升级失败，避免保留旧个人身份。
const ENTERPRISE_JOIN_REAUTH_REQUIRED_MESSAGE =
  '企业已成功加入，但本机身份同步失败，请重新登录以完成企业切换';

function isEnterpriseJoinReauthRequired(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(ENTERPRISE_JOIN_REAUTH_REQUIRED_MESSAGE);
}

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
    preparation: EnterpriseServerPreparationResult | null;
    error: string | null;
  };
  actions: {
    prepareServer(input: {
      serverUrl: string;
    }): Promise<EnterpriseServerPreparationResult>;
    loginWithPassword(input: { serverUrl: string; identifier: string; password: string }): Promise<void>;
    requestLoginCode(input: {
      serverUrl: string;
      phone: string;
    }): Promise<EnterpriseSmsLoginChallenge>;
    loginWithSms(input: { challengeId: string; code: string }): Promise<void>;
    requestRegistrationCode(input: {
      serverUrl: string;
      phone: string;
      inviteCode?: string;
    }): Promise<EnterpriseSmsChallenge>;
    register(input: {
      challengeId: string;
      code: string;
      name: string;
      password: string;
      legalConsent: true;
      legalDocuments: EnterpriseLegalDocumentReference[];
    }): Promise<void>;
    joinEnterprise(input: { inviteCode: string }): Promise<void>;
    logout(): Promise<void>;
    clearError(): void;
  };
} {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [preparation, setPreparation] =
    useState<EnterpriseServerPreparationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [serverUrl, setServerUrl] = useState('');
  const [account, setAccount] = useState<EnterpriseAccount | null>(null);
  const [registrationIntent, setRegistrationIntent] = useState<EnterpriseRegistrationIntent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signedInRef = useRef(false);
  const initializedRef = useRef(false);
  const pendingIntentRef = useRef<EnterpriseRegistrationIntent | null>(null);
  const authEpochRef = useRef(0);
  const registrationRequestEpochRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const initialEpoch = authEpochRef.current + 1;
    authEpochRef.current = initialEpoch;
    const applyRegistrationIntent = (
      intent: EnterpriseRegistrationIntent | null,
    ): void => {
      // Main 进程已把链接中的 server 规范化到安全 origin；先切服务器，
      // 再暴露邀请码，避免运行中的注册链接继续请求旧企业服务器。
      if (intent?.serverUrl) setServerUrl(intent.serverUrl);
      setRegistrationIntent(intent);
      setPreparation(null);
    };
    const applyIntent = (intent: EnterpriseRegistrationIntent): void => {
      if (signedInRef.current) return;
      if (!initializedRef.current) {
        pendingIntentRef.current = intent;
        return;
      }
      authEpochRef.current += 1;
      registrationRequestEpochRef.current += 1;
      applyRegistrationIntent(intent);
      setAccount(null);
      setError(null);
      setBusy(false);
      setStatus('signed-out');
    };
    const unsubscribeIntent = window.otto.onEnterpriseRegistrationIntent(applyIntent);
    const unsubscribeInvalidated = window.otto.onEnterpriseSessionInvalidated(() => {
      authEpochRef.current += 1;
      registrationRequestEpochRef.current += 1;
      initializedRef.current = true;
      signedInRef.current = false;
      setAccount(null);
      setError('登录已失效，请重新登录');
      setBusy(false);
      setStatus('signed-out');
    });
    const unsubscribeAccountUpdated = window.otto.onEnterpriseAccountUpdated((updatedAccount) => {
      if (!initializedRef.current || !signedInRef.current) return;
      setAccount((current) => {
        if (!current
          || current.id !== updatedAccount.id
          || current.organizationId !== updatedAccount.organizationId) {
          return current;
        }
        const currentUpdatedAt = Date.parse(current.updatedAt);
        const nextUpdatedAt = Date.parse(updatedAccount.updatedAt);
        if (Number.isFinite(currentUpdatedAt)
          && Number.isFinite(nextUpdatedAt)
          && nextUpdatedAt < currentUpdatedAt) {
          return current;
        }
        return updatedAccount;
      });
    });

    void Promise.all([
      window.otto.enterpriseSession(),
      window.otto.enterpriseRegistrationIntent(),
    ])
      .then(([session, coldIntent]) => {
        if (cancelled || initialEpoch !== authEpochRef.current) return;
        initializedRef.current = true;
        setServerUrl(session.serverUrl);
        setError(session.connectionError ?? null);
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
        applyRegistrationIntent(intent);
        setAccount(null);
        setStatus('signed-out');
      })
      .catch((cause: unknown) => {
        if (cancelled || initialEpoch !== authEpochRef.current) return;
        initializedRef.current = true;
        signedInRef.current = false;
        setError(friendlyAuthError(cause));
        setStatus('signed-out');
      });
    return () => {
      cancelled = true;
      unsubscribeIntent();
      unsubscribeInvalidated();
      unsubscribeAccountUpdated();
    };
  }, []);

  const prepareServer = useCallback(async (input: {
    serverUrl: string;
  }): Promise<EnterpriseServerPreparationResult> => {
    const epoch = authEpochRef.current + 1;
    authEpochRef.current = epoch;
    registrationRequestEpochRef.current += 1;
    setBusy(true);
    setError(null);
    setPreparation(null);
    try {
      const result = await window.otto.enterprisePrepareServer(input);
      if (epoch !== authEpochRef.current) return result;
      setServerUrl(result.serverUrl);
      setPreparation(result);
      setAccount(null);
      signedInRef.current = false;
      setStatus('signed-out');
      return result;
    } catch (cause) {
      if (epoch === authEpochRef.current) {
        setError(friendlyAuthError(cause));
        setStatus('signed-out');
      }
      throw cause;
    } finally {
      if (epoch === authEpochRef.current) setBusy(false);
    }
  }, []);

  const loginWithPassword = useCallback(async (input: {
    serverUrl: string;
    identifier: string;
    password: string;
  }): Promise<void> => {
    const epoch = authEpochRef.current + 1;
    authEpochRef.current = epoch;
    registrationRequestEpochRef.current += 1;
    setBusy(true);
    setError(null);
    try {
      const result = await window.otto.enterprisePasswordLogin(input);
      if (epoch !== authEpochRef.current) return;
      setServerUrl(result.serverUrl);
      setAccount(result.account);
      setRegistrationIntent(null);
      signedInRef.current = true;
      setStatus('signed-in');
    } catch (cause) {
      if (epoch !== authEpochRef.current) return;
      signedInRef.current = false;
      setError(friendlyAuthError(cause));
      setStatus('signed-out');
    } finally {
      if (epoch === authEpochRef.current) setBusy(false);
    }
  }, []);

  const requestRegistrationCode = useCallback(async (input: {
    serverUrl: string;
    phone: string;
    inviteCode?: string;
  }): Promise<EnterpriseSmsChallenge> => {
    const epoch = registrationRequestEpochRef.current + 1;
    registrationRequestEpochRef.current = epoch;
    setError(null);
    try {
      const result = await window.otto.enterpriseRegistrationRequest(input);
      if (epoch === registrationRequestEpochRef.current) setServerUrl(result.serverUrl);
      return result;
    } catch (cause) {
      if (epoch === registrationRequestEpochRef.current) setError(friendlyAuthError(cause));
      throw cause;
    }
  }, []);

  const requestLoginCode = useCallback(async (input: {
    serverUrl: string;
    phone: string;
  }): Promise<EnterpriseSmsLoginChallenge> => {
    const epoch = registrationRequestEpochRef.current + 1;
    registrationRequestEpochRef.current = epoch;
    setError(null);
    try {
      const result = await window.otto.enterpriseSmsLoginRequest(input);
      if (epoch === registrationRequestEpochRef.current) setServerUrl(result.serverUrl);
      return result;
    } catch (cause) {
      if (epoch === registrationRequestEpochRef.current) setError(friendlyAuthError(cause));
      throw cause;
    }
  }, []);

  const loginWithSms = useCallback(async (input: {
    challengeId: string;
    code: string;
  }): Promise<void> => {
    const epoch = authEpochRef.current + 1;
    authEpochRef.current = epoch;
    registrationRequestEpochRef.current += 1;
    setBusy(true);
    setError(null);
    try {
      const result = await window.otto.enterpriseSmsLoginVerify(input);
      if (epoch !== authEpochRef.current) return;
      setServerUrl(result.serverUrl);
      setAccount(result.account);
      setRegistrationIntent(null);
      signedInRef.current = true;
      setStatus('signed-in');
    } catch (cause) {
      if (epoch !== authEpochRef.current) return;
      signedInRef.current = false;
      setError(friendlyAuthError(cause));
      setStatus('signed-out');
    } finally {
      if (epoch === authEpochRef.current) setBusy(false);
    }
  }, []);

  const register = useCallback(async (input: {
    challengeId: string;
    code: string;
    name: string;
    password: string;
    legalConsent: true;
    legalDocuments: EnterpriseLegalDocumentReference[];
  }): Promise<void> => {
    const epoch = authEpochRef.current + 1;
    authEpochRef.current = epoch;
    registrationRequestEpochRef.current += 1;
    setBusy(true);
    setError(null);
    try {
      const result = await window.otto.enterpriseRegister(input);
      if (epoch !== authEpochRef.current) return;
      setServerUrl(result.serverUrl);
      setAccount(result.account);
      setRegistrationIntent(null);
      signedInRef.current = true;
      setStatus('signed-in');
    } catch (cause) {
      if (epoch !== authEpochRef.current) return;
      signedInRef.current = false;
      setError(friendlyAuthError(cause));
      setStatus('signed-out');
    } finally {
      if (epoch === authEpochRef.current) setBusy(false);
    }
  }, []);

  const joinEnterprise = useCallback(async (input: {
    inviteCode: string;
  }): Promise<void> => {
    const epoch = authEpochRef.current + 1;
    authEpochRef.current = epoch;
    registrationRequestEpochRef.current += 1;
    setBusy(true);
    setError(null);
    try {
      const result = await window.otto.enterpriseJoinOrganization(input);
      if (epoch !== authEpochRef.current) return;
      setServerUrl(result.serverUrl);
      setAccount(result.account);
      setRegistrationIntent(null);
      signedInRef.current = true;
      setStatus('signed-in');
    } catch (cause) {
      if (epoch === authEpochRef.current) {
        setError(friendlyAuthError(cause));
        if (isEnterpriseJoinReauthRequired(cause)) {
          signedInRef.current = false;
          setAccount(null);
          setStatus('signed-out');
        } else {
          setStatus('signed-in');
        }
      }
      throw cause;
    } finally {
      if (epoch === authEpochRef.current) setBusy(false);
    }
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    const epoch = authEpochRef.current + 1;
    authEpochRef.current = epoch;
    registrationRequestEpochRef.current += 1;
    setBusy(true);
    setError(null);
    try {
      await window.otto.enterpriseLogout();
    } catch (cause) {
      if (epoch === authEpochRef.current) setError(friendlyAuthError(cause));
    } finally {
      if (epoch === authEpochRef.current) {
        signedInRef.current = false;
        setAccount(null);
        setStatus('signed-out');
        setBusy(false);
      }
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);
  return useMemo(() => ({
    state: {
      status,
      busy,
      serverUrl,
      account,
      registrationIntent,
      preparation,
      error,
    },
    actions: {
      loginWithPassword,
      requestLoginCode,
      prepareServer,
      loginWithSms,
      requestRegistrationCode,
      register,
      joinEnterprise,
      logout,
      clearError,
    },
  }), [
    status, busy, serverUrl, account, registrationIntent, error,
    loginWithPassword, requestLoginCode, loginWithSms,
    requestRegistrationCode, register, joinEnterprise, logout, clearError,
    preparation, prepareServer,
  ]);
}
