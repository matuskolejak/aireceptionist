import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { api } from './api';

/**
 * "Is the receptionist on a call right now?"
 *
 * The product's whole pitch is that something answers the phone while you are
 * busy, and the one thing a dashboard cannot do is tell you it is happening as
 * it happens. This is the poll behind that.
 *
 * Three rules keep it off the battery:
 *   - only while the screen is focused (`useFocusEffect`),
 *   - only while the app is in the foreground (`AppState`) - a timer left
 *     running in the background is throttled into uselessness anyway and still
 *     wakes the radio,
 *   - against `/api/mobile/notifications?live=1`, which answers with the id
 *     alone rather than also assembling the activity list.
 */
const INTERVAL_MS = 15_000;

export function useLiveCall(): string | null {
  const [callId, setCallId] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const check = useCallback(async () => {
    try {
      const { activeCallId } = await api.liveCall();
      setCallId(activeCallId ?? null);
    } catch {
      // A failed poll is not worth surfacing: the banner it feeds is additive,
      // and every other part of the screen reports its own errors already.
    }
  }, []);

  const stop = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }, []);

  const start = useCallback(() => {
    stop();
    void check();
    timer.current = setInterval(() => void check(), INTERVAL_MS);
  }, [check, stop]);

  // The AppState listener lives inside the focus effect on purpose. A tab
  // navigator keeps a blurred screen mounted, so a listener registered for the
  // lifetime of the hook would re-arm the interval on every foreground while
  // the user sits on another tab - and nothing would ever clear it, because the
  // blur that owns `stop()` has already happened and will not happen again.
  useFocusEffect(
    useCallback(() => {
      start();
      // Foregrounding after a while is exactly when the answer is most likely
      // to have changed, so check immediately rather than waiting out the
      // interval.
      const sub = AppState.addEventListener('change', (state) => {
        if (state === 'active') start();
        else stop();
      });
      return () => {
        sub.remove();
        stop();
      };
    }, [start, stop]),
  );

  return callId;
}
