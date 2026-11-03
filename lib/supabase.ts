import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as Crypto from 'expo-crypto';
import { AppState } from 'react-native';

import { AUTH_STORAGE_KEY, secureStorage } from './secure-storage';

// React Native has no global `crypto`, so Supabase made the PKCE verifier with
// Math.random(). expo-crypto's getRandomValues reads the OS secure random
// source. Only this function is added: a `crypto.subtle` with digest alone
// would turn the challenge into SHA-256, but auth.getClaims() would then call
// subtle.importKey, which expo-crypto does not have. So the challenge stays
// "plain", and Supabase still warns "WebCrypto API is not supported".
const webCrypto = ((globalThis as { crypto?: { getRandomValues?: typeof Crypto.getRandomValues } })
  .crypto ??= {});
webCrypto.getRandomValues ??= Crypto.getRandomValues;

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

export const supabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

/**
 * The same Supabase project the web dashboard signs into. This client is used
 * for auth ONLY - never for table reads.
 *
 * Every operational table (calls, assistants, phone_numbers, ...) has RLS
 * enabled with no policies, so the anon key can read nothing; the web app goes
 * through the service-role client server-side and scopes by owner_id in code.
 * The app follows the same rule and reads data through /api/mobile/*, passing
 * this session's access token as a bearer. Adding table queries here would just
 * return empty arrays and look like "no calls yet".
 */
export const supabase: SupabaseClient = createClient(
  SUPABASE_URL || 'https://placeholder.supabase.co',
  SUPABASE_ANON_KEY || 'placeholder',
  {
    auth: {
      storage: secureStorage,
      // Fixed rather than derived from the project URL (`sb-<ref>-auth-token`),
      // so the keys that sign-out and the fresh-install wipe delete are known
      // here instead of recomputed from configuration.
      storageKey: AUTH_STORAGE_KEY,
      autoRefreshToken: true,
      persistSession: true,
      // No URL to parse in a native app; leaving this on makes Supabase touch
      // window.location, which does not exist here. The OAuth callback is
      // handled explicitly instead - see lib/oauth.ts.
      detectSessionInUrl: false,
      // PKCE, not the implicit flow. Google/Apple sign-in hands the callback
      // back through a `aireceptionistnow://` deep link, and a link is visible
      // to any other app that claims the scheme; PKCE means what travels in it
      // is a one-time code that is worthless without the verifier held in this
      // process, rather than the access and refresh tokens themselves.
      flowType: 'pkce',
    },
  },
);

/**
 * Supabase's refresh timer is a JS interval, and JS is frozen while the app is
 * backgrounded - so without this a phone left in a pocket comes back with an
 * expired access token and the first API call 401s. Restarting the timer on
 * foreground refreshes it before anything renders.
 */
let appStateBound = false;
export function bindAuthRefreshToAppState(): () => void {
  if (appStateBound || !supabaseConfigured) return () => {};
  appStateBound = true;
  const sub = AppState.addEventListener('change', (state) => {
    if (state === 'active') void supabase.auth.startAutoRefresh();
    else void supabase.auth.stopAutoRefresh();
  });
  return () => {
    sub.remove();
    appStateBound = false;
  };
}
