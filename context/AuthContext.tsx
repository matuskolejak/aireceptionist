import AsyncStorage from '@react-native-async-storage/async-storage';
import { isAuthRetryableFetchError, type Session } from '@supabase/supabase-js';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { api } from '@/lib/api';
import { friendlyAuthError } from '@/lib/auth-errors';
import { describeDevice } from '@/lib/device';
import { signInWithProvider as oauthSignIn, type OAuthProvider } from '@/lib/oauth';
import { unregisterPush } from '@/lib/push';
import { AUTH_STORAGE_KEY, AUTH_VERIFIER_KEY, secureStorage } from '@/lib/secure-storage';
import { markSessionEnded } from '@/lib/session-ended';
import { bindAuthRefreshToAppState, supabase, supabaseConfigured } from '@/lib/supabase';

interface AuthValue {
  session: Session | null;
  /** The signed-in user's id, or null. Stable across token refreshes - key effects on this. */
  userId: string | null;
  /** True until the persisted session has been read off the keychain. */
  loading: boolean;
  email: string;
  name: string;
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
   * behind, online or not. The account's AI consent, funnel draft, unread mark
   * and last test number go first, so the next account here starts clean.
   * `afterDeletion` is for a just-deleted account: the server already dropped
   * the push rows, and the rest of this install's local traces of that account
   * (push flags, purchase bookkeeping) go too.
   */
  signOut: (opts?: { afterDeletion?: boolean }) => Promise<void>;
  /**
   * End every other session of this account - the other phones and the
   * website - and keep this one, then forget those installs on the server.
   * Returns an error message, or null when it worked. Never hangs.
   */
  signOutOthers: () => Promise<string | null>;
}

const AuthContext = createContext<AuthValue | null>(null);

// Mirrors lib/auth-user.ts on the web so the avatar in the app and the one in
// the dashboard show the same two letters for the same account. Array.from
// splits by code point, so an emoji is not cut in half.
export function initialsFrom(name: string, email: string): string {
  const source = name.trim() || email;
  const words = source.split(/[\s@.]+/).filter(Boolean);
  const letters =
    words.length >= 2
      ? Array.from(words[0])[0] + Array.from(words[1])[0]
      : Array.from(source).slice(0, 2).join('');
  return letters.toUpperCase();
}

/**
 * The longest sign-out waits on the server. Past it the session is dropped
 * locally: on a dead network auth-js has no timeout of its own and the button
 * would sit there for a minute.
 */
const SIGN_OUT_SERVER_MS = 3000;

/**
 * How long "Sign out everywhere else" waits on the server: the API request
 * bound (TIMEOUT_MS in lib/api.ts). Unlike sign-out there is no local fallback,
 * so a slow network gets the full time before the screen shows an error.
 */
const SIGN_OUT_OTHERS_MS = 20_000;

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
/**
 * The keys every sign-out clears, with the secure ones above. The next account
 * on this phone must not take the consent as its own or get the draft replayed
 * onto it. The push and purchase keys stay: lib/push.ts and
 * context/PurchaseContext.tsx own them, and the purchase keys carry a user id.
 */
const SIGN_OUT_LOCAL_KEYS = ['onboarding.draft', 'activity.lastSeenAt', 'ai.consent.v1'];

