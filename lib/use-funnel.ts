import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from './api';
import {
  EMPTY_DRAFT,
  flushDraft,
  needsReplay,
  readDraft,
  updateDraft,
  type DraftBasics,
  type DraftBasicsPartial,
  type DraftPlan,
  type OnboardingDraft,
} from './onboarding-draft';
import type { Catalog, OnboardingState } from './types';

/**
 * One funnel, two backing stores.
 *
 * Signed in, the funnel is the server's: `/api/mobile/onboarding` holds the
 * config and decides which step may open. Signed out, there is nothing to hold
 * it, so the same shape is synthesized from a local draft and the anonymous
 * catalogue - which is what lets a visitor walk steps 1-3 before creating an
 * account, exactly like the website.
 *
 * The step components do not know which one they are on. They read `state` and
 * call `act`, and this decides whether that becomes an HTTP POST or a write to
 * AsyncStorage.
 *
 * The draft is replayed onto the account the first time a session appears - see
 * `flushDraft`, which guards every part against what the server already holds so
 * a RETURNING customer signing in at the plan step does not get their configured
 * assistant overwritten by a guest draft. A replay that fails is reported as
 * `error` and re-run by the next `refresh` (the StaleNotice's Retry).
 */

export interface Funnel {
  /** True while there is no session, i.e. the draft is the source of truth. */
  guest: boolean;
  state: OnboardingState | null;
  loading: boolean;
  /** A signed-in first load is replaying a guest draft onto the account. */
  flushing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** The same bodies `/api/mobile/onboarding` takes. Routed by `guest`. */
  act: (body: Record<string, unknown>) => Promise<void>;
  /**
   * Plans, countries, dial codes and voices, from the anonymous catalogue so a
   * guest's pickers are populated too. Null until the first load settles.
   */
  catalog: Catalog | null;
  /** Which of step 1's questions to reopen on after an app kill or a mid-step sign-in. */
  resumeQuestion: number;
  /** Guest only: save step 1's answers so far. A no-op with a session. */
  saveBasicsPartial: (values: DraftBasicsPartial & { question: number }) => void;
  /** The plan picked on the guest plan step, carried through sign-up. */
  plan: DraftPlan | null;
  savePlan: (plan: DraftPlan) => Promise<void>;
  /** After a verified purchase: the choice has been used. */
  clearPlan: () => Promise<void>;
  /** Signed in: guest notes the replay could not send yet (no AI consent, or a failure). */
  pendingNotes: string[];
}

/**
 * What the funnel falls back to when the catalogue request fails. The discount
 * and per-minute rate match `lib/plans.ts`; they are only ever shown next to an
 * empty plan list, so they inform copy rather than a price.
 */
const EMPTY_CATALOG: Catalog = {
  plans: [],
  terms: { annualDiscount: 0.15, extraMinuteEur: 0.09 },
  countries: [],
  dialCodes: [],
  voices: [],
};

const FLUSH_ERROR = 'Some of what you set up before signing in has not been saved yet.';

/** A guest's typed notes, shaped like the server's source rows. */
function draftSources(draft: OnboardingDraft) {
  return draft.notes.map((text, i) => {
    const firstLine = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
    return {
      // Positional, because a guest note has no server id yet. Stable for as
      // long as the list is, which is all `remove-source` needs.
      id: `draft-${i}`,
      kind: 'text',
      title: firstLine ? firstLine.slice(0, 50) : 'What I told it',
      // No summary: summarizing is an AI call on the server, and a guest note
      // has not been near it yet. The row renders title-only until it flushes.
      summary: '',
    };
  });
}

