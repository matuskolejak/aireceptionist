import { isAuthSessionMissingError } from '@supabase/supabase-js';

import { deviceId } from './device';
import { deviceTimeZone } from './locale';
import { supabase } from './supabase';
import type {
  Account,
  AssistantDetail,
  AssistantPatch,
  AssistantSummary,
  BillingSnapshot,
  CalendarConnections,
  CalendarState,
  AccountDevice,
  CallDetail,
  CallLog,
  DeleteAccountResult,
  KnowledgeState,
  NotificationItem,
  OnboardingState,
  Catalog,
  Overview,
  ProvisionPoll,
  PurchaseContext,
  SettingsState,
  VoiceCatalog,
} from './types';

const BASE = (process.env.EXPO_PUBLIC_API_URL ?? '').replace(/\/+$/, '');

export const apiConfigured = BASE.length > 0;

/**
 * Raised for any non-2xx response. `status` is kept so callers can tell the two
 * cases that need different UI apart: 401 means the session is gone (sign the
 * user out), everything else is a transient failure worth a Retry button.
 * Status 0 is "never got an answer": offline, timed out, or a response that
 * was not ours (a captive portal's HTML).
 *
 * `code` is the server's machine-readable reason, when it sent one (every
 * route answers `{ error, code? }`). Branch on it, never on the message:
 *   409 billing apple/verify, google/sync: 'stripe_active' | 'other_account'
 *   403 assistants/[id]/number: 'plan_required' | 'limit_reached' | 'sandbox' | 'unverified'
 * e.g. `e instanceof ApiError && e.code === 'stripe_active'`.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function accessToken(): Promise<string | null> {
  // getSession() refreshes an expired token before returning, so this is also
  // the app's refresh point on a cold foreground.
  const { data, error } = await supabase.auth.getSession();
  // A refresh that could not reach the server comes back as an error with no
  // session. Reading that as "signed out" turned every offline foreground into
  // a 401 - and useQuery signs the user out on a 401. It is a connection
  // problem; only a session that is genuinely missing is null.
  if (error && !isAuthSessionMissingError(error)) {
    throw new ApiError(0, 'No connection.');
  }
  return data.session?.access_token ?? null;
}

const TIMEOUT_MS = 20_000;
// Provisioning and test calls reach ElevenLabs and Twilio, which are slower than
// anything else the app talks to. A 20s cap aborts them mid-flight and the user
// retries an operation that was actually still running.
const SLOW_TIMEOUT_MS = 60_000;

export type RequestOptions = RequestInit & { slow?: boolean; anon?: boolean };

/**
 * `anon: true` skips the bearer check for the routes that have none
 * (/api/mobile/catalog, /api/mobile/auth/review). They exist because the setup
 * funnel and sign-in run before there is a session - see app/onboarding.tsx.
 * Never set it on a route that reads user data: the token would simply be
 * omitted and the request would 401 at best, or read nothing at worst.
 */
