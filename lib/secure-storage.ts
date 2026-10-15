import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * Storage adapter for the Supabase session, backed by the OS keychain
 * (Keychain on iOS, EncryptedSharedPreferences on Android).
 *
 * Why not AsyncStorage, which is what most Expo + Supabase examples use: the
 * value being stored is a refresh token. AsyncStorage is a plaintext file in
 * the app sandbox, readable on a rooted/jailbroken device or out of an
 * unencrypted device backup. This is the one value in the app worth the
 * keychain round trip.
 *
 * SecureStore warns above 2048 bytes per entry on Android, and a Supabase
 * session (access JWT + refresh token + user object) routinely exceeds it, so
 * values are split across numbered chunks with an index entry holding the
 * count. Reading is only correct if the count matches what was written, so a
 * partial write is treated as no value at all rather than as truncated JSON.
 *
 * On web (Expo's web target) SecureStore does not exist; localStorage is the
 * only option there and Supabase uses it by default, so the adapter steps
 * aside.
 */

/**
 * The Supabase client's `storageKey` (lib/supabase.ts). Named here rather than
 * there because this module is what wipes it - on a fresh install below, and on
 * a sign-out that could not reach the server (context/AuthContext.tsx).
 */
export const AUTH_STORAGE_KEY = 'arn-auth';
/** Where auth-js keeps the PKCE verifier for an OAuth flow in progress. */
export const AUTH_VERIFIER_KEY = `${AUTH_STORAGE_KEY}-code-verifier`;

const CHUNK = 1800;

// Upper bound on the straggler sweep in `removeChunks`. A Supabase session is a
// few KB, so a handful of chunks; this only has to outrun any session we would
// ever write.
const MAX_CHUNKS = 64;

function chunkKey(key: string, i: number): string {
  return `${key}__${i}`;
}

// SecureStore keys must be alphanumeric plus ".", "-" and "_". Supabase's keys
// already satisfy that, but a key it derives later might not, so normalize
// rather than fail at runtime.
function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_');
}

async function removeChunks(rawKey: string): Promise<void> {
  const key = safeKey(rawKey);
  const countRaw = await SecureStore.getItemAsync(key);
  const count = Number(countRaw);
  // Drop the index first so a failure mid-loop cannot leave a count pointing
  // at chunks that are already gone.
  await SecureStore.deleteItemAsync(key);

  const known = Number.isInteger(count) && count > 0 ? count : 0;
  for (let i = 0; i < known; i++) {
    await SecureStore.deleteItemAsync(chunkKey(key, i));
  }
  // Returning early when the index is missing is exactly wrong: an interrupted
  // setItem writes chunks but never the index, and the delete above drops the
  // index before its own chunks, so the count cannot describe what is left.
  // Without this sweep those chunks - fragments of a real refresh token - stay
  // in the keychain forever, because nothing else knows they exist. Chunks are
  // written 0..N-1 in order, so delete past the recorded count until the first
  // gap.
  for (let i = known; i < known + MAX_CHUNKS; i++) {
    const k = chunkKey(key, i);
    if ((await SecureStore.getItemAsync(k)) == null) break;
    await SecureStore.deleteItemAsync(k);
  }
}

/**
 * Marks that this install has already run. AsyncStorage on purpose: it lives in
 * the app sandbox and is deleted with the app, which is the one thing the
 * keychain is not.
 */
const INSTALL_KEY = 'install.v1';

/**
 * What a fresh install must not inherit. The session and the PKCE verifiers
 * only - NOT `device.id` (lib/device.ts), which is kept across reinstalls on
 * purpose so the same handset keeps its row in the account's device list.
 */
const WIPE_ON_INSTALL = [
  AUTH_STORAGE_KEY,
  AUTH_VERIFIER_KEY,
  // auth-js 2.11x indexes its per-flow verifier slots under this key.
  `${AUTH_STORAGE_KEY}-flows-code-verifier`,
];

let guard: Promise<void> | null = null;

/**
 * Forget a session left behind by a previous install.
 *
 * On iOS the keychain outlives the app: delete the app, reinstall it, and the
 * old refresh token is still there, so the "fresh" install opens signed in to
 * whoever used it last - on a sold or shared phone, somebody else's account.
 * The first run of an install has no AsyncStorage marker yet, which is how it
 * is told apart from a normal cold start.
 *
 * Runs once per process, before the first keychain access. A failure leaves the
 * marker unset so the next launch tries again, and never blocks the read: a
 * signed-in user must not be locked out by a keychain hiccup.
 */
function installGuard(): Promise<void> {
  if (!guard) {
    guard = (async () => {
      try {
        if (await AsyncStorage.getItem(INSTALL_KEY)) return;
        for (const key of WIPE_ON_INSTALL) await removeChunks(key);
        await AsyncStorage.setItem(INSTALL_KEY, '1');
      } catch {
        // See above: retried on the next launch.
      }
    })();
  }
  return guard;
}

export const secureStorage = {
  async getItem(rawKey: string): Promise<string | null> {
    if (Platform.OS === 'web') return null;
    await installGuard();
    const key = safeKey(rawKey);
    const countRaw = await SecureStore.getItemAsync(key);
    if (countRaw == null) return null;

    const count = Number(countRaw);
    if (!Number.isInteger(count) || count < 1) return null;

    const parts: string[] = [];
    for (let i = 0; i < count; i++) {
      const part = await SecureStore.getItemAsync(chunkKey(key, i));
      // A missing chunk means the last write was interrupted. Half a session is
      // worse than none - it would parse as invalid JSON and Supabase would
      // sign the user out anyway, but noisily.
      if (part == null) return null;
      parts.push(part);
    }
    return parts.join('');
  },

  async setItem(rawKey: string, value: string): Promise<void> {
    if (Platform.OS === 'web') return;
    // Awaited here too: a sign-in that lands before the first read would
    // otherwise be wiped by the guard as "left over from the last install".
    await installGuard();
    const key = safeKey(rawKey);

    // Clear the previous chunks first: a shorter new value would otherwise
    // leave stale trailing chunks behind, and while the count entry means they
    // are never read, they are still a refresh token sitting on disk.
    await removeChunks(rawKey);

    const chunks: string[] = [];
    for (let i = 0; i < value.length; i += CHUNK) {
      chunks.push(value.slice(i, i + CHUNK));
    }
    for (let i = 0; i < chunks.length; i++) {
      await SecureStore.setItemAsync(chunkKey(key, i), chunks[i]);
    }
    // Written last, so an interrupted write leaves no count and reads as
    // "signed out" rather than as a corrupt session.
    await SecureStore.setItemAsync(key, String(chunks.length));
  },

  async removeItem(rawKey: string): Promise<void> {
    if (Platform.OS === 'web') return;
    await installGuard();
    await removeChunks(rawKey);
  },
};
