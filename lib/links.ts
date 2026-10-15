import * as WebBrowser from 'expo-web-browser';
import { Alert, Linking } from 'react-native';

import { formatPhone } from './format';

/**
 * Every URL the app opens, and the three ways it opens them.
 *
 * The site pages carry `?app=1`. With it, the web renders the page WITHOUT the
 * site header and footer - no Pricing, 'Start now' or Dashboard links - and
 * without any link to /pricing. Store review rejects an app that routes a user
 * to a web purchase, and a legal page opened from the paywall is one tap away
 * from one otherwise. Store listings use the plain URLs.
 */

export const SITE = 'https://aireceptionistnow.com';

export const PRIVACY_URL = `${SITE}/privacy-policy?app=1`;
export const TERMS_URL = `${SITE}/terms-of-service?app=1`;
export const SUPPORT_URL = `${SITE}/support?app=1`;
export const ACCOUNT_DELETE_URL = `${SITE}/account/delete?app=1`;

/** Apple's standard EULA - the Terms of Use an iOS subscription paywall must link. */
export const APPLE_EULA_URL = 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/';

/** Where a Google Play subscriber manages or cancels. `sku` opens that subscription directly. */
export function PLAY_SUBSCRIPTIONS_URL(sku?: string): string {
  return `https://play.google.com/store/account/subscriptions?package=com.aireceptionistnow.app${
    sku ? `&sku=${encodeURIComponent(sku)}` : ''
  }`;
}

/** Where an App Store subscriber manages or cancels. */
export const APPLE_SUBSCRIPTIONS_URL = 'https://apps.apple.com/account/subscriptions';

// All three resolve once the OS has taken the link (openInApp: once the browser
// is dismissed) and never reject - a failure is reported to the user here, so a
// caller can fire and forget or await to refresh afterwards.

/**
 * Place a call.
 *
 * `tel:` fails on any device with no dialer, and the build ships to iPad
 * (`ios.supportsTablet`). Dropping the rejection leaves a row that does nothing
 * at all, which reads as a broken app rather than an unsupported device.
 */
export async function dial(e164: string): Promise<void> {
  try {
    await Linking.openURL(`tel:${e164}`);
  } catch {
    Alert.alert('Cannot start a call', `${formatPhone(e164)} - this device cannot place phone calls.`);
  }
}

/** Open one of our own pages in the in-app browser, keeping the user in the app. */
export async function openInApp(url: string): Promise<void> {
  try {
    await WebBrowser.openBrowserAsync(url);
  } catch {
    Alert.alert('Could not open this link', 'Try again in a moment.');
  }
}

/** Hand a link to the OS: a store page, a calendar event's own URL, a map. */
export async function openExternal(url: string): Promise<void> {
  try {
    await Linking.openURL(url);
  } catch {
    Alert.alert('Could not open this link', 'Try again in a moment.');
  }
}
