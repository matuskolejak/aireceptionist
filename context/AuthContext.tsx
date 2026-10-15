import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Session } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { api } from '@/lib/api';
import { describeDevice } from '@/lib/device';
import { signInWithProvider as oauthSignIn, type OAuthProvider } from '@/lib/oauth';
import { unregisterPush } from '@/lib/push';
import { AUTH_STORAGE_KEY, AUTH_VERIFIER_KEY, secureStorage } from '@/lib/secure-storage';
import { bindAuthRefreshToAppState, supabase, supabaseConfigured } from '@/lib/supabase';

interface AuthValue {
  session: Session | null;
  /** The signed-in user's id, or null. Stable across token refreshes - key effects on this. */
  userId: string | null;
  /** True until the persisted session has been read off the keychain. */
  loading: boolean;
  email: string;
  name: string;
  initials: string;
  configured: boolean;
  /** Emails a 6-digit code. Resolves to an error message, or null on success. */
  sendCode: (email: string) => Promise<string | null>;
  /** Verifies the code and starts the session. Same return contract. */
  verifyCode: (email: string, code: string) => Promise<string | null>;
  /**
   * Google / Apple, the same two providers the web dialog offers. Resolves to
   * an error message, or null when it worked OR the user backed out.
   */
  signInWithProvider: (provider: OAuthProvider) => Promise<string | null>;
  /**
   * End the session on this phone. Never hangs and never leaves the session
   * behind, online or not. `afterDeletion` is for a just-deleted account: the
   * server already dropped the push rows, and this install's local traces of
   * that account (drafts, flags, purchase bookkeeping) go too.
   */
  signOut: (opts?: { afterDeletion?: boolean }) => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

// Mirrors lib/auth-user.ts on the web so the avatar in the app and the one in
// the dashboard show the same two letters for the same account.
function initialsFrom(name: string, email: string): string {
  const source = name.trim() || email;
  const words = source.split(/[\s@.]+/).filter(Boolean);
  const letters = words.length >= 2 ? words[0][0] + words[1][0] : source.slice(0, 2);
  return letters.toUpperCase();
}

/**
 * The longest sign-out waits on the server. Past it the session is dropped
 * locally: on a dead network auth-js has no timeout of its own and the button
 * would sit there for a minute.
 */
const SIGN_OUT_SERVER_MS = 3000;

/**
 * This install's traces of an account, cleared after that account is deleted.
 * Each key is owned elsewhere: the funnel draft (lib/onboarding-draft.ts),
 * push (lib/push.ts), Activity's unread mark, the AI-processing consent
 * (lib/ai-consent.ts) and the purchase bookkeeping (context/PurchaseContext.tsx).
 */
const ACCOUNT_LOCAL_KEYS = [
  'onboarding.draft',
  'push.muted',
  'push.primer',
  'activity.lastSeenAt',
  'ai.consent.v1',
  'iap.intent',
  'iap.reconcile.skip',
];
/** The last test-call number (Receptionist screen), kept in the keychain. */
const ACCOUNT_SECURE_KEYS = ['testcall.last'];

async function clearAccountLocalState(): Promise<void> {
  try {
    await AsyncStorage.multiRemove(ACCOUNT_LOCAL_KEYS);
  } catch {
    // Leftovers are cosmetic (a stale draft, a primer that stays dismissed).
  }
  for (const key of ACCOUNT_SECURE_KEYS) {
    await SecureStore.deleteItemAsync(key).catch(() => {});
  }
}

function delay(ms: number): Promise<'timeout'> {
  return new Promise((resolve) => setTimeout(() => resolve('timeout'), ms));
}

/**
 * GoTrue's messages in plain words. The known ones are matched loosely (the
 * wording has shifted between releases); anything else is shown as sent, which
 * is still better than a blank.
 */
export function friendlyAuthError(message: string): string {
  const m = message.toLowerCase();
  if (/expired|invalid|incorrect|not found/.test(m) && /token|otp|code/.test(m)) {
    return 'That code is wrong or has expired. Send a new one.';
  }
  if (/rate limit|too many|security purposes/.test(m)) {
    return 'Too many attempts. Wait a minute and try again.';
  }
  if (/signups? not allowed|disabled/.test(m)) {
    return 'Sign-ups are not open right now.';
  }
  if (/validate email|invalid format|valid email/.test(m)) {
    return 'Enter a valid email address.';
  }
  if (/error sending|magic link|smtp|email/.test(m) && /send|deliver/.test(m)) {
    return 'The email could not be sent. Try again in a moment.';
  }
  if (/network|fetch|connection/.test(m)) {
    return 'No connection. Check your network and try again.';
  }
  return message;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Dev-only fake session (EXPO_PUBLIC_MOCK=1): no Supabase, no keychain.
    // Inline so a release build drops the branch and the require with it.
    if (__DEV__ && process.env.EXPO_PUBLIC_MOCK === '1') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mock = require('@/lib/mock/session') as typeof import('@/lib/mock/session');
      setSession(mock.mockSession());
      setLoading(false);
      return;
    }

    if (!supabaseConfigured) {
      setLoading(false);
      return;
    }