async function clearAccountLocalState(localKeys: string[]): Promise<void> {
  try {
    await AsyncStorage.multiRemove(localKeys);
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
 * The session auth-js keeps in storage, read without auth-js. Only for an
 * offline cold start (see AuthProvider). Null unless it parses and has a user
 * id and a refresh token.
 */
async function readStoredSession(): Promise<Session | null> {
  try {
    const raw = await secureStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as Partial<Session> | null;
    return stored?.user?.id && stored.refresh_token ? (stored as Session) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  // Set by signOut() so the auth listener can tell a deliberate sign-out from
  // a session auth-js ended itself. Cleared only by SIGNED_IN: signOut() awaits
  // unregisterPush() first, and a TOKEN_REFRESHED in that wait must not clear it.
  const userSignOut = useRef(false);

  useEffect(() => {
    // Dev-only fake session (EXPO_PUBLIC_MOCK=1): no Supabase, no keychain.
    // Inline so a release build drops the branch and the require with it.
    if (__DEV__ && process.env.EXPO_PUBLIC_MOCK === '1') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mock = require('@/lib/mock/session') as typeof import('@/lib/mock/session');
      // eslint-disable-next-line react-hooks/set-state-in-effect -- dev-only mock session (EXPO_PUBLIC_MOCK=1); release builds drop this branch.
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
      .then(async ({ data, error }) => {
        // Offline cold start with an expired access token: the refresh could
        // not reach the server, so auth-js answers "no session" but keeps the
        // stored one. That is a connection problem, not a sign-out. Keep the
        // user signed in on the stored session: the app reads only its user,
        // API calls take their token from getSession() (lib/api.ts), and the
        // auto-refresh replaces it (TOKEN_REFRESHED) or ends it (SIGNED_OUT)
        // once the network is back. Awaited, so `loading` stays true until it
        // is in state and the Stack does not mount on the funnel first.
        // `prev ??` keeps a TOKEN_REFRESHED that arrived earlier.
        if (!data.session && error && isAuthRetryableFetchError(error)) {
          const stored = await readStoredSession();
          if (active) setSession((prev) => prev ?? stored);
          return;
        }
        if (active) setSession(data.session);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      // getSession() above gives the first answer. INITIAL_SESSION repeats it,
      // and after an offline refresh failure it is null, which would undo the
      // stored session restored there.
      if (event === 'INITIAL_SESSION') return;
      // A SIGNED_OUT that signOut() did not start: the refresh was refused
      // (signed out elsewhere, or a reused token). Note it, so the root layout
      // opens sign-in and sign-in says the session ended.
      if (event === 'SIGNED_IN') {
        userSignOut.current = false;
      } else if (event === 'SIGNED_OUT' && !userSignOut.current) {
        markSessionEnded();
        // signOut() did not run, so unregisterPush never dropped the token, and
        // its DELETE can no longer authenticate. Stop push at the OS instead.
        // The next sign-in registers again (registerIfGranted in app/_layout.tsx).
        void Notifications.unregisterForNotificationsAsync().catch(() => {});
      }
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
    userSignOut.current = true;
    const afterDeletion = opts?.afterDeletion === true;

    // Before the session goes, not after: dropping the push token is an
    // authenticated call, and a handset left registered keeps buzzing with the
    // previous account's calls after somebody else signs in. Bounded (4s) inside
    // unregisterPush. Skipped after a deletion: the server already removed
    // every push row of the account, and the session may no longer verify.
    if (!afterDeletion) await unregisterPush();

    // Also before the session goes: the signed-out funnel reads the draft as
    // soon as it mounts, and the next account must not inherit any of it.
    await clearAccountLocalState(afterDeletion ? ACCOUNT_LOCAL_KEYS : SIGN_OUT_LOCAL_KEYS);

    if (__DEV__ && process.env.EXPO_PUBLIC_MOCK === '1') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mock = require('@/lib/mock/session') as typeof import('@/lib/mock/session');
      mock.setMockSession(null);
    } else {
      // 'local' ends this phone's session only: GoTrue revokes its refresh
      // token, and the website and other phones stay signed in. Ending those is
      // signOutOthers ("Sign out everywhere else" in Signed-in devices). A
      // deleted user's token is already dead server-side, so 'local' just drops it.
      const result = await Promise.race([
        supabase.auth.signOut({ scope: 'local' }),
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

    setSession(null);
  }, []);

  const signOutOthers = useCallback(async (): Promise<string | null> => {
    // Sessions first: a phone whose session has ended fails mobileAuth, so it
    // cannot register itself again after its device row goes below. Mock mode
    // has no other sessions, and must not end a real one left in the keychain.
    if (!(__DEV__ && process.env.EXPO_PUBLIC_MOCK === '1')) {
      const result = await Promise.race([
        supabase.auth.signOut({ scope: 'others' }),
        delay(SIGN_OUT_OTHERS_MS),
      ]);
      if (result === 'timeout') {
        return 'The request timed out. Check your network and try again.';
      }
      if (result.error) return friendlyAuthError(result.error.message);
    }
    // Then forget those installs and stop their call alerts. Best effort: their
    // sessions are gone, so a failure only leaves stale rows in the list.
    await api.signOutOtherDevices().catch(() => {});
    return null;
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
      configured: supabaseConfigured || (__DEV__ && process.env.EXPO_PUBLIC_MOCK === '1'),
      sendCode,
      verifyCode,
      signInWithProvider,
      signOut,
      signOutOthers,
    };
  }, [session, loading, sendCode, verifyCode, signInWithProvider, signOut, signOutOthers]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>.');
  return ctx;
}
