import * as Application from 'expo-application';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * This install's identity, and what links the handset to the website account.
 *
 * The account itself is already shared: the app signs into the same Supabase
 * project as the dashboard, so the same email is the same user id on both. What
 * was missing is any record of WHERE that account is signed in - the server only
 * ever saw a bearer token. This is that record: a UUID minted once on first
 * launch, sent on every `/api/mobile/*` call as `X-Device-Id`, and upserted into
 * `account_devices` so the web can list and revoke installs.
 *
 * Why the keychain and not AsyncStorage: the id must survive a sign-out and a
 * reinstall-over-restore, or the same phone would appear in the account's device
 * list two or three times over. On iOS the keychain outlives the app sandbox,
 * which is exactly the property wanted here - and unlike the Supabase session
 * (see secure-storage.ts) an orphaned id left behind by a deleted app is
 * harmless: it identifies a device, it grants nothing.
 *
 * Not a secret. Possessing it lets you claim to be this install on a request
 * that ALSO carries a valid bearer token for the account; on its own it opens
 * nothing.
 */

const KEY = 'device.id';

// Resolved once per app run. Every request header reads this, so it cannot be
// an await on the keychain each time.
let cached: string | null = null;
let inflight: Promise<string> | null = null;

async function mint(): Promise<string> {
  const id = Crypto.randomUUID();
  try {
    await SecureStore.setItemAsync(KEY, id);
  } catch {
    // A keychain that refuses to write still leaves a usable id for this run;
    // the next launch mints another and the account picks up a second row. That
    // is a cosmetic problem in a device list, not a broken app.
  }
  return id;
}

/**
 * The stable id for this install, minting one on first call.
 *
 * Concurrent callers share one in-flight promise: `registerDevice` and the first
 * API request fire together on launch, and two racing mints would write two ids
 * and leave the loser's requests labelled with an id no row will ever match.
 */
export async function deviceId(): Promise<string> {
  if (cached) return cached;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const existing = await SecureStore.getItemAsync(KEY);
      cached = existing ?? (await mint());
    } catch {
      cached = await mint();
    }
    return cached;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** The id if it is already resolved, else null. For synchronous header building. */
export function deviceIdSync(): string | null {
  return cached;
}

export interface DeviceDescription {
  platform: string;
  model: string;
  osVersion: string;
  appVersion: string;
}

/**
 * What the account's device list shows for this handset. Display only - the
 * server caps the lengths and never trusts any of it.
 */
export function describeDevice(): DeviceDescription {
  return {
    platform: Platform.OS,
    // `modelName` is null on a simulator and on some Android builds; the
    // fallback keeps the row from rendering as a blank line in the dashboard.
    model: Device.modelName ?? Device.deviceName ?? 'Unknown device',
    osVersion: `${Device.osName ?? Platform.OS} ${Device.osVersion ?? ''}`.trim(),
    appVersion: Application.nativeApplicationVersion ?? '',
  };
}

/**
 * Forget the id.
 *
 * Deliberately NOT called on sign-out: the same person signing back in on the
 * same handset should land on the row they already have, not add a new one. This
 * exists for an explicit "forget this device" and for tests.
 */
export async function clearDeviceId(): Promise<void> {
  cached = null;
  try {
    await SecureStore.deleteItemAsync(KEY);
  } catch {
    // Nothing to do - the next launch reuses whatever is still there.
  }
}
