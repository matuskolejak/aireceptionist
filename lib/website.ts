/**
 * Whether the funnel's website box holds a web address, not plain words such
 * as "my bakery". The server names the business after the domain when no name
 * was given (companyNameFromWebsite in the web repo), so plain words there
 * become "My company". It parses the way the server does: new URL on
 * "https://" plus the text. No imports, so a Node script can check this file.
 */
export function looksLikeWebsite(raw: string): boolean {
  const text = raw.trim();
  if (!text || /\s/.test(text)) return false;
  // Ideographic and full-width dots are dots, as in Node and browsers (UTS 46).
  // The phone's URL polyfill keeps them as typed.
  const rest = text.replace(/^https?:\/\//i, '').replace(/[\u3002\uff0e\uff61]/g, '.');
  let url: URL;
  try {
    url = new URL(`https://${rest}`);
  } catch {
    return false;
  }
  // "info@bakery.com" parses as a login at bakery.com: an email, not a site.
  if (url.username) return false;
  // Lowercased here: Node and browsers lowercase the host, but the phone's URL
  // polyfill (whatwg-url-without-unicode) keeps it as typed.
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || host.startsWith('.') || host.endsWith('.')) return false;
  const top = host.slice(host.lastIndexOf('.') + 1);
  // A letter of any script, then letters or the marks some scripts need ("рф"
  // and "भारत" stay Unicode in the polyfill), or an internationalised top-level
  // domain in punycode (Node and browsers).
  return /^\p{L}[\p{L}\p{M}]+$/u.test(top) || /^xn--[a-z0-9-]+$/.test(top);
}
