/** Whole seconds left until `deadline` (ms since epoch); 0 once it has passed. */
export function secondsLeft(deadline: number, now: number = Date.now()): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}