async function request<T>(path: string, init?: RequestOptions): Promise<T> {
  // Dev-only mock backend (EXPO_PUBLIC_MOCK=1, see lib/mock/server.ts). Written
  // inline, with the require inside the branch, so a release build folds
  // `__DEV__` to false and drops both the branch and the whole lib/mock tree.
  if (__DEV__ && process.env.EXPO_PUBLIC_MOCK === '1') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('./mock/server') as typeof import('./mock/server')).mockRequest<T>(path, init);
  }

  if (!apiConfigured) {
    throw new ApiError(0, 'EXPO_PUBLIC_API_URL is not set. See .env.example.');
  }

  let token: string | null = null;
  if (!init?.anon) {
    token = await accessToken();
    if (!token) throw new ApiError(401, 'Not signed in.');
  }

  // Sent on every call, signed in or not, so the server can tie this install to
  // the account behind the token. Resolved from the keychain rather than minted
  // per request; a failure here must not cost the user the request, so it falls
  // back to no header and the server just records nothing.
  const device = await deviceId().catch(() => null);

  // A phone drops off a network mid-request far more often than a browser does,
  // and RN's fetch has no default timeout - without this the UI spins forever.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), init?.slow ? SLOW_TIMEOUT_MS : TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      signal: abort.signal,
      headers: {
        ...(init?.headers ?? {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(device ? { 'X-Device-Id': device } : {}),
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    const aborted = (err as Error)?.name === 'AbortError';
    throw new ApiError(0, aborted ? 'The request timed out.' : 'No connection.');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // The server sends { error, code? } for its own failures, but a proxy or a
    // misconfigured EXPO_PUBLIC_API_URL can return HTML - so never assume JSON.
    const body = await res
      .json()
      .then((b: { error?: unknown; code?: unknown }) => b)
      .catch(() => null);
    const message = typeof body?.error === 'string' && body.error ? body.error : null;
    // A 5xx is the server's problem, and its own words for it ("Failed to
    // fetch assistant", a proxy's HTML) are not something a person can act on.
    // A 503 with a JSON message is the exception: the server writes those for
    // people ("Billing is not configured yet", "Can't check your sign-in").
    // The code still travels, for the callers that branch on it.
    const ownWords = res.status < 500 || (res.status === 503 && message != null);
    throw new ApiError(
      res.status,
      ownWords
        ? (message ?? 'Something went wrong. Try again.')
        : 'Something went wrong on our side. Try again.',
      typeof body?.code === 'string' ? body.code : undefined,
    );
  }

  // 204 and an empty body both parse as a failure, and several writes return
  // nothing worth reading.
  const text = await res.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    // A 200 that is not JSON is somebody else's page - hotel and airport
    // Wi-Fi answer every request with their login form. The raw SyntaxError
    // ("JSON Parse error: Unexpected character: <") means nothing to anyone.
    throw new ApiError(0, 'Unexpected response - check your connection.');
  }
}

/** The filter chips' "no filter" value, which the server also treats as absent. */
const SENTINEL_KEYS = new Set(['status', 'direction']);

