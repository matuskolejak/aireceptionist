/**
 * How long a screen stuck on a connection or server error waits before it
 * tries again (lib/use-query.ts): 15 s, 30 s, 60 s, then 60 s for good.
 *
 * Each wait moves by up to 20% either way. Without that, every phone that
 * failed in the same outage retries in the same second, and keeps doing so.
 *
 * No imports on purpose, so a Node script can check it without React Native.
 */
const FIRST_MS = 15_000;
const MAX_MS = 60_000;
const JITTER = 0.2;

/**
 * `attempt` is how many retries this error streak has made (0 before the
 * first). `random` returns a number in [0, 1); a check passes a fixed one.
 */
export function retryDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(FIRST_MS * 2 ** Math.max(0, attempt), MAX_MS);
  return Math.round(base * (1 + JITTER * (2 * random() - 1)));
}
