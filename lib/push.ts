import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { api } from './api';

/**
 * Push registration.
 *
 * This is the only part of the app that works while the app is closed, and it
 * is the whole reason a phone beats the dashboard for this product: the web app
 * can show you that a call was missed, but it cannot tell you.
 *
 * Everything here fails soft. A denied permission, a simulator, a missing EAS
 * project id - none of them are errors worth showing on top of a working app,
 * so each one resolves to a `PushState` the Alerts screen can explain instead.
 *
 * Nothing here prompts on its own. The OS permission sheet is shown only from
 * `requestAndRegister`, which runs behind a primer card or the Alerts switch -
 * never the moment a session appears, which used to put the system prompt on
 * top of the setup funnel before the user had paid for anything to be alerted
 * about.
 */

/** Android needs a channel before any notification is posted; the server sends `channelId: "calls"`. */
const CHANNEL_ID = 'calls';

export type PushState =
  | { status: 'ready'; token: string }
  /**
   * The OS allows alerts and this install is not muted, but no token was minted
   * in this pass. The Alerts screen reads the permission on mount without
   * registering, so it has a grant to show and no token to put in `ready`.
   */
  | { status: 'granted' }
  /** Delivery muted server-side by the user; the OS grant is still in place. */
  | { status: 'muted' }
  /** The OS prompt was answered "no", or was answered "no" previously. */
  | { status: 'denied' }
  /** Physical device required - the push service has nothing to route to on a simulator. */
  | { status: 'unsupported'; reason: string }
  /** Registered with Expo but the server refused the token. */
  | { status: 'error'; reason: string };

/**
 * What a user reads when the phone could not mint a token. The raw error is a
 * Firebase / APNs message ("FIS_AUTH_ERROR", "no valid aps-environment") that
 * says nothing actionable to anyone but a developer.
 */
const TOKEN_FAILED = 'Alerts could not be set up on this phone.';

/**
 * Foreground behaviour.
 *
 * An alert that fires while you are already looking at the call it describes is
 * noise, but the app cannot know which screen you are on from here - so it
 * shows the banner and lets the tap handler no-op if you are already there.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/**
 * The EAS project id, which `getExpoPushTokenAsync` needs to mint a token.
 *
 * Written into `extra.eas.projectId` by `eas init`. Absent in a fresh clone,
 * and the resulting error message ("No projectId found") is opaque enough to
 * cost an afternoon - so it is checked explicitly and reported in plain words.
 */
function projectId(): string | null {
  const extra = Constants.expoConfig?.extra as
    | { eas?: { projectId?: string } }
    | undefined;
  return extra?.eas?.projectId ?? null;
}

/** Mint this install's Expo token, with the raw failure logged for developers only. */
async function expoToken(id: string): Promise<string> {
  try {
    return (await Notifications.getExpoPushTokenAsync({ projectId: id })).data;
  } catch (err) {
    if (__DEV__) console.warn('[push] token failed:', err);
    throw new Error(TOKEN_FAILED);
  }
}

/**
 * Whether this install has muted delivery.
 *
 * The real flag is the `enabled` column on the server's push_devices row, but
 * /api/mobile/push has no GET to read it back, and registering on the next cold
 * start upserts `enabled: true` straight over the mute. So the choice is
 * mirrored on the device: this is what re-applies the mute after a re-register,
 * and it is the only thing the Alerts switch can read to show the user what
 * they chose last time.
 *
 * AsyncStorage rather than SecureStore on purpose. It is a preference, not a
 * secret, and on iOS SecureStore is the Keychain, whose items survive deleting
 * the app - so a mute set before a reinstall would silently mute the fresh
 * install's registration with nothing on screen to explain where that came from.
 * AsyncStorage is scoped to the install and goes with it.
 */
const MUTED_KEY = 'push.muted';

async function readMuted(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(MUTED_KEY)) === '1';
  } catch {
    return false;
  }
}

async function writeMuted(muted: boolean): Promise<void> {
  try {
    if (muted) await AsyncStorage.setItem(MUTED_KEY, '1');
    else await AsyncStorage.removeItem(MUTED_KEY);
  } catch {
    // A phone that cannot store the flag still gets the server-side mute, it
    // just comes back on at the next cold start. Not worth failing a toggle for.
  }
}

/** Has the user muted alerts on this install? The Alerts switch seeds from this. */
export async function isPushMuted(): Promise<boolean> {
  return readMuted();
}

/**
 * Whether the push primer (the in-app card that explains alerts before the OS
 * prompt) has been answered on this install, either way. Install-scoped like the
 * mute, and for the same reason.
 */
const PRIMER_KEY = 'push.primer';

export async function primerAnswered(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(PRIMER_KEY)) === '1';
  } catch {
    // Unreadable storage: treat as answered. Showing the card again is worse
    // than never showing it - the Alerts screen still has the switch.
    return true;
  }
}

export async function markPrimerAnswered(): Promise<void> {
  try {
    await AsyncStorage.setItem(PRIMER_KEY, '1');
  } catch {
    // The card comes back next launch. Harmless.
  }
}

async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'Calls and bookings',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: '#1D1D1D',
  });
}

/** Why this build or device cannot receive push at all, or null when it can. */
function unsupportedReason(): PushState | null {
  if (!Device.isDevice) {
    return { status: 'unsupported', reason: 'Alerts need a real device - a simulator cannot receive them.' };
  }
  if (!projectId()) {
    return {
      status: 'unsupported',
      reason: 'This build has no EAS project id yet. Run `eas init` and rebuild to enable alerts.',
    };
  }
  return null;
}