function query(params: Record<string, string | undefined>): string {
  // Only the filter keys may drop 'all'. Applying the sentinel to every param
  // means searching for the literal text "all" sends no `q` at all, and the
  // list comes back unfiltered while the search box still reads "all".
  const entries = Object.entries(params).filter(
    ([k, v]) => v && !(SENTINEL_KEYS.has(k) && v === 'all'),
  );
  if (entries.length === 0) return '';
  return `?${entries.map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`).join('&')}`;
}

const post = <T>(path: string, body?: unknown, slow?: boolean) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}), slow });

/** Every write that can partly succeed answers in this shape. */
export interface WriteResult {
  ok?: boolean;
  warning?: string | null;
}

/** POST /api/mobile/billing/apple/verify. `jws` is the StoreKit 2 signed transaction. */
export interface AppleVerifyBody {
  jws: string;
  /** Required (true) for 'onboarding' and 'pricing'. */
  acceptedTerms?: boolean;
  context?: PurchaseContext;
}

/** POST /api/mobile/billing/google/sync. The server reads the purchase from RevenueCat itself. */
export interface GoogleSyncBody {
  /** Required (true) for 'onboarding' and 'pricing'. */
  acceptedTerms?: boolean;
  context?: PurchaseContext;
  /** Sent only by the __DEV__ purchase mock; the real server ignores it. */
  debugProductId?: string;
}

/** A session minted by the App Review sign-in route, for `supabase.auth.setSession`. */
export interface ReviewTokens {
  access_token: string;
  refresh_token: string;
}

/** A one-time signed URL into the web app. */
export interface WebLinkResult {
  url: string;
  signedIn: boolean;
}

/**
 * A one-time signed URL that opens the web app already signed in, for the one
 * thing a phone cannot do in-process: calendar OAuth consent. The browser ends
 * on `returnUrl` (an app-scheme URL) with `connected=1` or `error=<slug>`.
 *
 * The result IS a credential until it is redeemed - open it immediately, never
 * store or log it. There is no billing, checkout or dashboard handoff: the app
 * sells through the stores, and a link out to a web purchase is what store
 * review rejects.
 */
function webLink(req: { target: 'calendar'; provider: string; returnUrl: string }): Promise<WebLinkResult> {
  return post<WebLinkResult>('/api/mobile/web-link', req);
}

export const api = {
  /**
   * `range: 'month'` adds the 30-day rollup, mirroring `/dashboard?range=month`.
   * `tz` as for `calendar`: "today" and every time label fall back to the
   * phone's zone, not UTC, while the account has none saved.
   */
  overview: (range?: 'today' | 'month', tz: string = deviceTimeZone()) =>
    request<Overview>(
      `/api/mobile/overview${query({ range: range === 'month' ? 'month' : undefined, tz })}`,
    ),

  /**
   * One page of the call log, newest first. Pass the previous page's
   * `nextCursor` as `before` for the next one; `limit` defaults to 50 on the
   * server (max 100). No `direction` filter: /api/mobile/calls is inbound-only
   * by design, matching /dashboard/calls.
   *
   * No locale is sent: every label the app shows is formatted here from the
   * raw fields and the owner `timezone`, in English like the rest of the app.
   * `tz` as for `calendar`.
   */
  calls: (
    filters: { q?: string; status?: string; before?: string; limit?: number } = {},
    tz: string = deviceTimeZone(),
  ) =>
    request<CallLog>(
      `/api/mobile/calls${query({
        status: filters.status,
        q: filters.q,
        before: filters.before,
        limit: filters.limit != null ? String(filters.limit) : undefined,
        tz,
      })}`,
    ),

  /** `tz` as for `calendar`. */
  call: (id: string, tz: string = deviceTimeZone()) =>
    request<CallDetail>(`/api/mobile/calls/${id}${query({ tz })}`),

  reportCall: (id: string, message: string) =>
    post<WriteResult>(`/api/mobile/calls/${id}/report`, { message }),

  /**
   * An expo-audio source for a call's audio.
   *
   * The recording has no public URL by design - it is proxied from ElevenLabs
   * behind this user's bearer token - so the player is handed the header rather
   * than a signed link. Async because the token may need a refresh first, and
   * `null` when the session has gone, so the caller shows nothing rather than a
   * player that 401s on play.
   */
  recordingSource: async (
    id: string,
  ): Promise<{ uri: string; headers: Record<string, string> } | null> => {
    if (__DEV__ && process.env.EXPO_PUBLIC_MOCK === '1') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return (require('./mock/server') as typeof import('./mock/server')).mockRecordingSource(id);
    }
    const token = await accessToken().catch(() => null);
    if (!token || !apiConfigured) return null;
    return {
      uri: `${BASE}/api/mobile/calls/${id}/recording`,
      headers: { Authorization: `Bearer ${token}` },
    };
  },

  /** Text the caller back from the line they rang. */
  textBack: (id: string, message: string) =>
    post<WriteResult>(`/api/mobile/calls/${id}/text`, { message }),

  /**
   * Translate transcript text for display. `ok: false` means the texts came
   * back untranslated (the server returns the originals) - show them as-is.
   * Slow: it is a model call when the server has no cached copy.
   */
  translate: (texts: string[], locale: string) =>
    request<{ texts: string[]; ok: boolean }>('/api/mobile/translate', {
      method: 'POST',
      body: JSON.stringify({ texts, locale }),
      slow: true,
    }),

  /**
   * Bookings and external events. `tz` (the phone's zone by default) is what
   * the server falls back to when the account has no zone saved - then
   * `timezoneIsAccount` is false and the screen should say so.
   */
  calendar: (tz: string = deviceTimeZone()) =>
    request<CalendarState>(`/api/mobile/calendar${query({ tz })}`),

  calendarConnections: () =>
    request<CalendarConnections>('/api/mobile/calendar/connections'),

  setPrimaryCalendar: (id: string) =>
    request<WriteResult>(`/api/mobile/calendar/connections/${id}`, { method: 'PATCH' }),

  disconnectCalendar: (id: string) =>
    request<WriteResult>(`/api/mobile/calendar/connections/${id}`, { method: 'DELETE' }),

  /** 409 when the booking is already cancelled or has no date yet (a request to confirm). */
  cancelBooking: (actionId: string, reason: string, offerRebook: boolean) =>
    post<WriteResult>(`/api/mobile/calendar/bookings/${actionId}`, {
      action: 'cancel',
      reason,
      offerRebook,
    }),

  retryBooking: (actionId: string) =>
    post<WriteResult>(`/api/mobile/calendar/bookings/${actionId}`, { action: 'retry' }),

  assistants: () =>
    request<{ assistants: AssistantSummary[] }>('/api/mobile/assistants'),

  /** `tz` as for `calendar`: the fallback display zone when the account has none. */
  assistant: (id: string, tz: string = deviceTimeZone()) =>
    request<AssistantDetail>(`/api/mobile/assistants/${id}${query({ tz })}`),

  createAssistant: (name: string) =>
    post<{ id: string; warning: string | null }>('/api/mobile/assistants', { name }),

  /**
   * Save part of an assistant. `patch.sections` must name every section the
   * screen carried - see the note on `SECTION` in lib/types.ts. Slow because it
   * awaits a full ElevenLabs agent re-sync, exactly like the web save does.
   */
  saveAssistant: (id: string, patch: AssistantPatch) =>
    request<WriteResult>(`/api/mobile/assistants/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
      slow: true,
    }),

  deleteAssistant: (id: string) =>
    request<WriteResult>(`/api/mobile/assistants/${id}`, { method: 'DELETE', slow: true }),

  setAssistantPower: (id: string, enabled: boolean) =>
    post<{ id: string; enabled: boolean }>(`/api/mobile/assistants/${id}/power`, { enabled }),

  /**
   * 403 carries `code`: 'plan_required' (offer the paywall), 'limit_reached'
   * (offer an upgrade), 'sandbox' (a test purchase - no live numbers) or
   * 'unverified' (the plan check itself failed - retry).
   */
  getAssistantNumber: (id: string, country: string) =>
    post<{ e164: string; id: string }>(`/api/mobile/assistants/${id}/number`, { country }, true),

  unlinkAssistantNumber: (id: string) =>
    request<WriteResult>(`/api/mobile/assistants/${id}/number`, {
      method: 'DELETE',
      slow: true,
    }),

  testCall: (id: string, to: string) =>
    post<WriteResult>(`/api/mobile/assistants/${id}/test-call`, { to }, true),

  voices: () => request<VoiceCatalog>('/api/mobile/voices'),

  knowledge: (business?: string) =>
    request<KnowledgeState>(`/api/mobile/knowledge${query({ business })}`),

  saveKnowledgeNotes: (business: string, notes: string, verified: string) =>
    post<WriteResult>('/api/mobile/knowledge', { business, action: 'notes', notes, verified }),

  addKnowledgeWebsite: (business: string, url: string) =>
    post<WriteResult>('/api/mobile/knowledge', { business, action: 'website', url }, true),

  addKnowledgeText: (business: string, text: string) =>
    post<WriteResult>('/api/mobile/knowledge', { business, action: 'text', text }, true),

  /**
   * Answer one "question it could not answer": the pair joins the verified
   * answers and the gap leaves the list. 404 when it was already answered or
   * dismissed (on the web, or a second tap).
   */
  knowledgeAnswerGap: (business: string, signalId: number, answer: string) =>
    post<WriteResult>('/api/mobile/knowledge', { business, action: 'answerGap', signalId, answer }),

  knowledgeDismissGap: (business: string, signalId: number) =>
    post<WriteResult>('/api/mobile/knowledge', { business, action: 'dismissGap', signalId }),

  removeKnowledgeSource: (business: string, source: string) =>
    request<WriteResult>(
      `/api/mobile/knowledge${query({ business: business || undefined, source })}`,
      { method: 'DELETE' },
    ),

  settings: () => request<SettingsState>('/api/mobile/settings'),

  saveSettings: (patch: Record<string, string | boolean>) =>
    request<WriteResult>('/api/mobile/settings', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  account: () => request<Account>('/api/mobile/account'),

  /**
   * Delete the account and everything in it. Slow: it releases numbers and
   * tears down agents. `storeSubscription` names a store subscription the
   * server cannot cancel - the user must, in that store.
   */
  deleteAccount: () =>
    request<DeleteAccountResult>('/api/mobile/account', {
      method: 'DELETE',
      body: JSON.stringify({ confirm: 'DELETE' }),
      slow: true,
    }),

  /** Who bills this account, whichever store or Stripe that is. */
  billing: () => request<BillingSnapshot>('/api/mobile/billing'),

  /**
   * Report an App Store transaction. 409 `code` 'stripe_active' (billed on the
   * web) or 'other_account' (bound to another user); 400 not ours / expired /
   * refunded; 5xx and 0 are transient - leave the transaction unfinished.
   */
  verifyApplePurchase: (body: AppleVerifyBody) =>
    post<BillingSnapshot>('/api/mobile/billing/apple/verify', body, true),

  /** Sync Google Play via RevenueCat. 402 when RevenueCat has no active subscription; 409 as for Apple. */
  syncGooglePurchase: (body: GoogleSyncBody) =>
    post<BillingSnapshot>('/api/mobile/billing/google/sync', body, true),

  /**
   * The App Review sign-in: a fixed review email and code the server checks.
   * Only ever called after a normal code check fails, and the app embeds
   * neither value. 404 for anything that is not the review account.
   */
  reviewSignIn: (email: string, code: string) =>
    request<ReviewTokens>('/api/mobile/auth/review', {
      method: 'POST',
      body: JSON.stringify({ email, code }),
      anon: true,
    }),

  /**
   * Hand the server Sign in with Apple's authorization code so it can revoke
   * the token when the account is deleted. `ok: false` is not an error the
   * user can act on.
   */
  registerAppleToken: (authorizationCode: string) =>
    post<{ ok: boolean }>('/api/mobile/auth/apple-token', { authorizationCode }),

  notifications: () =>
    request<{ items: NotificationItem[]; activeCall: boolean; activeCallId: string | null }>(
      '/api/mobile/notifications',
    ),

  /**
   * Just the live-call id. Home polls this every 15s; the full route also
   * builds an eight-row activity list that this caller throws away.
   */
  liveCall: () =>
    request<{ activeCallId: string | null }>('/api/mobile/notifications?live=1'),

  /** Register this install for push. Idempotent - safe on every cold start. */
  registerPush: (token: string, platform: string) =>
    post<WriteResult>('/api/mobile/push', { token, platform }),

  /** Mute or unmute delivery server-side, keeping the row. */
  setPushEnabled: (token: string, enabled: boolean) =>
    post<WriteResult>('/api/mobile/push', { token, enabled }),

  unregisterPush: (token: string) =>
    request<WriteResult>('/api/mobile/push', {
      method: 'DELETE',
      body: JSON.stringify({ token }),
    }),

  onboarding: () => request<OnboardingState>('/api/mobile/onboarding'),

  onboardingAction: (body: Record<string, unknown>) =>
    post<{ ok?: boolean; step?: number }>('/api/mobile/onboarding', body, true),

  provision: () => post<ProvisionPoll>('/api/mobile/onboarding', { action: 'provision' }, true),

  webLink,

  /**
   * Plans, number countries and funnel voices, without a session.
   *
   * The funnel runs before there is an account, so everything its pickers and
   * its pricing need comes from this one anonymous route. The plans are the same
   * payload the authenticated onboarding state carries, from the same serializer
   * on the server, so the two cannot disagree on a price.
   */
  catalog: () => request<Catalog>('/api/mobile/catalog', { anon: true }),

  /**
   * Record this install against the signed-in account.
   *
   * Idempotent, and called once per foreground session - the write that matters
   * is `last_seen_at`. Callers should not surface a failure: a device that could
   * not be recorded is a missing row in a list, not a broken session.
   */
  registerDevice: (info: {
    platform: string;
    model: string;
    osVersion: string;
    appVersion: string;
  }) => post<WriteResult>('/api/mobile/devices', info),

  /** Every install signed into this account, most recently used first. */
  devices: () => request<{ devices: AccountDevice[] }>('/api/mobile/devices'),

  /** Forget one install and stop push to it. Does not end that device's session - see the route. */
  revokeDevice: (id: string) =>
    request<WriteResult>(`/api/mobile/devices${query({ deviceId: id })}`, {
      method: 'DELETE',
    }),
};
