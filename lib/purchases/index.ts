import { Platform } from 'react-native';

import { createAndroidAdapter } from './android';
import { createIosAdapter } from './ios';
import { loadExpoIap, loadRevenueCat, revenueCatKey, unavailableReason } from './native';
import type { StoreAdapter } from './types';

export { PLATFORM_PROVIDER, STORE_NAME, unavailableReason } from './native';
export * from './types';

/**
 * The store adapter for this build, or null when purchases cannot run here
 * (see `unavailableReason`). Mock first: the simulator has no store at all.
 */
export function createAdapter(): StoreAdapter | null {
  // Dev-only store mock (EXPO_PUBLIC_IAP_MOCK=1, see ./mock.ts). Inline, with
  // the require inside the branch, so a release build folds `__DEV__` to false
  // and drops both the branch and the mock file.
  if (__DEV__ && process.env.EXPO_PUBLIC_IAP_MOCK === '1') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('./mock') as typeof import('./mock')).createMockAdapter();
  }
  if (unavailableReason() !== null) return null;
  if (Platform.OS === 'ios') {
    const iap = loadExpoIap();
    return iap ? createIosAdapter(iap) : null;
  }
  if (Platform.OS === 'android') {
    const rc = loadRevenueCat();
    return rc ? createAndroidAdapter(rc, revenueCatKey()) : null;
  }
  return null;
}
