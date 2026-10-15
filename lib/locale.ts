import { getCalendars, getLocales } from 'expo-localization';

/**
 * What the phone itself says about where it is. The app's copy stays English
 * (every Intl call is pinned to 'en'); these only feed defaults the web derives
 * from the browser the same way.
 */

/**
 * The phone's IANA time zone.
 *
 * Sent as `?tz=` on the calendar and assistant routes: an account that never
 * saved a zone would otherwise be shown every time in UTC, while the web falls
 * back to the browser's zone for the same account. Never throws - a phone that
 * cannot say gets 'UTC', which is what the server would have used anyway.
 */
export function deviceTimeZone(): string {
  try {
    const zone = getCalendars()[0]?.timeZone;
    if (zone) return zone;
  } catch {
    // Fall through to Intl.
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Which number country to preselect for a given UI language. Mirrors
 * LOCALE_COUNTRY in the web repo's lib/number-pricing.ts, so the same person
 * gets the same default on both surfaces.
 */
const LOCALE_COUNTRY: Record<string, string> = {
  en: 'US',
  es: 'ES',
  de: 'DE',
  fr: 'FR',
  sk: 'SK',
  it: 'IT',
  pt: 'PT',
  nl: 'NL',
};

/**
 * The number country to preselect.
 *
 * The phone's region first - an Irish English phone wants an Irish number, which
 * a language table alone would call US - then the web's language table, then
 * the first country the server offers. Only ever returns a code that is in
 * `countries` (or 'US' when the list is empty), so a picker can always show it.
 */
export function countryForLocale(countries: { code: string }[]): string {
  const offered = (code: string | null | undefined): string | null => {
    const upper = (code ?? '').toUpperCase();
    return upper && countries.some((c) => c.code === upper) ? upper : null;
  };

  let locale: { regionCode: string | null; languageCode: string | null } | undefined;
  try {
    locale = getLocales()[0];
  } catch {
    locale = undefined;
  }

  const byRegion = offered(locale?.regionCode);
  if (byRegion) return byRegion;

  const byLanguage = offered(LOCALE_COUNTRY[(locale?.languageCode ?? '').toLowerCase()]);
  if (byLanguage) return byLanguage;

  return countries[0]?.code ?? 'US';
}