/** The server's shape, built from a local draft plus the public catalogue. */
function synthesize(draft: OnboardingDraft, catalog: Catalog): OnboardingState {
  const basics: DraftBasics = draft.basics ?? {
    companyName: '',
    companyWebsite: '',
    assistantName: '',
    voiceId: '',
    voiceGender: 'f',
    // '' like the server's "not picked yet": the question applies the phone's
    // own region (countryForLocale) rather than whatever the list starts with.
    country: '',
    alertsEmail: '',
    alertPhone: '',
  };

  return {
    status: 'draft',
    step: draft.step,
    paid: false,
    done: false,
    hasAssistants: false,
    result: null,
    config: {
      ...basics,
      // Answers typed since step 1 was last submitted win: they are newer.
      ...draft.basicsPartial,
      // Derived from how far the draft got rather than stored twice - two
      // sources for "did they finish step 2" is one too many.
      knowledgeDone: draft.step > 2,
      calendarDone: draft.calendarPassed,
      sources: draftSources(draft),
    },
    // A guest cannot connect a calendar: OAuth consent is granted to an account
    // and there is not one yet.
    calendarsConnected: 0,
    countries: catalog.countries,
    plans: catalog.plans,
    planTerms: catalog.terms,
  };
}

/**
 * A guest who signs in from the header mid-way through step 1 keeps what they
 * typed: while the account has no basics yet, the unsent answers fill the
 * empty fields. Only non-empty ones, so nothing the server holds is blanked.
 */
function withPartial(server: OnboardingState, draft: OnboardingDraft | null): OnboardingState {
  const partial = draft?.basicsPartial;
  if (!partial || server.step !== 1) return server;
  const filled = Object.fromEntries(
    Object.entries(partial).filter(([, v]) => typeof v === 'string' && v !== ''),
  ) as DraftBasicsPartial;
  return { ...server, config: { ...server.config, ...filled } };
}

