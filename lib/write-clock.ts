/**
 * A count of the writes the server accepted during this app run.
 *
 * Every screen keeps its own copy of what it fetched and skips the refetch on
 * focus while that copy is under STALE_MS old (lib/use-query.ts). So a name
 * saved on the assistant screen stayed hidden on Home for up to 10 s. Now
 * lib/api.ts bumps this count after each successful write (countsAsWrite), and a
 * screen whose copy is older than the latest write refetches when it comes
 * forward.
 *
 * Module state on purpose, like lib/session-ended.ts: it only has to agree
 * within one app run.
 */

let writes = 0;

/** A write succeeded (see countsAsWrite). Called by lib/api.ts only. */
export function noteWrite(): void {
  writes += 1;
}

/** How many writes have succeeded so far in this app run. */
export function writeCount(): number {
  return writes;
}

/**
 * Whether a request that succeeded counts as a write: any non-GET, unless the
 * call passes `write: false`. Translate, the provisioning poll, web links and
 * the device and push check-ins change nothing a screen shows, and counting
 * them made every screen refetch on its next focus.
 */
export function countsAsWrite(init?: { method?: string; write?: boolean }): boolean {
  if (init?.write === false) return false;
  return (init?.method ?? 'GET').toUpperCase() !== 'GET';
}
