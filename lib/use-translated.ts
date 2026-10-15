import { useEffect, useMemo, useRef, useState } from 'react';

import { api } from './api';

/**
 * Showing a call's words in the app's language - the port of the web's
 * `lib/i18n/use-translated.ts`.
 *
 * A caller who spoke Spanish left a Spanish summary, Spanish claims and a
 * Spanish transcript, and the owner reading it in English on the web gets a
 * translation there. The app is English-only, so the target is always 'en'
 * (the route accepts only a bare web locale - 'en-US' is a 400).
 *
 * One request per piece of content: the caller hands every text on the screen
 * over at once, the promise is cached here by locale and a hash of the texts,
 * and the server caches the whole batch + locale on top. Content that has
 * stopped changing (a finished call, English or not) is therefore a cache hit
 * on the server once translated, but every debounced change during a live
 * call is a new batch - a full model call over all of its turns. A failure (a thrown error
 * or `ok: false`, where the server hands back the originals) is evicted so a
 * later visit retries, and the screen keeps the originals meanwhile.
 *
 * `debounceMs` is for a call still in progress. Each new transcript turn
 * changes the hash, so the content has to hold still that long before it is
 * sent - a burst of polls is one request, not one per poll. A new key cancels
 * only the pending timer: a request already sent still lands (as the earlier
 * translation, when the content has moved on since), so a slow reply is never
 * thrown away. Meanwhile the texts that did not change keep that earlier
 * translation, so a live transcript does not flip back to the original
 * language every time a turn arrives.
 */

export const TRANSLATE_LOCALE = 'en';

const cache = new Map<string, Promise<string[] | null>>();

/** A cheap content hash: the web's 31-multiplier over the JSON, plus its length. */
function hashTexts(texts: string[]): string {
  const joined = JSON.stringify(texts);
  let h = 0;
  for (let i = 0; i < joined.length; i++) h = (h * 31 + joined.charCodeAt(i)) | 0;
  return `${h}:${joined.length}`;
}

/** The translated texts, or null when the server could not translate them. */
function translateOnce(texts: string[], key: string): Promise<string[] | null> {
  let promise = cache.get(key);
  if (!promise) {
    promise = api.translate(texts, TRANSLATE_LOCALE).then(
      (res) => {
        if (!res.ok || !Array.isArray(res.texts) || res.texts.length !== texts.length) {
          cache.delete(key);
          return null;
        }
        return res.texts.map((s, i) => (typeof s === 'string' && s.trim() ? s : texts[i]));
      },
      () => {
        cache.delete(key);
        return null;
      },
    );
    cache.set(key, promise);
  }
  return promise;
}

export function useTranslated(
  texts: string[],
  { enabled = true, debounceMs = 0 }: { enabled?: boolean; debounceMs?: number } = {},
): {
  /** What to show: the translation once it is in, else the originals. */
  texts: string[];
  /** A request for the current content is pending with nothing earlier to show. */
  translating: boolean;
  /** The translation differs from the originals somewhere - worth a toggle. */
  hasTranslation: boolean;
} {
  const contentKey = useMemo(() => (texts.length > 0 ? hashTexts(texts) : ''), [texts]);
  const key = enabled && contentKey ? `${TRANSLATE_LOCALE}:${contentKey}` : '';

  // The effect keys on the content hash, not the array: a refetch hands over
  // a new array with the same words, and that must not re-run anything.
  const textsRef = useRef(texts);
  textsRef.current = texts;

  const [ready, setReady] = useState<{
    key: string;
    originals: string[];
    texts: string[] | null;
  } | null>(null);

  // Sent requests outlive a key change (only the debounce timer is
  // cancelled), so their replies are guarded by mount, and by send order so a
  // slow older reply never replaces a newer one that already landed.
  const mounted = useRef(true);
  const sentSeq = useRef(0);
  const landedSeq = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!key) return;
    const run = () => {
      const originals = textsRef.current;
      const seq = ++sentSeq.current;
      void translateOnce(originals, key).then((out) => {
        if (!mounted.current || seq < landedSeq.current) return;
        landedSeq.current = seq;
        // A failed newer batch keeps the last good translation, so a live
        // transcript does not fall back to the original language on one miss.
        setReady((prev) => (out === null && prev?.texts ? prev : { key, originals, texts: out }));
      });
    };
    if (debounceMs <= 0) {
      run();
      return;
    }
    const timer = setTimeout(run, debounceMs);
    return () => clearTimeout(timer);
  }, [debounceMs, key]);

  const current = ready && ready.key === key ? ready : null;
  // While newer content is pending, reuse the last translation for every text
  // that is still word for word what was translated.
  const earlier = !current && key && ready?.texts ? ready : null;
  let shown = texts;
  if (current?.texts) shown = current.texts;
  else if (earlier?.texts) {
    const prior = earlier.texts;
    shown = texts.map((t, i) => (earlier.originals[i] === t ? (prior[i] ?? t) : t));
  }
  return {
    texts: shown,
    translating: Boolean(key) && !current && !earlier,
    hasTranslation: shown.some((s, i) => s.trim() !== (texts[i] ?? '').trim()),
  };
}
