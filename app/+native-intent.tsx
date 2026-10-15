/**
 * Every URL that opens the app passes through here before expo-router routes it.
 *
 * Two kinds of URL are not destinations, only return addresses:
 *
 *   - `.../auth-callback` - where Google and Apple (browser flow) send the user
 *     back after sign-in (lib/oauth.ts).
 *   - `.../handoff` - where a calendar connect returns (Linking.createURL('handoff')).
 *
 * On iOS the auth session hands these straight back to `openAuthSessionAsync`.
 * On Android it resolves through the same Linking 'url' event the router
 * listens to, so without this the router would ALSO navigate: sign-in used to
 * push an "Unmatched route" screen and a calendar connect jumped to Home.
 * Returning null makes the router ignore the URL; the auth session still gets
 * it. On a cold start (the app was killed while the browser was up) there is
 * nothing to return to, so it opens at the root.
 *
 * A bare `aireceptionistnow://` (older builds used it as a return URL) is
 * ignored while the app is running for the same reason.
 */
const RETURN_ADDRESS = /auth-callback|handoff/;
const BARE_SCHEME_ROOT = /^[a-z0-9.+-]+:\/\/\/?(\?.*)?$/i;

export function redirectSystemPath({
  path,
  initial,
}: {
  path: string;
  initial: boolean;
}): string | null {
  try {
    if (RETURN_ADDRESS.test(path)) return initial ? '/' : null;
    if (!initial && BARE_SCHEME_ROOT.test(path)) return null;
    return path;
  } catch {
    // A throw here crashes the app on launch; the root is always safe.
    return '/';
  }
}
