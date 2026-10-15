import AsyncStorage from '@react-native-async-storage/async-storage';

import { aiConsentGiven } from './ai-consent';
import { api } from './api';
import type { BillingCycle, OnboardingState } from './types';

/**
 * The guest half of the setup funnel.
 *
 * The website lets a visitor walk steps 1-3 before it asks for an account, and
 * the app now does the same. The difference is that the web throws the answers
 * away - `saveBasicsAction` is wrapped in `if (userId)` - so a guest who signs
 * in at the plan step retypes everything. There is no equivalent of a server
 * session to lean on here, so the draft is kept on the device and replayed to
 * `/api/mobile/onboarding` the moment a session exists.
 *
 * It holds more than the finished steps: step 1's answers are saved as they
 * are typed (`basicsPartial`, `question`), so an app kill or an Android back
 * press mid-question resumes where it stopped, and the plan picked on the guest
 * plan step (`plan`) survives sign-up so the signed-in plan step opens on it.
 *
 * AsyncStorage, not SecureStore: a company name and an assistant name are not
 * secrets, and the keychain's survive-a-reinstall behaviour would resurrect a
 * half-finished funnel for someone who deleted the app to escape it.
 *
 * Nothing here is load-bearing. Every read falls back to an empty draft and
 * every write is best-effort - a device that cannot persist still walks the
 * funnel, it just cannot leave and come back to it.
 */

const KEY = 'onboarding.draft';

export interface DraftBasics {
  companyName: string;
  companyWebsite: string;
  assistantName: string;
  voiceId: string;
  voiceGender: 'f' | 'm';
  country: string;
  alertsEmail: string;
  alertPhone: string;
}

/** Step 1's answers while it is still being filled in - any subset of them. */
export type DraftBasicsPartial = Partial<DraftBasics>;

/** The plan and cycle picked on the guest plan step. */
export interface DraftPlan {
  id: 'solo' | 'team';
  cycle: BillingCycle;
}

export interface OnboardingDraft {
  /** Furthest step unlocked by finishing the one before it, 1-4. */
  step: number;
  basics: DraftBasics | null;
  /** Step 1's answers so far, saved as they change. Cleared when step 1 is submitted. */
  basicsPartial?: DraftBasicsPartial;
  /** Which of step 1's five questions was open (0-4). */
  question?: number;
  /** Raw text the guest taught it. Summarized server-side on flush. */
  notes: string[];
  /** Whether step 3 was passed. Connecting a calendar needs an account. */
  calendarPassed: boolean;
  /** Survives the flush; cleared after a verified purchase. */
  plan?: DraftPlan;
}

export const EMPTY_DRAFT: OnboardingDraft = {
  step: 1,
  basics: null,
  notes: [],
  calendarPassed: false,
};

/** The transfer number's shape, exactly as the server checks it. */
const ALERT_PHONE = /^\+[1-9]\d{6,15}$/;

/** Whether a joined transfer number (dial code included) would pass the server's check. */
export function isValidAlertPhone(phone: string): boolean {
  return ALERT_PHONE.test(phone.replace(/[\s().-]/g, ''));
}

const STRING_KEYS = [
  'companyName',
  'companyWebsite',
  'assistantName',
  'voiceId',
  'country',
  'alertsEmail',
  'alertPhone',
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseBasics(value: unknown): DraftBasics | null {
  const o = asRecord(value);
  if (!o) return null;
  const s = (k: (typeof STRING_KEYS)[number]) => (typeof o[k] === 'string' ? (o[k] as string) : '');
  return {
    companyName: s('companyName'),
    companyWebsite: s('companyWebsite'),
    assistantName: s('assistantName'),
    voiceId: s('voiceId'),
    voiceGender: o.voiceGender === 'm' ? 'm' : 'f',
    country: s('country'),
    alertsEmail: s('alertsEmail'),
    alertPhone: s('alertPhone'),
  };
}

function parsePartial(value: unknown): DraftBasicsPartial | undefined {
  const o = asRecord(value);
  if (!o) return undefined;
  const out: DraftBasicsPartial = {};
  for (const k of STRING_KEYS) {
    if (typeof o[k] === 'string') out[k] = o[k] as string;
  }
  if (o.voiceGender === 'f' || o.voiceGender === 'm') out.voiceGender = o.voiceGender;
  return Object.keys(out).length > 0 ? out : undefined;
}

function parsePlan(value: unknown): DraftPlan | undefined {
  const o = asRecord(value);
  if (!o) return undefined;
  if ((o.id === 'solo' || o.id === 'team') && (o.cycle === 'monthly' || o.cycle === 'annual')) {
    return { id: o.id, cycle: o.cycle };
  }
  return undefined;
}

export async function readDraft(): Promise<OnboardingDraft> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return EMPTY_DRAFT;
    const parsed = asRecord(JSON.parse(raw));
    if (!parsed) return EMPTY_DRAFT;
    const question = parsed.question;
    return {
      step: Number.isInteger(parsed.step) ? Math.min(Math.max(parsed.step as number, 1), 4) : 1,
      basics: parseBasics(parsed.basics),
      basicsPartial: parsePartial(parsed.basicsPartial),
      question:
        Number.isInteger(question) && (question as number) >= 0 && (question as number) <= 4
          ? (question as number)
          : undefined,
      notes: Array.isArray(parsed.notes)
        ? parsed.notes.filter((n): n is string => typeof n === 'string')
        : [],
      calendarPassed: Boolean(parsed.calendarPassed),
      plan: parsePlan(parsed.plan),
    };
  } catch {
    // A draft that will not parse is a draft that was never worth keeping.
    return EMPTY_DRAFT;
  }
}