export function useFunnel(signedIn: boolean, email: string): Funnel {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [server, setServer] = useState<OnboardingState | null>(null);
  const [draft, setDraft] = useState<OnboardingDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flushing, setFlushing] = useState(false);

  // Signing in or out keeps this hook mounted (the funnel screen survives
  // sign-up), so the other mode's payload and error must not be shown as this
  // one's while the first load for it runs.
  const [mode, setMode] = useState(signedIn);
  if (mode !== signedIn) {
    setMode(signedIn);
    setServer(null);
    setError(null);
  }

  // Replayed once per session, and again only after a replay that did not
  // finish - see the end of `load`.
  const flushed = useRef(false);

  const load = useCallback(async () => {
    setError(null);

    // The catalogue is anonymous and cheap; both paths need it (the guest path
    // for its pickers, the signed-in path for the voice list).
    const catalogPromise = catalog ? Promise.resolve(catalog) : api.catalog();

    if (!signedIn) {
      // The draft is local and instant; the catalogue is a network round trip
      // bounded only by the API timeout. The draft lands first so the first
      // question is on screen while the pickers' data is still on its way -
      // and a guest with no catalogue still gets a funnel: the draft alone
      // drives the steps, and only the pickers come up empty.
      setDraft(await readDraft().catch(() => EMPTY_DRAFT));
      try {
        setCatalog(await catalogPromise);
      } catch (e) {
        setError((e as Error).message);
      }
      return;
    }

    try {
      const [nextCatalog, first] = await Promise.all([catalogPromise, api.onboarding()]);
      setCatalog(nextCatalog);
      let state = first;
      let flushError: string | null = null;

      if (!flushed.current) {
        const pending = await readDraft();
        if (needsReplay(pending)) {
          setFlushing(true);
          try {
            const result = await flushDraft(first, email);
            // Only a replay that finished is done with. 'ai-consent' is not an
            // error - the knowledge step asks for it and the next load sends
            // the notes - but it is not finished either.
            flushed.current = result.failed === null;
            if (result.failed !== null && result.failed !== 'ai-consent') flushError = FLUSH_ERROR;
            // Never the pre-flush state: showing it after a partial replay put
            // the user back on an empty step 1 with no word about why.
            state = await api.onboarding();
          } finally {
            setFlushing(false);
          }
        } else {
          flushed.current = true;
        }
      }

      setServer(state);
      setDraft(await readDraft());
      if (flushError) setError(flushError);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [catalog, signedIn, email]);

  useEffect(() => {
    // A new session gets its own replay.
    if (!signedIn) flushed.current = false;
    void load();
    // `load` closes over `catalog`, which it sets - depending on it here would
    // refetch forever. The session flipping is the only thing that should
    // re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  /** Apply one funnel action to the local draft. */
  const actLocally = useCallback(async (body: Record<string, unknown>) => {
    const str = (v: unknown) => (typeof v === 'string' ? v : '');

    const next = await updateDraft((current) => {
      const d: OnboardingDraft = { ...current };
      switch (body.action) {
        case 'basics':
          d.basics = {
            companyName: str(body.companyName),
            companyWebsite: str(body.companyWebsite),
            assistantName: str(body.assistantName) || 'Receptionist',
            voiceId: str(body.voiceId),
            voiceGender: body.voiceGender === 'm' ? 'm' : 'f',
            country: str(body.country).toUpperCase(),
            alertsEmail: str(body.alertsEmail),
            alertPhone: str(body.alertPhone),
          };
          // Submitted: the finished answers supersede the in-progress ones.
          d.basicsPartial = undefined;
          d.question = undefined;
          d.step = Math.max(d.step, 2);
          break;
        case 'add-text': {
          const text = str(body.text).trim();
          if (text) d.notes = [...d.notes, text];
          break;
        }
        case 'remove-source': {
          const index = Number(str(body.id).replace('draft-', ''));
          if (Number.isInteger(index)) {
            d.notes = d.notes.filter((_, i) => i !== index);
          }
          break;
        }
        case 'knowledge-done':
          d.step = Math.max(d.step, 3);
          break;
        case 'calendar-done':
          d.calendarPassed = true;
          d.step = Math.max(d.step, 4);
          break;
        case 'country':
          if (d.basics) d.basics = { ...d.basics, country: str(body.country).toUpperCase() };
          break;
        default:
          // An action the draft has no equivalent for (`provision`) can only be
          // reached with a session, so reaching it here is a routing bug, not a
          // user-facing one. Ignore rather than throw into a form's catch.
          break;
      }
      return d;
    });
    setDraft(next);
  }, []);

  const act = useCallback(
    async (body: Record<string, unknown>) => {
      if (signedIn) {
        await api.onboardingAction(body);
        // The answers a guest had in progress are the account's now.
        if (body.action === 'basics') {
          setDraft(await updateDraft((d) => ({ ...d, basicsPartial: undefined, question: undefined })));
        }
        return;
      }
      await actLocally(body);
    },
    [signedIn, actLocally],
  );

  // Storage only, no re-render: the questions hold their own state while they
  // are open, and this is read back when they next mount (after an app kill).
  const saveBasicsPartial = useCallback(
    ({ question, ...values }: DraftBasicsPartial & { question: number }) => {
      if (signedIn) return;
      void updateDraft((d) =>
        // A late save from a step already submitted must not reopen it.
        d.basics && d.step > 1 ? d : { ...d, basicsPartial: values, question },
      );
    },
    [signedIn],
  );

  const savePlan = useCallback(async (plan: DraftPlan) => {
    setDraft(await updateDraft((d) => ({ ...d, plan })));
  }, []);

  const clearPlan = useCallback(async () => {
    setDraft(await updateDraft((d) => ({ ...d, plan: undefined })));
  }, []);

  // Memoized so consumers that depend on it (the Android back handler) do not
  // re-subscribe on every render.
  const state = useMemo(
    () =>
      signedIn
        ? server && withPartial(server, draft)
        : draft
          ? // Catalogue unavailable: an empty one still renders every step, just
            // without countries, prices or voices to choose from.
            synthesize(draft, catalog ?? EMPTY_CATALOG)
          : null,
    [signedIn, server, draft, catalog],
  );

  return {
    guest: !signedIn,
    state,
    // First load for the current mode. A failed signed-in load is not loading
    // any more - it is an error with nothing to show, which the screen offers
    // a retry for.
    loading: signedIn ? server === null && error === null : draft === null,
    flushing,
    error,
    refresh: load,
    act,
    catalog,
    resumeQuestion:
      draft && draft.step === 1 && (!signedIn || (server?.step === 1 && draft.basicsPartial))
        ? (draft.question ?? 0)
        : 0,
    saveBasicsPartial,
    plan: draft?.plan ?? null,
    savePlan,
    clearPlan,
    pendingNotes: signedIn && draft ? draft.notes : [],
  };
}