/** Mint the token, hand it to the server, and re-apply a mute. Permission already granted. */
async function registerGranted(id: string): Promise<PushState> {
  let token: string;
  try {
    token = await expoToken(id);
  } catch (err) {
    return { status: 'error', reason: (err as Error).message };
  }

  try {
    await api.registerPush(token, Platform.OS);
  } catch (err) {
    return { status: 'error', reason: (err as Error).message };
  }

  // The server's upsert writes `enabled: true` on every register, so without
  // this a mute is silently undone by the next launch and the phone starts
  // buzzing again with nothing in the UI having changed.
  if (await readMuted()) {
    try {
      await api.setPushEnabled(token, false);
      return { status: 'muted' };
    } catch (err) {
      return { status: 'error', reason: (err as Error).message };
    }
  }

  return { status: 'ready', token };
}

/**
 * Register only if the user has already allowed notifications. Never prompts.
 *
 * Safe to call on every cold start: the server upserts on the token rather than
 * inserting. That repetition is deliberate - it is also how a token that
 * rotated after an OS restore gets back into the table. Resolves to null when
 * the OS has not asked yet: that is not a denial, the primer has simply not
 * been answered.
 */
export async function registerIfGranted(): Promise<PushState | null> {
  const unsupported = unsupportedReason();
  if (unsupported) return unsupported;

  const existing = await Notifications.getPermissionsAsync();
  if (!existing.granted) return existing.canAskAgain ? null : { status: 'denied' };

  await ensureAndroidChannel();
  return registerGranted(projectId() as string);
}

/**
 * Ask (once) and hand the token to the server. The ONLY function that shows the
 * OS permission prompt - call it from an explicit user action.
 */
export async function requestAndRegister(): Promise<PushState> {
  const unsupported = unsupportedReason();
  if (unsupported) return unsupported;

  await ensureAndroidChannel();

  const existing = await Notifications.getPermissionsAsync();
  let granted = existing.granted;
  // Never re-prompt when the user has already said no: iOS shows the system
  // prompt exactly once, so a second request silently resolves to denied and
  // the only way back is Settings.
  if (!granted && existing.canAskAgain) {
    const asked = await Notifications.requestPermissionsAsync();
    granted = asked.granted;
  }
  if (!granted) return { status: 'denied' };

  return registerGranted(projectId() as string);
}

/** The most sign-out waits on dropping the token. */
const UNREGISTER_CAP_MS = 4000;

/**
 * Drop this install's token.
 *
 * Called on sign-out. Skipping it would keep delivering one account's call
 * alerts to a handset somebody else has signed into - the token belongs to the
 * install, not the session.
 *
 * Capped at 4s and never rejects. Minting the token and the DELETE both need a
 * network, and on a dead one they used to hold sign-out for half a minute; the
 * server also stops push to a device when its row is revoked, so a token that
 * could not be dropped here is recoverable from the web.
 */
export async function unregisterPush(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, UNREGISTER_CAP_MS);
  });
  try {
    await Promise.race([dropToken(), cap]);
  } finally {
    clearTimeout(timer);
  }
}

async function dropToken(): Promise<void> {
  // The mute belongs to whoever set it. The row is dropped here and the next
  // account to sign in on this handset registers from scratch, so keeping the
  // flag would silence alerts for someone who never turned them off.
  await writeMuted(false);

  const id = projectId();
  if (!id || !Device.isDevice) return;
  try {
    await api.unregisterPush(await expoToken(id));
  } catch {
    // Best effort: a failure here must never block sign-out.
  }
}

/** Turn delivery off server-side without dropping the row, for the Alerts switch. */
export async function setPushEnabled(enabled: boolean): Promise<PushState> {
  // Cleared before registering, otherwise the mute re-apply inside
  // registerGranted would undo the unmute the user just asked for.
  if (enabled) {
    await writeMuted(false);
    return requestAndRegister();
  }

  const id = projectId();
  if (!id || !Device.isDevice) return { status: 'unsupported', reason: 'Not available on this device.' };
  try {
    await api.setPushEnabled(await expoToken(id), false);
    await writeMuted(true);
    // Not 'denied': the OS grant is untouched, and reporting a denial here is
    // what used to send a self-muted user to a system Settings page with
    // nothing wrong on it.
    return { status: 'muted' };
  } catch (err) {
    return { status: 'error', reason: (err as Error).message };
  }
}

export interface PushPayload {
  path: string;
  category: string;
}

/**
 * The in-app routes a notification may open. A payload is attacker-influenceable
 * in principle, and handing an arbitrary string to the router is how that
 * becomes a bug - so it is an allow-list of first segments, not "anything that
 * starts with a slash".
 */
const PUSH_PATH = /^\/(?:call\/[\w-]+|calls|calendar|notifications|assistant\/[\w-]+|knowledge)(?:[/?#]|$)/;

/** Where a tap lands when the payload names nothing we recognise. */
const FALLBACK_PATH = '/notifications';

/** Read the deep-link target the server attached. Anything unrecognised opens Activity. */
export function payloadOf(response: Notifications.NotificationResponse): PushPayload | null {
  const data = response.notification.request.content.data as Record<string, unknown> | undefined;
  const raw = typeof data?.path === 'string' ? data.path : '';
  const path = PUSH_PATH.test(raw) && !raw.includes('..') ? raw : FALLBACK_PATH;
  return { path, category: typeof data?.category === 'string' ? data.category : 'system' };
}