async function writeDraft(draft: OnboardingDraft): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(draft));
  } catch {
    // The funnel still works in memory for this run.
  }
}

export async function clearDraft(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {
    // `flushDraft` guards on server state, so a draft that outlives its flush
    // is re-checked and skipped rather than replayed.
  }
}

/** Anything worth keeping at all. */
function hasContent(d: OnboardingDraft): boolean {
  return (
    d.step > 1 ||
    d.basics !== null ||
    d.basicsPartial !== undefined ||
    d.question !== undefined ||
    d.notes.length > 0 ||
    d.calendarPassed ||
    d.plan !== undefined
  );
}

/**
 * Anything the account does not have yet. The partial answers and the plan
 * choice are not replayed - they are read back by the screens instead.
 */
export function needsReplay(d: OnboardingDraft): boolean {
  return d.basics !== null || d.notes.length > 0 || d.step > 2 || d.calendarPassed;
}

/**
 * Every write goes through here, one at a time. The partial answers are saved
 * on a debounce while a step's submit writes the same key; two unserialized
 * read-modify-writes let the older one land last and put step 1 back.
 */
let queue: Promise<unknown> = Promise.resolve();

export function updateDraft(
  change: (draft: OnboardingDraft) => OnboardingDraft,
): Promise<OnboardingDraft> {
  const run = queue.then(async () => {
    const next = change(await readDraft());
    if (hasContent(next)) await writeDraft(next);
    else await clearDraft();
    return next;
  });
  queue = run.catch(() => undefined);
  return run;
}

/** Which part of the replay stopped it, or null when everything landed. */
export type FlushFailure = 'basics' | 'notes' | 'knowledge' | 'calendar' | 'ai-consent';

export interface FlushResult {
  /** Anything reached the server. */
  wrote: boolean;
  failed: FlushFailure | null;
}

/**
 * One replay at a time, shared. Signing up can mount the funnel twice (the
 * screen under the sign-in route and the one it is replaced with), and two
 * replays reading the same draft each POSTed every action - a note taught
 * once arrived twice.
 */
let inflight: Promise<FlushResult> | null = null;

/**
 * Replay a guest draft onto the account that just signed in.
 *
 * Every part is guarded against what the server already holds, because the
 * person signing in at the plan step is very often a RETURNING customer whose
 * account is already configured - replaying a draft over that would rename their
 * assistant and re-open a finished funnel. So: basics only when the account has
 * none, notes only while knowledge is unfinished, and the "done" flags only
 * when they are not already set.
 *
 * A failure stops the replay and leaves what did not land in the draft - each
 * note is removed from it as it succeeds, so a retry never sends one twice -
 * and the draft is only cleared once every part is in. The plan choice is kept
 * through that: the signed-in plan step opens on it.
 */
export function flushDraft(state: OnboardingState, email: string): Promise<FlushResult> {
  if (!inflight) {
    inflight = replay(state, email).finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

async function replay(state: OnboardingState, email: string): Promise<FlushResult> {
  const draft = await readDraft();
  if (!needsReplay(draft)) return { wrote: false, failed: null };
  // A finished account goes straight to the app and never reads its setup
  // profile again, so replaying onto it only costs AI calls and a wait.
  if (state.done) {
    await updateDraft((d) => ({ ...EMPTY_DRAFT, plan: d.plan }));
    return { wrote: false, failed: null };
  }
  let wrote = false;

  // `step === 1` means the account has neither a business nor an assistant name.
  if (draft.basics && state.step === 1) {
    const phone = draft.basics.alertPhone.replace(/[\s().-]/g, '');
    try {
      await api.onboardingAction({
        action: 'basics',
        ...draft.basics,
        // A guest had no address to give; the account's own one is the
        // summaries address from now on, as it would have been on the web.
        alertsEmail: draft.basics.alertsEmail || email || '',
        // The server rejects the whole request over a malformed number. The
        // question now checks it, but a draft written before that did not.
        alertPhone: phone && isValidAlertPhone(phone) ? phone : '',
      });
      wrote = true;
    } catch {
      return { wrote, failed: 'basics' };
    }
  }

  if (!state.config.knowledgeDone) {
    if (draft.notes.length > 0) {
      // Teaching goes through Gemini on the server (5.1.2(i)). The notes stay
      // in the draft, unsent, and the knowledge step shows them as waiting -
      // which is also why knowledge is not marked done below.
      if (!(await aiConsentGiven())) return { wrote, failed: 'ai-consent' };
      for (const text of draft.notes) {
        try {
          await api.onboardingAction({ action: 'add-text', text });
        } catch {
          return { wrote, failed: 'notes' };
        }
        wrote = true;
        await updateDraft((d) => {
          const i = d.notes.indexOf(text);
          return i < 0 ? d : { ...d, notes: d.notes.filter((_, j) => j !== i) };
        });
      }
    }
    if (draft.step > 2) {
      try {
        await api.onboardingAction({ action: 'knowledge-done' });
        wrote = true;
      } catch {
        return { wrote, failed: 'knowledge' };
      }
    }
  }

  // A guest could not connect anything, so "passed the calendar step" meant
  // "had no choice" - but showing them the step AGAIN after sign-up, with the
  // progress bar stepping backwards, read as the funnel losing its place. The
  // step is passed once; Home's "Calendar isn't connected" row and the
  // Connected calendars screen offer the real Connect rows from then on.
  if (draft.calendarPassed && !state.config.calendarDone) {
    try {
      await api.onboardingAction({ action: 'calendar-done' });
      wrote = true;
    } catch {
      return { wrote, failed: 'calendar' };
    }
  }

  await updateDraft((d) => ({ ...EMPTY_DRAFT, plan: d.plan }));
  return { wrote, failed: null };
}
