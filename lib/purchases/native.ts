import { requireOptionalNativeModule } from 'expo';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { NativeModules, Platform } from 'react-native';

import type { UnavailableReason } from './types';

/**
 * The only place the two store SDKs are loaded from, and they are loaded
 * lazily and optionally.
 *
 * expo-iap resolves its native module with `requireNativeModule('ExpoIap')`
 * on first use and throws in Expo Go; react-native-purchases builds a
 * NativeEventEmitter on `NativeModules.RNPurchases` at import time and throws
 * on iOS, where it is not linked (react-native.config.js). A static import of
 * either would take the whole app down on the simulator, so each is checked
 * for its native half first and then `require`d inside a try. The `typeof
 * import()` types below are erased at compile time and load nothing.
 */

export type ExpoIapModule = typeof import('expo-iap');

/** The SDK class. Its enums (LOG_LEVEL, STORE_REPLACEMENT_MODE, PURCHASES_ERROR_CODE) are statics on it. */
export type RevenueCatModule = typeof import('react-native-purchases').default;

/** The public RevenueCat key for the Play app, injected per EAS profile. Never the secret one. */
const REVENUECAT_ANDROID_KEY = process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY ?? '';

export function revenueCatKey(): string {
  return REVENUECAT_ANDROID_KEY;
}

export function loadExpoIap(): ExpoIapModule | null {
  if (Platform.OS !== 'ios') return null;
  if (!requireOptionalNativeModule('ExpoIap')) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-iap') as ExpoIapModule;
  } catch {
    return null;
  }
}

export function loadRevenueCat(): RevenueCatModule | null {
  if (Platform.OS !== 'android') return null;
  if (!NativeModules.RNPurchases) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native-purchases') as typeof import('react-native-purchases');
    return mod?.default ?? null;
  } catch {
    return null;
  }
}

/**
 * Why purchases cannot run in this build, or null. Checked before any SDK is
 * loaded: Expo Go has neither native module, the web has no store, and an
 * Android build without its RevenueCat key must not configure the SDK at all -
 * configuring with an empty key fails every purchase with an opaque backend
 * error, the same trap the reference app's Galaxy-key guard covers.
 */
export function unavailableReason(): UnavailableReason {
  if (Platform.OS === 'web') return 'web';
  if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient) return 'expo-go';
  if (Platform.OS === 'android' && !REVENUECAT_ANDROID_KEY) return 'no-key';
  return null;
}

/** The store this build sells through, as the copy names it. */
export const STORE_NAME: 'App Store' | 'Google Play' =
  Platform.OS === 'android' ? 'Google Play' : 'App Store';

/** The billing provider a purchase on this platform becomes. */
export const PLATFORM_PROVIDER: 'apple' | 'google' = Platform.OS === 'android' ? 'google' : 'apple';
