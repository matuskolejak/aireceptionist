import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';

import { supabase, supabaseConfigured } from './supabase';

/**
 * Google and Apple sign-in through the browser, matching the two buttons on
 * the web dialog.
 *
 * Used for Google everywhere and for Apple on Android. On iOS Apple signs in
 * natively (lib/apple-auth.ts, Apple's own button and sheet), and falls back to
 * this flow only where the native module or capability is missing.
 *
 * Supabase mints the provider URL, `openAuthSessionAsync` shows it in the
 * system auth view (ASWebAuthenticationSession on iOS, a Custom Tab on
 * Android), and the provider redirects back into the app through the
 * `aireceptionistnow://` scheme with a PKCE code this process exchanges for a
 * session. The return URL is not a screen: app/+native-intent.tsx keeps the
 * router from navigating to it on Android, where it arrives as a Linking event.
 *
 * Why not the Google Sign-In SDK: a native module absent from Expo Go, so
 * adopting it costs the simulator loop the app is developed on and a rebuild
 * per change. This flow is the same Supabase endpoints the dashboard uses, so
 * an account created here and an account created on the site are the same row
 * - which is the whole point.
 *
 * The system auth view shares cookies with Safari, so someone already signed
 * into Google on the phone taps once and is back.
 */

export type OAuthProvider = 'google' | 'apple';

/**
 * Where the provider sends the browser when it is done.
 *
 * `createURL` resolves to `aireceptionistnow://auth-callback` in a real build
 * and to `exp://<host>/--/auth-callback` under Expo Go, and BOTH have to be in
 * the Supabase project's redirect allow-list or the provider bounces with
 * "requested path is invalid". See README for the exact values.
 */
export function oauthRedirectUri(): string {
  return Linking.createURL('/auth-callback');
}

/**
 * Everything the callback URL can carry.
 *
 * Supabase can answer on the query string (PKCE: `?code=`) or, if the project is
 * still on the implicit flow, in the fragment (`#access_token=`). Both are read
 * so a project-level setting cannot silently break sign-in in a shipped binary.
 */
function parseCallback(url: string): {
  code?: string;
  accessToken?: string;
  refreshToken?: string;
  error?: string;
} {
  const out: ReturnType<typeof parseCallback> = {};

  const collect = (raw: string) => {
    const params = new URLSearchParams(raw);
    const code = params.get('code');
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    // `error_description` is the human sentence; `error` is a slug like
    // `access_denied`. Prefer the sentence, fall back to the slug.
    const error = params.get('error_description') ?? params.get('error');
    if (code) out.code = code;
    if (accessToken) out.accessToken = accessToken;
    if (refreshToken) out.refreshToken = refreshToken;
    if (error) out.error = error;
  };

  const [beforeHash, afterHash] = url.split('#');
  const query = beforeHash.split('?')[1];
  if (query) collect(query);
  if (afterHash) collect(afterHash);
  return out;
}

/**
 * Run the provider flow.
 *
 * Resolves to an error message to show, or `null` when the user is signed in OR
 * deliberately backed out - a cancelled sign-in is not a failure and must not
 * paint the screen red. The session lands through `onAuthStateChange`, so
 * callers do not navigate; the root layout's gate does.
 */
export async function signInWithProvider(provider: OAuthProvider): Promise<string | null> {
  if (!supabaseConfigured) return 'Sign-in is not configured yet.';

  const redirectTo = oauthRedirectUri();

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo,
      // Without this supabase-js tries to navigate the (non-existent) browser
      // itself and returns no URL to open.
      skipBrowserRedirect: true,
    },
  });
  if (error) return error.message;
  if (!data?.url) return 'Could not start sign-in.';

  // Rejects rather than resolving when it cannot open at all: no Custom Tabs
  // browser on Android, or another browser sheet already up on iOS.
  let result: WebBrowser.WebBrowserAuthSessionResult;
  try {
    result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
  } catch (e) {
    return e instanceof Error && e.message ? e.message : 'Could not open the sign-in page.';
  }

  // `dismiss` is the iOS sheet being swiped away, `cancel` the Android back
  // gesture. Both mean "changed my mind".
  if (result.type !== 'success') return null;

  const parsed = parseCallback(result.url);
  if (parsed.error) return parsed.error;

  if (parsed.code) {
    const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(parsed.code);
    return exchangeError ? exchangeError.message : null;
  }

  if (parsed.accessToken && parsed.refreshToken) {
    const { error: setError } = await supabase.auth.setSession({
      access_token: parsed.accessToken,
      refresh_token: parsed.refreshToken,
    });
    return setError ? setError.message : null;
  }

  // A success result with nothing usable in it means the redirect was
  // intercepted or the provider is misconfigured - say so rather than leaving
  // the button spinning on a screen that never changes.
  return 'Sign-in did not complete. Try again.';
}
