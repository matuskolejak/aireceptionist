/**
 * Why the user is suddenly signed out.
 *
 * A 401 from the API signs the session out (lib/use-query.ts) - the only way
 * to get one is an expired or revoked session. Without a word about it the
 * user lands on the first screen with whatever they were doing gone, which
 * reads as the app breaking. This is the one-shot note that lets the root
 * layout open sign-in and lets sign-in say what happened.
 *
 * Module state on purpose: it only has to survive until the next screen, and
 * a value that outlived the app run would greet a deliberate sign-out with
 * "your session ended".
 */

let ended = false;

/** The API refused the session. Called before the sign-out. */
export function markSessionEnded(): void {
  ended = true;
}

/** Whether the current signed-out state was forced by a lost session. */
export function sessionEnded(): boolean {
  return ended;
}

/** A session exists again (or the user was told): the note is spent. */
export function clearSessionEnded(): void {
  ended = false;
}
