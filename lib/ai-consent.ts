import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useState } from 'react';

/**
 * The user's explicit permission for their business details, what they teach
 * the receptionist and their calls to be processed by third-party AI services
 * (ElevenLabs for the voice, Google Gemini for understanding).
 *
 * Asked once, before the first thing that reaches those services: the funnel's
 * knowledge step, the plan step and the Knowledge teach sheet all gate on it
 * through `AiConsent` in components/paywall.tsx. Stored on the device only -
 * it is the app's own record of having asked, not a server-side agreement -
 * and cleared with the account's other local traces after a deletion
 * (context/AuthContext.tsx).
 *
 * Every read falls back to "not given" and every write is best-effort: a
 * device that cannot persist is asked again next time, which is the safe
 * direction to fail in.
 */

const KEY = 'ai.consent.v1';

export async function aiConsentGiven(): Promise<boolean> {
  try {
    const value = await AsyncStorage.getItem(KEY);
    return Boolean(value);
  } catch {
    return false;
  }
}

export async function setAiConsentGiven(): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, new Date().toISOString());
  } catch {
    // Asked again next time.
  }
}

/** `given` is null until the stored value has been read. */
export function useAiConsent(): { given: boolean | null; give: () => Promise<void> } {
  const [given, setGiven] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    void aiConsentGiven().then((value) => {
      if (alive) setGiven(value);
    });
    return () => {
      alive = false;
    };
  }, []);

  const give = useCallback(async () => {
    setGiven(true);
    await setAiConsentGiven();
  }, []);

  return { given, give };
}
