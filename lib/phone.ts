/**
 * The one rule for a phone number the app sends to be dialled: the transfer
 * number in the funnel and an assistant's transfer targets.
 *
 * It is the same rule as normalizePhone in the web repo's lib/phone.ts, which
 * the server applies on save; keep the two identical. Checking here catches a
 * bad number while the field is still on screen. No imports, so a Node script
 * can check this file directly.
 */

/** Drops what people type between digits: spaces, dots, dashes and parentheses. */
export const dialable = (n: string) => n.replace(/[\s().-]/g, '');

/** E.164: "+", a country code that does not start with 0, 7 to 15 digits in total. */
const E164 = /^\+[1-9]\d{6,14}$/;
/** North America (+1): exactly 10 digits; area code and exchange never start with 0 or 1. */
const NANP = /^\+1[2-9]\d{2}[2-9]\d{6}$/;

/** Whether `raw`, separators allowed, is a number the server stores and the call engine can dial. */
export function isValidPhone(raw: string): boolean {
  const phone = dialable(raw);
  if (!E164.test(phone)) return false;
  return !phone.startsWith('+1') || NANP.test(phone);
}