    let active = true;
    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (active) setSession(data.session);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });
    const unbind = bindAuthRefreshToAppState();

    return () => {
      active = false;
      sub.subscription.unsubscribe();
      unbind();
    };
  }, []);

  /**
   * Tie this install to the account that just signed in.
   *
   * Fire and forget, and deliberately not awaited anywhere: the row exists so
   * the website can show "signed in on iPhone", and a phone that could not write
   * it still has a perfectly good session. Keyed on the user id rather than the
   * session object so a token refresh - which mints a new session every hour -
   * does not re-post it.
   */
  const userId = session?.user?.id ?? null;
  useEffect(() => {
    if (!userId) return;
    if (__DEV__ && process.env.EXPO_PUBLIC_MOCK === '1') return;
    void api.registerDevice(describeDevice()).catch(() => {
      // Nothing to show and nothing to retry: the next cold start tries again.
    });
  }, [userId]);

  const sendCode = useCallback(async (email: string): Promise<string | null> => {
    if (__DEV__ && process.env.EXPO_PUBLIC_MOCK === '1') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mock = require('@/lib/mock/session') as typeof import('@/lib/mock/session');
      const failed = await mock.mockSendCode(email);
      return failed ? friendlyAuthError(failed) : null;
    }
    if (!supabaseConfigured) return 'Sign-in is not configured yet.';
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      // The web dialog creates accounts on first sign-in, so the app must too -
      // otherwise a user who was invited but never opened the site is told
      // their email "does not exist" with no way forward.
      options: { shouldCreateUser: true },
    });
    return error ? friendlyAuthError(error.message) : null;
  }, []);

  const verifyCode = useCallback(
    async (rawEmail: string, rawCode: string): Promise<string | null> => {
      const email = rawEmail.trim();
      const code = rawCode.trim();

      if (__DEV__ && process.env.EXPO_PUBLIC_MOCK === '1') {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mock = require('@/lib/mock/session') as typeof import('@/lib/mock/session');
        const failed = await mock.mockVerifyCode(email, code);
        if (!failed) {
          setSession(mock.startMockSession(email));
          return null;
        }
        // Same fallback as below, against the mock review route.
        try {
          await api.reviewSignIn(email, code);
          setSession(mock.startMockSession(email));
          return null;
        } catch {
          return friendlyAuthError(failed);
        }
      }

      if (!supabaseConfigured) return 'Sign-in is not configured yet.';
      const { error } = await supabase.auth.verifyOtp({ email, token: code, type: 'email' });
      if (!error) return null;

      // App Review cannot receive our emails, so it signs in with a fixed code
      // the server checks (decision 5). Tried only after the real check failed,
      // and indistinguishable from it when it fails too: the user always sees
      // the ORIGINAL error, so the screen never reveals a second path exists.
      try {
        const tokens = await api.reviewSignIn(email, code);
        const { error: setError } = await supabase.auth.setSession(tokens);
        if (!setError) return null;
      } catch {
        // 404 (not the review account), 429, offline: all read as the original.
      }
      return friendlyAuthError(error.message);
    },
    [],
  );

  const signInWithProvider = useCallback(
    async (provider: OAuthProvider): Promise<string | null> => {
      if (__DEV__ && process.env.EXPO_PUBLIC_MOCK === '1') {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mock = require('@/lib/mock/session') as typeof import('@/lib/mock/session');
        setSession(mock.startMockSession());
        return null;
      }
      return oauthSignIn(provider);
    },
    [],
  );

  const signOut = useCallback(async (opts?: { afterDeletion?: boolean }) => {
    const afterDeletion = opts?.afterDeletion === true;

    // Before the session goes, not after: dropping the push token is an
    // authenticated call, and a handset left registered keeps buzzing with the
    // previous account's calls after somebody else signs in. Bounded (4s) inside
    // unregisterPush. Skipped after a deletion: the server already removed
    // every push row of the account, and the session may no longer verify.
    if (!afterDeletion) await unregisterPush();

    if (__DEV__ && process.env.EXPO_PUBLIC_MOCK === '1') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mock = require('@/lib/mock/session') as typeof import('@/lib/mock/session');
      mock.setMockSession(null);
    } else {
      // A deleted user's refresh token is already dead server-side: 'local'
      // only drops it here. The global sign-out revokes it everywhere.
      const result = await Promise.race([
        supabase.auth.signOut(afterDeletion ? { scope: 'local' } : undefined),
        delay(SIGN_OUT_SERVER_MS),
      ]);
      // auth-js returns early WITHOUT removing the stored session when it could
      // not load it (offline token refresh) - and the next cold start was signed
      // in again. Whatever went wrong, the session must not survive sign-out.
      if (result === 'timeout' || result.error) {
        await secureStorage.removeItem(AUTH_STORAGE_KEY).catch(() => {});
        await secureStorage.removeItem(AUTH_VERIFIER_KEY).catch(() => {});
      }
    }

    if (afterDeletion) await clearAccountLocalState();
    setSession(null);
  }, []);

  const value = useMemo<AuthValue>(() => {
    const email = session?.user?.email ?? '';
    const meta = (session?.user?.user_metadata ?? {}) as Record<string, unknown>;
    const name =
      (typeof meta.full_name === 'string' && meta.full_name) ||
      (typeof meta.name === 'string' && meta.name) ||
      email.split('@')[0] ||
      'Account';
    return {
      session,
      userId: session?.user?.id ?? null,
      loading,
      email,
      name,
      initials: initialsFrom(name, email),
      configured: supabaseConfigured || (__DEV__ && process.env.EXPO_PUBLIC_MOCK === '1'),
      sendCode,
      verifyCode,
      signInWithProvider,
      signOut,
    };
  }, [session, loading, sendCode, verifyCode, signInWithProvider, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>.');
  return ctx;
}
