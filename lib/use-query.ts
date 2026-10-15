import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { ApiError } from './api';
import { markSessionEnded } from './session-ended';
import { supabase } from './supabase';

/** How long a payload counts as fresh enough to skip a refetch on focus. */
const STALE_MS = 10_000;

interface QueryState<T> {
  data: T | null;
  error: string | null;
  /**
   * The HTTP status behind `error` (0 = no connection / timeout), or null when
   * the last attempt succeeded or failed without one. Lets a screen tell "this
   * call no longer exists" (404) apart from "try again".
   */
  errorStatus: number | null;
  /** First load only. Refreshes keep the previous data on screen. */
  loading: boolean;
  /** A pull-to-refresh the user started. Background revalidation never sets it. */
  refreshing: boolean;
  refresh: () => Promise<void>;
}

/**
 * How a fetch was started, which decides what the screen shows while it runs:
 * 'load' the first-load state, 'pull' the pull-to-refresh spinner, 'silent'
 * nothing at all - it just swaps the data (or the error) when it lands.
 */
type RunMode = 'load' | 'pull' | 'silent';

/**
 * The app's whole data layer: fetch on focus, pull to refresh, keep the last
 * good payload while refetching.
 *
 * Deliberately not react-query. There are seven read endpoints, no mutations
 * worth caching, and no cross-screen cache sharing to speak of - the dependency
 * would be larger than the thing it replaces.
 *
 * "On focus" is load-bearing, and used not to be true: this hook fetched once
 * on mount, and a tab navigator keeps every tab mounted forever. So a call that
 * arrived while you were on Settings was still missing from Calls minutes later
 * unless you thought to pull down, while the same account on the web - every
 * dashboard route is `force-dynamic` - showed it on the next click. Refetching
 * when a screen comes forward is what makes the two surfaces agree.
 *
 * Guarded by STALE_MS so flicking between tabs does not fire a request per tap;
 * a payload seconds old is not worth re-fetching. Those refetches are silent:
 * a RefreshControl spinning on its own every time you switch tabs reads as the
 * app doing something you did not ask for.
 *
 * A 401 signs the user out rather than showing an error: the only way to get
 * one is an expired or revoked session, and leaving them staring at "Not signed
 * in" with no way to act on it is worse than bouncing to the sign-in screen. A
 * status 0 (offline, or a token refresh that could not reach the server) is a
 * connection problem, not a lost session, and stays an error.
 */
export function useQuery<T>(
  fetcher: () => Promise<T>,
  deps: readonly unknown[] = [],
): QueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Guards a setState after unmount, and lets a slow first response lose to a
  // fast refresh instead of overwriting it.
  const generation = useRef(0);
  const mounted = useRef(true);
  /** When the last load attempt finished. 0 = none has. */
  const fetchedAt = useRef(0);
  /** Whether this screen is the focused one. Only it revalidates on foreground. */
  const focused = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async (mode: RunMode) => {
      const gen = ++generation.current;
      if (mode === 'load') setLoading(true);
      if (mode === 'pull') setRefreshing(true);
      try {
        const next = await fetcher();
        if (!mounted.current || gen !== generation.current) return;
        setData(next);
        setError(null);
        setErrorStatus(null);
      } catch (err) {
        if (!mounted.current || gen !== generation.current) return;
        if (err instanceof ApiError && err.status === 401) {
          // Noted first, so the sign-in screen the root layout opens can say
          // why rather than leaving the user to wonder what they did.
          markSessionEnded();
          void supabase.auth.signOut();
          return;
        }
        setError(err instanceof Error ? err.message : 'Something went wrong.');
        setErrorStatus(err instanceof ApiError ? err.status : null);
      } finally {
        if (mounted.current && gen === generation.current) {
          // Both, whatever the mode: a newer run supersedes an older one, and
          // the older one's spinner must not outlive it.
          setLoading(false);
          setRefreshing(false);
          // The ATTEMPT time, not the success time. A screen that failed to
          // load should still retry when you come back to it - the usual cause
          // is a network that was down while the phone was in a pocket - and
          // recording only successes would leave it stuck on its error card
          // until someone found the Retry button.
          fetchedAt.current = Date.now();
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    deps,
  );

  useEffect(() => {
    fetchedAt.current = 0;
    void run('load');
  }, [run]);

  const refresh = useCallback(() => run('pull'), [run]);

  /**
   * Refetch when the screen comes forward, unless what we have is fresh.
   *
   * Silent, not a load: `loading` would blank a screen that already has
   * perfectly good data on it, and `refreshing` would spin a pull-to-refresh
   * nobody pulled.
   */
  const revalidate = useCallback(() => {
    if (fetchedAt.current === 0) return; // first load is already in flight
    if (Date.now() - fetchedAt.current < STALE_MS) return;
    void run('silent');
  }, [run]);

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      revalidate();
      return () => {
        focused.current = false;
      };
    }, [revalidate]),
  );

  // Foregrounding the app is the other moment the data is most likely stale -
  // a phone in a pocket for an hour comes back to a screen from an hour ago.
  // Only the focused screen refetches: every tab stays mounted, and without the
  // check one foreground fired a request for each of them.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && focused.current) revalidate();
    });
    return () => sub.remove();
  }, [revalidate]);

  return { data, error, errorStatus, loading, refreshing, refresh };
}
