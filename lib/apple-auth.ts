import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';

import type * as AppleAuthentication from 'expo-apple-authentication';

import { api } from './api';
import { supabase, supabaseConfigured } from './supabase';

/**
 * Native Sign in with Apple (iOS only). Android, and any iOS build where the
 * module or the capability is missing, keep the browser flow in lib/oauth.ts.
 *
 * Why native on iOS when the browser flow already satisfies 4.8: App Review
 * flags a web-based Sign in with Apple behind a custom-styled button (4.0 /
 * HIG), and only the native flow hands the app Apple's `authorizationCode` -
 * which the server exchanges for the refresh token it needs to revoke the
 * Apple grant when the account is deleted (5.1.1(v)). The account is the same
 * Supabase user either way: `signInWithIdToken` verifies Apple's identity token
 * against the project's Apple provider (its Client IDs must list the bundle id,
 * and host.exp.Exponent for Expo Go during development).
 *
 * The module is required lazily inside try/catch, so a binary without it
 * falls back to the browser flow instead of crashing at import.
 */

type AppleAuthModule = typeof AppleAuthentication;

let loaded: AppleAuthModule | null | undefined;

/** expo-apple-authentication, or null off iOS or when this binary lacks it. */
export function appleAuthModule(): AppleAuthModule | null {
  if (loaded !== undefined) return loaded;
  loaded = null;
  if (Platform.OS !== 'ios') return loaded;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loaded = require('expo-apple-authentication') as AppleAuthModule;
  } catch {
    loaded = null;
  }
  return loaded;
}

/** Whether the native button and sheet can be used on this device. Never rejects. */
export async function isAvailable(): Promise<boolean> {
  const mod = appleAuthModule();
  if (!mod) return false;
  try {
    return await mod.isAvailableAsync();
  } catch {
    return false;
  }
}

/**
 * Run the native Apple sheet and start the Supabase session from it.
 *
 * Same contract as `signInWithProvider`: resolves to an error message to show,
 * or null when the user is signed in OR cancelled the sheet (not a failure).
 * The session lands through `onAuthStateChange`; callers do not navigate.
 *
 * `fallback` is the browser flow (`useAuth().signInWithProvider('apple')`),
 * used where the native module is missing and in mock mode, where the mock
 * session lives in AuthContext and a plain function cannot reach it.
 */
export async function signInWithAppleNative(
  fallback: () => Promise<string | null>,
): Promise<string | null> {
  // Inline so a release build folds `__DEV__` away together with this branch.
  if (__DEV__ && process.env.EXPO_PUBLIC_MOCK === '1') return fallback();

  const mod = appleAuthModule();
  if (!mod) return fallback();
  if (!supabaseConfigured) return 'Sign-in is not configured yet.';

  // Apple signs a hash of the nonce into the identity token; Supabase gets the
  // raw value, hashes it and compares, so a token lifted from elsewhere is
  // useless without this run's secret.
  const rawNonce = Crypto.randomUUID();
  const hashedNonce = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    rawNonce,
  );

  let credential: AppleAuthentication.AppleAuthenticationCredential;
  try {
    credential = await mod.signInAsync({
      requestedScopes: [
        mod.AppleAuthenticationScope.FULL_NAME,
        mod.AppleAuthenticationScope.EMAIL,
      ],
      nonce: hashedNonce,
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_REQUEST_CANCELED') return null;
    return error instanceof Error && error.message ? error.message : 'Apple sign-in failed.';
  }

  if (!credential.identityToken) return 'Apple did not return a sign-in token. Try again.';

  const { error } = await supabase.auth.signInWithIdToken({
    provider: 'apple',
    token: credential.identityToken,
    nonce: rawNonce,
  });
  if (error) return error.message;

  // Apple sends the name on the FIRST sign-in only, so it is saved now or
  // never. A failure here costs the display name, not the session.
  const name = [
    credential.fullName?.givenName,
    credential.fullName?.middleName,
    credential.fullName?.familyName,
  ]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(' ');
  if (name) {
    try {
      await supabase.auth.updateUser({ data: { full_name: name } });
    } catch {
      // Keep the session; the name can be set on the web.
    }
  }

  // Fire and forget: the server stores Apple's refresh token for revocation on
  // account deletion. Nothing the user could do about a failure here.
  if (credential.authorizationCode) {
    void api.registerAppleToken(credential.authorizationCode).catch(() => {});
  }
  return null;
}
