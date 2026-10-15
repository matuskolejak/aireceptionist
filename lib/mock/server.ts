import { Asset } from 'expo-asset';

import { ApiError, type RequestOptions } from '../api';
import { LIVE_MAX_AGE_MS, formatDuration, statusBucket } from '../format';
import {
  SECTION,
  type Account,
  type AssistantDetail,
  type AssistantSummary,
  type BillingSnapshot,
  type CalendarConnections,
  type CallDetail,
  type CallLog,
  type CallLogRow,
  type EscalationTarget,
  type KnowledgeState,
  type NotificationItem,
  type OnboardingState,
  type Overview,
  type ProvisionPoll,
  type RecentCall,
  type SettingsState,
  type WeeklyHours,
} from '../types';
import {
  CALENDAR_PROVIDERS,
  CATALOG,
  COUNTRY_LIST,
  LATENCY,
  MONTH_USAGE,
  PLANS,
  PLAN_TERMS,
  TIMEZONES,
  TODAY,
  VOICE_CATALOG,
  blankAssistant,
  buildAnalytics,
  flagFor,
  numberCountries,
  numberIn,
  zonedAt,
  type MockAssistant,
  type MockCall,
  type MockKnowledge,
} from './fixtures';
import { MOCK_REVIEW_CODE, MOCK_USER_ID, mockSession, mockSignedIn } from './session';
import {
  isSandbox,
  mockDelay,
  mockShouldFail,
  mockState,
  populateAccount,
  resetMockState,
  MOCK_SANDBOX,
  type MockState,
} from './state';

/**
 * DEV ONLY (EXPO_PUBLIC_MOCK=1). A stand-in for the web app's /api/mobile/*
 * routes, reached from the top of `request()` in lib/api.ts.
 *
 * Mirrors the real routes' shapes, status codes and error bodies - including
 * `ApiError.code` - closely enough that a screen written against the mock
 * behaves the same against the server. Deliberately NOT a second
 * implementation of the business rules beyond what the screens need to show
 * their states.
 *
 * Every request is logged (`[mock] METHOD /path`) so a check like "no
 * translate request while the call is live" can be read off the Metro log.
 * Responses are deep copies: a screen mutating what it got back must not
 * change the "database".
 */

type Body = Record<string, unknown>;

interface Ctx {
  method: string;
  query: Record<string, string>;
  body: Body;
  /** Path parameters, in order. */
  params: string[];
  s: MockState;
  now: number;
}

type Handler = (ctx: Ctx) => unknown;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
  /** No session needed (the real route has no bearer check). */
  anon?: boolean;
}

const ID = '([^/]+)';
const routes: Route[] = [];

function route(method: string, path: string, handler: Handler, anon = false): void {
  routes.push({ method, pattern: new RegExp(`^${path}$`), handler, anon });
}

function parseQuery(search: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of search.split('&')) {
    if (!pair) continue;
    const [k, v = ''] = pair.split('=');
    out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '));
  }
  return out;
}

function parseBody(raw: RequestOptions['body']): Body {
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Body) : {};
  } catch {
    return {};
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

const E164 = /^\+[1-9]\d{6,15}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function mockRequest<T>(path: string, init?: RequestOptions): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const [pathname, search = ''] = path.split('?');
  const body = parseBody(init?.body);
  const action = typeof body.action === 'string' ? ` action=${body.action}` : '';
  const label = `${method} ${path}${action}`;
  console.log(`[mock] ${label}${method === 'GET' ? '' : ` ${JSON.stringify(body)}`}`);

  await mockDelay();
  if (mockShouldFail(label)) throw new ApiError(500, 'Something went wrong.');

  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.pattern.exec(pathname);
    if (!m) continue;
    if (!r.anon && !mockSignedIn()) throw new ApiError(401, 'Not signed in.');
    const result = await r.handler({
      method,
      query: parseQuery(search),
      body,
      params: m.slice(1).map(decodeURIComponent),
      s: mockState(MOCK_USER_ID),
      now: Date.now(),
    });
    return clone(result ?? {}) as T;
  }
  throw new ApiError(404, 'Not found.');
}

/**
 * The call recording: one bundled clip for every call. `Asset.fromModule(...).uri`
 * is Metro's http URL in development, so the player's status probe gets a real
 * 200/206 (a file:// URI can report status 0). No headers - Metro needs none.
 */
export async function mockRecordingSource(
  _id: string,
): Promise<{ uri: string; headers: Record<string, string> } | null> {
  if (!mockSignedIn()) return null;
  const asset = Asset.fromModule(require('../../assets/mock/sample-call.m4a'));
  return { uri: asset.uri, headers: {} };
}

// ── Formatting, as the server does it ───────────────────────────────────────

function ownerTz(s: MockState): string {
  return s.profile.timezone || 'UTC';
}

function validTz(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The account zone, else the phone's (`?tz=`), else UTC - lib/mobile/timezone-param.ts. */
function resolveTimezone(s: MockState, tzParam: string | undefined) {
  if (s.profile.timezone) return { timezone: s.profile.timezone, timezoneIsAccount: true };
  return { timezone: tzParam && validTz(tzParam) ? tzParam : 'UTC', timezoneIsAccount: false };
}

function fmt(tz: string, opts: Intl.DateTimeFormatOptions, locale = 'en-US') {
  let f: Intl.DateTimeFormat;
  try {
    f = new Intl.DateTimeFormat(locale, { ...opts, timeZone: tz });
  } catch {
    f = new Intl.DateTimeFormat(locale, { ...opts, timeZone: 'UTC' });
  }
  return (iso: string) => (Number.isFinite(Date.parse(iso)) ? f.format(new Date(iso)) : '-');
}

/** web dateTimeFmt: "Sep 28, 10:05 AM". */
const dateTimeLabel = (tz: string) => fmt(tz, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
/** web timeFmt (Home's `at`): "28 Sept 2026, 10:05". */
const atLabel = (tz: string) =>
  fmt(tz, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }, 'en-GB');
/** web clockSecFmt (transcript turns): "10:05:12". */
const clockLabel = (tz: string) =>
  fmt(tz, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }, 'en-GB');

/** web statusLabel: 'no-answer' -> 'No Answer'. */
function statusWords(raw: string): string {
  if (!raw) return '-';
  return raw.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** web calls/format.ts fmtDuration: '42s', '3m 05s'. */
function logDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return s < 60 ? `${s}s` : formatDuration(s);
}

const LIVE_STATUSES = ['in-progress', 'in_progress', 'ringing', 'queued', 'initiated'];

function isLive(c: MockCall, now: number): boolean {
  return LIVE_STATUSES.includes(c.status.toLowerCase()) && now - Date.parse(c.startedAt) <= LIVE_MAX_AGE_MS;
}

function newestFirst(calls: MockCall[]): MockCall[] {
  return [...calls].sort((a, b) => (b.startedAt > a.startedAt ? 1 : b.startedAt < a.startedAt ? -1 : 0));
}

// ── Plan ────────────────────────────────────────────────────────────────────

function planOf(s: MockState) {
  const active = (s.billing.status === 'active' || s.billing.status === 'trialing') && Boolean(s.billing.plan);
  const plan = PLANS.find((p) => p.id === (active ? s.billing.plan : 'solo')) ?? PLANS[0];
  return {
    id: active ? plan.id : null,
    name: active ? plan.name : 'No plan',
    active,
    minutesIncluded: plan.minutesIncluded,
    phoneNumbers: plan.phoneNumbers,
    concurrentCalls: plan.concurrentCalls,
    contacts: plan.contacts,
    // Infinity on Team, which the server sends as 0 (unlimited).
    users: plan.id === 'team' ? 0 : 1,
  };
}

/** LIVE STRIPE (lib/types.ts BillingSnapshot): billed on the web, so no store purchase. */
function liveStripe(b: BillingSnapshot, now: number): boolean {
  return (
    b.provider === 'stripe' &&
    ['active', 'trialing', 'past_due', 'unpaid', 'incomplete'].includes(b.status ?? '') &&
    (b.currentPeriodEnd === null || Date.parse(b.currentPeriodEnd) > now)
  );
}

// ── Calls ───────────────────────────────────────────────────────────────────

function logRow(c: MockCall, tz: string): CallLogRow {
  return {
    key: c.id,
    dbId: c.id,
    sid: c.sid,
    date: c.startedAt,
    dateLabel: dateTimeLabel(tz)(c.startedAt),
    status: c.status,
    statusLabel: statusWords(c.status),
    direction: 'inbound',
    from: c.from,
    to: c.to,
    durationSec: c.durationSec,
    durationLabel: logDuration(c.durationSec),
    outcome: c.outcome,
    assistant: c.assistant,
    source: 'both',
    needsReview: c.needsReview,
  };
}

function recentRow(c: MockCall, tz: string, now: number): RecentCall {
  return {
    id: c.id,
    name: c.from,
    number: c.from,
    flag: flagFor(c.from),
    duration: formatDuration(c.durationSec),
    outcome: c.outcome,
    sentiment: c.sentiment ?? 'neutral',
    agoMinutes: Math.max(0, Math.floor((now - Date.parse(c.startedAt)) / 60000)),
    at: atLabel(tz)(c.startedAt),
    status: c.status,
    startedAt: c.startedAt,
  };
}

/** Live calls the detail has been opened for; each later read says one more turn. */
const polledLive = new Set<string>();

/** The live call's next turn - or, once the script is spoken, its end. */
function advanceLive(c: MockCall, now: number): void {
  if (!c.script || !isLive(c, now)) return;
  if (!polledLive.has(c.id)) {
    polledLive.add(c.id);
    return;
  }
  if (c.turns.length < c.script.length) {
    c.turns = c.script.slice(0, c.turns.length + 1);
    return;
  }
  c.status = 'completed';
  c.durationSec = Math.round((now - Date.parse(c.startedAt)) / 1000);
  c.outcome = 'booked';
  c.sentiment = 'positive';
  c.summary = 'Grace Kavanagh chipped a tooth and was booked into the first emergency slot, 8:45 tomorrow.';
  const start = zonedAt(now, 1, 8, 45);
  c.actions = [
    {
      id: `${c.id}-a1`,
      type: 'booking',
      status: 'done',
      payload: {
        title: 'Emergency visit - Grace Kavanagh',
        start_time: new Date(start).toISOString(),
        end_time: new Date(start + 30 * 60000).toISOString(),
        attendee_name: 'Grace Kavanagh',
        attendee_phone: c.from,
        notes: 'Chipped tooth, some pain, no swelling',
      },
      error: null,
    },
  ];
  delete c.script;
}

function detailOf(c: MockCall, tz: string, now: number): CallDetail {
  const live = isLive(c, now);
  const start = Date.parse(c.startedAt);
  const clock = clockLabel(tz);
  return {
    id: c.id,
    sid: c.sid,
    date: c.startedAt,
    dateLabel: dateTimeLabel(tz)(c.startedAt),
    status: c.status,
    statusLabel: statusWords(c.status),
    direction: 'inbound',
    from: c.from,
    to: c.to,
    durationLabel: logDuration(c.durationSec),
    outcome: c.outcome,
    sentiment: c.sentiment,
    summary: c.summary,
    assistant: c.assistant,
    recordingUrl: null,
    // Audio exists once a conversation has ended - never for a live one, never
    // for a call nobody answered.
    hasAudio: c.turns.length > 0 && !live,
    isLive: live,
    needsReview: c.needsReview,
    reviewClaims: c.reviewClaims,
    turns: c.turns.map((t, i) => {
      const tsMs = i * 7000;
      return { id: i + 1, role: t.role, text: t.text, tsMs, atLabel: clock(new Date(start + tsMs).toISOString()) };
    }),
    actions: c.actions,
  };
}

function liveCallId(s: MockState, now: number): string | null {
  return newestFirst(s.calls).find((c) => isLive(c, now))?.id ?? null;
}

route('GET', '/api/mobile/calls', ({ s, query }): CallLog => {
  const tz = ownerTz(s);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '', 10) || 50));
  const before = Date.parse(query.before ?? '');
  const status = query.status && query.status !== 'all' ? query.status : '';
  const q = (query.q ?? '').trim().toLowerCase();
  const rows = newestFirst(s.calls)
    .map((c) => logRow(c, tz))
    .filter((r) => !Number.isFinite(before) || Date.parse(r.date) < before)
    .filter((r) => !status || statusBucket(r.status, r.date) === status)
    .filter(
      (r) => !q || `${r.from} ${r.to} ${r.sid} ${r.assistant ?? ''} ${r.outcome ?? ''}`.toLowerCase().includes(q),
    );
  const page = rows.slice(0, limit);
  return {
    rows: page,
    twilioConnected: true,
    timezone: tz,
    nextCursor: rows.length > limit ? page[page.length - 1].date : null,
  };
});

route('GET', `/api/mobile/calls/${ID}`, ({ s, params, now }) => {
  const c = s.calls.find((x) => x.id === params[0]);
  if (!c) throw new ApiError(404, 'Call not found.');
  advanceLive(c, now);
  return detailOf(c, ownerTz(s), now);
});

route('POST', `/api/mobile/calls/${ID}/report`, ({ s, params, body }) => {
  if (!s.calls.some((c) => c.id === params[0])) throw new ApiError(404, 'Call not found.');
  if (!str(body.message)) throw new ApiError(400, 'Say what went wrong first.');
  return { ok: true };
});

route('POST', `/api/mobile/calls/${ID}/text`, ({ s, params, body }) => {
  const c = s.calls.find((x) => x.id === params[0]);
  if (!c) throw new ApiError(404, 'Call not found.');
  if (!c.from) throw new ApiError(400, 'This caller withheld their number.');
  if (!str(body.message)) throw new ApiError(400, 'Type a message first.');
  return { ok: true, warning: null };
});

/**
 * Stands in for the model: text that reads as Spanish comes back marked
 * '[EN] ', anything else unchanged - like the real route, where English content
 * is a cache hit that returns the originals.
 */
const SPANISH = /[áéíóúñ¿¡]|\b(hola|gracias|quiero|por favor|buenos|cita|mañana|usted|tarde|limpieza)\b/i;

route('POST', '/api/mobile/translate', ({ body }) => {
  const texts = Array.isArray(body.texts) ? body.texts.filter((t): t is string => typeof t === 'string') : [];
  if (texts.length === 0 || !str(body.locale)) throw new ApiError(400, 'Bad request.');
  return { texts: texts.map((t) => (SPANISH.test(t) ? `[EN] ${t}` : t)), ok: true };
});

// ── Home and Activity ───────────────────────────────────────────────────────

route('GET', '/api/mobile/overview', ({ s, query, now }): Overview => {
  const tz = ownerTz(s);
  const plan = planOf(s);
  const hasCalls = s.calls.length > 0;
  return {
    today: hasCalls ? TODAY : { calls: 0, answered: 0, missed: 0, booked: 0 },
    monthUsage: hasCalls ? MONTH_USAGE : { callsThisMonth: 0, minutes: 0, bookings: 0 },
    latency: LATENCY,
    recentCalls: newestFirst(s.calls)
      .slice(0, 6)
      .map((c) => recentRow(c, tz, now)),
    analytics: query.range === 'month' && hasCalls ? buildAnalytics(now) : null,
    assistant: s.assistants[0]
      ? { id: s.assistants[0].id, name: s.assistants[0].name, enabled: s.assistants[0].enabled }
      : null,
    assistantCount: s.assistants.length,
    online: s.assistants.some((a) => a.enabled),
    number: s.numbers[0]?.e164 ?? '',
    calendarConnected: s.calendarConnected,
    plan: { name: plan.name, active: plan.active, minutesIncluded: plan.minutesIncluded },
    upcoming: s.bookings
      .filter((b) => b.status !== 'cancelled' && Date.parse(b.startTime) >= now)
      .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime))
      .slice(0, 5),
    toConfirm: s.bookings.filter((b) => !Number.isFinite(Date.parse(b.startTime))).length,
    timezone: tz,
  };
});

route('GET', '/api/mobile/notifications', ({ s, query, now }) => {
  const liveId = liveCallId(s, now);
  if (query.live === '1') return { items: [], activeCall: Boolean(liveId), activeCallId: liveId };
  const items: NotificationItem[] = newestFirst(s.calls)
    .slice(0, 8)
    .map((c) => {
      const label = c.outcome ?? c.status ?? 'Call';
      return {
        id: c.id,
        title: c.from || 'Unknown caller',
        subtitle: `${label.charAt(0).toUpperCase()}${label.slice(1)} · ${formatDuration(c.durationSec)}`,
        at: c.startedAt,
        href: `/dashboard/calls/${c.id}`,
        callId: c.id,
        from: c.from,
        outcome: c.outcome,
        status: c.status,
        durationSec: c.durationSec,
      };
    });
  return { items, activeCall: Boolean(liveId), activeCallId: liveId };
});

// ── Appointments and calendars ──────────────────────────────────────────────

route('GET', '/api/mobile/calendar', ({ s, query }) => ({
  bookings: s.bookings,
  events: s.events,
  ...resolveTimezone(s, query.tz),
}));

route('POST', `/api/mobile/calendar/bookings/${ID}`, ({ s, params, body }) => {
  const b = s.bookings.find((x) => x.id === params[0]);
  if (!b) throw new ApiError(404, 'Appointment not found.');
  if (body.action === 'retry') {
    b.status = 'done';
    b.error = null;
    b.externalId = 'evt_mock_retry';
    b.syncAttempts += 1;
    return { ok: true };
  }
  if (body.action === 'cancel') {
    if (b.status === 'cancelled' || b.cancellation) {
      throw new ApiError(409, 'This booking is already cancelled.');
    }
    if (!Number.isFinite(Date.parse(b.startTime))) {
      throw new ApiError(409, 'This request has no time yet - call the customer to arrange one.');
    }
    b.status = 'cancelled';
    b.cancellation = { reason: str(body.reason), offerRebook: body.offerRebook === true, notifyStatus: 'pending' };
    return { ok: true, warning: null };
  }
  throw new ApiError(400, 'Bad request.');
});

route('GET', '/api/mobile/calendar/connections', ({ s }): CalendarConnections => ({
  connected: s.connections,
  // The server sends { id, name } only.
  connectable: CALENDAR_PROVIDERS.map((p) => ({ ...p })) as CalendarConnections['connectable'],
}));

route('PATCH', `/api/mobile/calendar/connections/${ID}`, ({ s, params }) => {
  if (!s.connections.some((c) => c.id === params[0])) throw new ApiError(404, 'Not found.');
  for (const c of s.connections) c.isPrimary = c.id === params[0];
  return { ok: true };
});

route('DELETE', `/api/mobile/calendar/connections/${ID}`, ({ s, params }) => {
  const before = s.connections.length;
  s.connections = s.connections.filter((c) => c.id !== params[0]);
  if (s.connections.length === before) throw new ApiError(404, 'Not found.');
  if (s.connections.length > 0 && !s.connections.some((c) => c.isPrimary)) s.connections[0].isPrimary = true;
  return { ok: true };
});

/**
 * The calendar handoff. Minting a link stands in for the whole consent round
 * trip: the provider comes back connected (or reconnected), as it would after
 * the browser returns to the app.
 */
route('POST', '/api/mobile/web-link', ({ s, body }) => {
  const target = typeof body.target === 'string' ? body.target : 'dashboard';
  if (target === 'billing' || target === 'checkout') throw new ApiError(400, 'Unsupported target.');
  if (target !== 'calendar') return { url: 'https://example.com/mock-web', signedIn: true };

  const provider = CALENDAR_PROVIDERS.find((p) => p.id === body.provider);
  if (!provider) throw new ApiError(400, 'Unsupported calendar.');
  const existing = s.connections.find((c) => c.provider === provider.id);
  if (existing) {
    existing.needsReconnect = false;
  } else {
    s.connections.push({
      id: `int-${provider.id}`,
      provider: provider.id,
      name: provider.name,
      account: mockSession()?.user.email ?? 'owner@example.com',
      isPrimary: s.connections.length === 0,
      needsReconnect: false,
    });
  }
  s.calendarConnected = true;
  return { url: 'https://example.com/mock-connect', signedIn: true };
});

// ── Receptionists ───────────────────────────────────────────────────────────

function summaryOf(s: MockState, a: MockAssistant): AssistantSummary {
  const number = s.numbers.find((n) => n.assistantId === a.id);
  return {
    id: a.id,
    name: a.name,
    greeting: a.greeting,
    language: a.language,
    enabled: a.enabled,
    createdAt: a.createdAt,
    connected: a.connected,
    number: number?.e164 ?? '',
  };
}

function findAssistant(s: MockState, id: string): MockAssistant {
  const a = s.assistants.find((x) => x.id === id);
  if (!a) throw new ApiError(404, 'Not found.');
  return a;
}

function numberRefusal(s: MockState): ApiError | null {
  const plan = planOf(s);
  if (!plan.active) return new ApiError(403, 'Subscribe to a plan to add a phone number.', 'plan_required');
  if (MOCK_SANDBOX || isSandbox(s.billing)) {
    return new ApiError(403, 'Test purchases (App Review, TestFlight) do not include a live phone number.', 'sandbox');
  }
  if (s.numbers.length >= plan.phoneNumbers) {
    const n = plan.phoneNumbers;
    return new ApiError(
      403,
      `Your ${plan.name} plan includes ${n} phone number${n === 1 ? '' : 's'}. Upgrade to add more.`,
      'limit_reached',
    );
  }
  return null;
}

route('GET', '/api/mobile/assistants', ({ s }) => ({ assistants: s.assistants.map((a) => summaryOf(s, a)) }));

route('POST', '/api/mobile/assistants', ({ s, body, now }) => {
  const name = str(body.name);
  if (!name) throw new ApiError(400, 'Give it a name first.');
  const id = `a${now.toString(36)}`;
  s.assistants.push(blankAssistant(id, name, now));
  return { id, warning: null };
});

route('GET', `/api/mobile/assistants/${ID}`, ({ s, params, query }): AssistantDetail => {
  const a = findAssistant(s, params[0]);
  const plan = planOf(s);
  const number = s.numbers.find((n) => n.assistantId === a.id);
  const { createdAt: _createdAt, ...stored } = a;
  return {
    ...stored,
    number: number?.e164 ?? '',
    numberId: number?.id ?? '',
    ...resolveTimezone(s, query.tz),
    planActive: plan.active,
    canAddNumber: numberRefusal(s) === null,
    calendars: s.connections.map((c) => ({
      id: c.id,
      provider: c.provider,
      name: c.name,
      level: a.calendars.find((x) => x.id === c.id)?.level ?? 'none',
    })),
    numberCountries: numberCountries(plan.active ? plan.minutesIncluded : null),
  };
});

route('PATCH', `/api/mobile/assistants/${ID}`, ({ s, params, body }) => {
  const a = findAssistant(s, params[0]);
  const sections = Array.isArray(body.sections) ? body.sections.filter((x): x is string => typeof x === 'string') : [];
  const fields = body.fields && typeof body.fields === 'object' ? (body.fields as Body) : {};
  if (sections.length === 0) throw new ApiError(400, 'Nothing to save.');
  applyAssistantPatch(a, sections, fields);
  return { ok: true, warning: null };
});

route('DELETE', `/api/mobile/assistants/${ID}`, ({ s, params }) => {
  findAssistant(s, params[0]);
  s.assistants = s.assistants.filter((a) => a.id !== params[0]);
  s.numbers = s.numbers.filter((n) => n.assistantId !== params[0]);
  return { ok: true, warning: null };
});

route('POST', `/api/mobile/assistants/${ID}/power`, ({ s, params, body }) => {
  const a = findAssistant(s, params[0]);
  if (typeof body.enabled !== 'boolean') throw new ApiError(400, 'Bad request.');
  a.enabled = body.enabled;
  return { id: a.id, enabled: a.enabled };
});

route('POST', `/api/mobile/assistants/${ID}/number`, ({ s, params, body }) => {
  const a = findAssistant(s, params[0]);
  const refusal = numberRefusal(s);
  if (refusal) throw refusal;
  const country = str(body.country).toUpperCase();
  if (!COUNTRY_LIST.some((c) => c.code === country)) throw new ApiError(400, 'Pick a country.');
  const id = `n${s.numbers.length + 1}-${Date.now().toString(36)}`;
  const e164 = numberIn(country);
  s.numbers = s.numbers.filter((n) => n.assistantId !== a.id);
  s.numbers.push({ id, e164, assistantId: a.id });
  return { e164, id };
});

route('DELETE', `/api/mobile/assistants/${ID}/number`, ({ s, params }) => {
  const a = findAssistant(s, params[0]);
  if (!s.numbers.some((n) => n.assistantId === a.id)) throw new ApiError(404, 'No number is linked.');
  s.numbers = s.numbers.filter((n) => n.assistantId !== a.id);
  return { ok: true };
});

route('POST', `/api/mobile/assistants/${ID}/test-call`, ({ s, params, body }) => {
  findAssistant(s, params[0]);
  if (!E164.test(str(body.to))) {
    throw new ApiError(400, 'Enter the number with its country code, like +1 555 123 4567.');
  }
  return { ok: true };
});

route('GET', '/api/mobile/voices', () => VOICE_CATALOG);

const lines = (v: string) =>
  v
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/**
 * `{ sections, fields }` onto the stored assistant, by the rules of the web's
 * buildAssistantPatch: a section not listed is untouched; inside a listed one,
 * an absent checkbox is off and an absent text field is left alone.
 */
function applyAssistantPatch(a: MockAssistant, sections: string[], f: Body): void {
  const has = (section: string) => sections.includes(section);
  const text = (k: string): string | undefined => (k in f && f[k] != null ? String(f[k]) : undefined);
  const on = (k: string) => f[k] === true || f[k] === 'on';

  if (has(SECTION.basics)) {
    const name = text('name');
    if (name !== undefined && name.trim()) a.name = name.trim();
    const greeting = text('greeting');
    if (greeting !== undefined) a.greeting = greeting;
    const voiceId = text('voice_id');
    if (voiceId !== undefined) {
      a.voiceId = voiceId;
      a.voiceName = VOICE_CATALOG.voices.find((v) => v.voiceId === voiceId)?.name ?? a.voiceName;
    }
    const language = text('language');
    if (language !== undefined) a.language = language;
  }
  if (has(SECTION.role)) {
    const prompt = text('system_prompt');
    if (prompt !== undefined) a.systemPrompt = prompt;
  }
  if (has(SECTION.voice)) {
    const tier = text('voice_tier');
    if (tier !== undefined) a.voice.tier = tier === 'natural' ? 'natural' : 'fast';
    const speed = Number(text('voice_speed'));
    if (Number.isFinite(speed) && speed > 0) a.voice.speed = speed;
    const stability = Number(text('voice_stability'));
    if (Number.isFinite(stability)) a.voice.stability = stability;
  }
  if (has(SECTION.alerts)) a.smsAlerts = on('sms_alerts');
  if (has(SECTION.email)) {
    a.emailTranscripts = { enabled: on('email_enabled'), to: text('email_to') ?? a.emailTranscripts.to };
  }
  if (has(SECTION.guardrails)) {
    a.guardrails = {
      neverDiscuss: lines(text('guardrail_never') ?? ''),
      alwaysEscalate: lines(text('guardrail_escalate') ?? ''),
      disclosure: text('disclosure') === 'upfront' ? 'upfront' : 'if_asked',
    };
  }
  if (has(SECTION.calendar)) {
    for (const [key, value] of Object.entries(f)) {
      const m = /^cal_access_(.+)$/.exec(key);
      if (!m) continue;
      const level = String(value);
      const existing = a.calendars.find((c) => c.id === m[1]);
      if (existing) existing.level = level;
      else a.calendars.push({ id: m[1], provider: '', name: '', level });
    }
  }
  if (has(SECTION.escalation) && 'esc_keys' in f) {
    const keys = (text('esc_keys') ?? '').split(',').filter((k) => /^[a-z0-9]{1,16}$/.test(k));
    const targets: EscalationTarget[] = [];
    for (const k of keys) {
      const number = (text(`esc_${k}_number`) ?? '').trim();
      if (!number) continue;
      const warm = text(`esc_${k}_warm`);
      targets.push({
        id: k,
        label: text(`esc_${k}_label`) ?? '',
        number,
        when: text(`esc_${k}_when`) ?? '',
        warm: warm === 'warm' ? true : warm === 'cold' ? false : null,
        hours: hoursOf(a, k, f, text),
      });
    }
    a.escalation = {
      targets,
      triggers: lines(text('esc_triggers') ?? ''),
      callbackSlaMinutes: Number(text('esc_sla')) > 0 ? Number(text('esc_sla')) : null,
      page: on('esc_page') ? { enabled: true, number: text('esc_page_number') ?? '' } : null,
    };
  }
}

/** A target's schedule. Without `esc_<key>_tz` the stored one is kept (web buildHours). */
function hoursOf(
  a: MockAssistant,
  key: string,
  f: Body,
  text: (k: string) => string | undefined,
): WeeklyHours | null {
  const tz = text(`esc_${key}_tz`);
  if (tz === undefined) return a.escalation.targets.find((t) => t.id === key)?.hours ?? null;
  const days = Array.from({ length: 7 }, (_, i) =>
    f[`esc_${key}_day_${i}`] === true || f[`esc_${key}_day_${i}`] === 'on'
      ? { start: text(`esc_${key}_start_${i}`) ?? '09:00', end: text(`esc_${key}_end_${i}`) ?? '17:00' }
      : null,
  );
  return days.some(Boolean) ? { timezone: tz, days } : null;
}

// ── Knowledge ───────────────────────────────────────────────────────────────

function knowledgeOf(s: MockState): MockKnowledge {
  if (!s.knowledge) {
    s.knowledge = { digest: '', notes: '', verified: '', sources: [], gaps: [], ownerNotesShared: false };
    s.business = { id: 'org-1', name: s.profile.company || 'My business' };
  }
  return s.knowledge;
}

route('GET', '/api/mobile/knowledge', ({ s }): KnowledgeState => {
  const k = s.knowledge;
  return {
    businesses: s.business ? [s.business] : [],
    activeBusinessId: s.business?.id ?? '',
    digest: k?.digest ?? '',
    notes: k?.notes ?? '',
    verified: k?.verified ?? '',
    sources: k?.sources ?? [],
    ownerNotesShared: k?.ownerNotesShared ?? false,
    calendarsConnected: s.connections.length,
    gaps: k?.gaps ?? [],
    digestPending: false,
  };
});

route('POST', '/api/mobile/knowledge', ({ s, body, now }) => {
  const action = String(body.action ?? '');
  const signalId = Number(body.signalId);

  if (action === 'dismissGap') {
    if (!Number.isSafeInteger(signalId) || signalId <= 0) throw new ApiError(400, 'Bad request.');
    if (s.knowledge) s.knowledge.gaps = s.knowledge.gaps.filter((g) => g.id !== signalId);
    return { ok: true };
  }

  const k = knowledgeOf(s);
  const businessId = s.business?.id ?? '';

  if (action === 'answerGap') {
    const answer = str(body.answer);
    if (!Number.isSafeInteger(signalId) || signalId <= 0) throw new ApiError(400, 'Bad request.');
    if (!answer || answer.length > 500) throw new ApiError(400, 'Type an answer of up to 500 characters.');
    const gap = k.gaps.find((g) => g.id === signalId);
    if (!gap) throw new ApiError(404, 'That question was already answered or dismissed.');
    k.gaps = k.gaps.filter((g) => g.id !== signalId);
    k.verified = [k.verified, `${gap.topic} | ${answer}`].filter(Boolean).join('\n');
    return { ok: true, businessId };
  }
  if (action === 'notes') {
    k.notes = typeof body.notes === 'string' ? body.notes : k.notes;
    k.verified = typeof body.verified === 'string' ? body.verified : k.verified;
    return { ok: true, businessId };
  }
  if (action === 'website') {
    const url = str(body.url);
    if (!url) throw new ApiError(400, 'Enter a web address.');
    const full = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    const host = full.replace(/^https?:\/\//i, '').split('/')[0];
    if (!host.includes('.')) throw new ApiError(400, 'That page could not be read.');
    k.sources.push({
      id: `src-${now.toString(36)}`,
      kind: 'website',
      title: host,
      url: full,
      summary: `Pages read from ${host}.`,
      charCount: 9_800,
      addedAt: new Date(now).toISOString(),
    });
    return { ok: true, businessId };
  }
  if (action === 'text') {
    const text = str(body.text);
    if (!text) throw new ApiError(400, 'Type something to teach first.');
    const first = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
    k.sources.push({
      id: `src-${now.toString(36)}`,
      kind: 'text',
      title: first.slice(0, 50) || 'What I told it',
      url: '',
      summary: first.slice(0, 120),
      charCount: text.length,
      addedAt: new Date(now).toISOString(),
    });
    return { ok: true, businessId };
  }
  throw new ApiError(400, 'Bad request.');
});

route('DELETE', '/api/mobile/knowledge', ({ s, query }) => {
  if (!query.source) throw new ApiError(400, 'Bad request.');
  if (s.knowledge) s.knowledge.sources = s.knowledge.sources.filter((src) => src.id !== query.source);
  return { ok: true };
});

// ── Settings, account, devices, push ───────────────────────────────────────

function settingsPlan(s: MockState) {
  const plan = planOf(s);
  return {
    id: plan.id,
    name: plan.name,
    active: plan.active,
    minutesIncluded: plan.minutesIncluded,
    numbersUsed: s.numbers.length,
    numbersIncluded: plan.phoneNumbers,
    assistantsUsed: s.assistants.length,
    // Infinity on every plan, which does not survive JSON.
    assistantsIncluded: 0,
  };
}

function alertsOf(s: MockState) {
  return {
    email: s.alerts.email,
    emailAddress: mockSession()?.user.email ?? 'owner@example.com',
    sms: s.alerts.sms,
    // Falls back to the profile phone, like the server.
    smsNumber: s.profile.phone,
  };
}

route('GET', '/api/mobile/settings', ({ s }): SettingsState => ({
  profile: s.profile,
  notifications: alertsOf(s),
  businessCount: s.business ? 1 : 0,
  plan: settingsPlan(s),
  timezones: TIMEZONES,
}));

route('PATCH', '/api/mobile/settings', ({ s, body }) => {
  const p = { ...s.profile };
  if (typeof body.fullName === 'string') p.fullName = body.fullName.trim();
  if (typeof body.company === 'string') p.company = body.company.trim();
  if (typeof body.role === 'string') p.role = body.role.trim();
  if (typeof body.about === 'string') p.about = body.about.trim();
  if (typeof body.shareWithAssistants === 'boolean') p.shareWithAssistants = body.shareWithAssistants;
  if (typeof body.phone === 'string') {
    const phone = body.phone.replace(/[\s().-]/g, '');
    if (phone && !E164.test(phone)) {
      throw new ApiError(400, 'Enter the phone with its country code, like +353 87 123 4567.');
    }
    p.phone = phone;
  }
  if (typeof body.timezone === 'string') {
    const tz = body.timezone.trim();
    if (tz && !validTz(tz)) throw new ApiError(400, 'Pick a time zone from the list.');
    p.timezone = tz;
  }
  if (typeof body.notifyEmail === 'boolean') s.alerts.email = body.notifyEmail;
  if (typeof body.notifySms === 'boolean') s.alerts.sms = body.notifySms;
  s.profile = p;
  // A rename only renames the business when there is exactly one.
  if (s.business && p.company) s.business.name = p.company;
  return { ok: true };
});

route('GET', '/api/mobile/account', ({ s }): Account => {
  const plan = planOf(s);
  return {
    profile: {
      fullName: s.profile.fullName,
      company: s.profile.company,
      role: s.profile.role,
      phone: s.profile.phone,
      timezone: s.profile.timezone,
    },
    notifications: alertsOf(s),
    plan: {
      id: plan.id,
      name: plan.name,
      active: plan.active,
      minutesIncluded: plan.minutesIncluded,
      numbersIncluded: plan.phoneNumbers,
      numbersUsed: s.numbers.length,
      assistantsUsed: s.assistants.length,
      limits: {
        phoneNumbers: plan.phoneNumbers,
        concurrentCalls: plan.concurrentCalls,
        minutesIncluded: plan.minutesIncluded,
        contacts: plan.contacts,
        users: plan.users,
      },
    },
    numbers: s.numbers.map((n) => ({ id: n.id, e164: n.e164 })),
  };
});

/** Deleting resets the mock to a brand-new account; AuthContext drops the session. */
route('DELETE', '/api/mobile/account', ({ s, body }) => {
  if (body.confirm !== 'DELETE') throw new ApiError(400, 'Type DELETE to confirm.');
  const store =
    s.billing.active && (s.billing.provider === 'apple' || s.billing.provider === 'google')
      ? s.billing.provider
      : null;
  resetMockState(MOCK_USER_ID);
  return { ok: true, storeSubscription: store, warnings: [] };
});

route('POST', '/api/mobile/devices', ({ s, now }) => {
  const current = s.devices.find((d) => d.current);
  if (current) current.lastSeenAt = new Date(now).toISOString();
  return { ok: true };
});

route('GET', '/api/mobile/devices', ({ s }) => ({
  devices: [...s.devices].sort((a, b) => (b.lastSeenAt > a.lastSeenAt ? 1 : -1)),
}));

route('DELETE', '/api/mobile/devices', ({ s, query }) => {
  if (!query.deviceId) throw new ApiError(400, 'Bad request.');
  s.devices = s.devices.filter((d) => d.deviceId !== query.deviceId);
  return { ok: true };
});

route('POST', '/api/mobile/push', ({ s, body }) => {
  const token = str(body.token);
  if (!token) throw new ApiError(400, 'Bad request.');
  s.pushTokens[token] = typeof body.enabled === 'boolean' ? body.enabled : true;
  return { ok: true };
});

route('DELETE', '/api/mobile/push', ({ s, body }) => {
  delete s.pushTokens[str(body.token)];
  return { ok: true };
});

// ── Billing ─────────────────────────────────────────────────────────────────

const STRIPE_ACTIVE_APPLE =
  'Your plan is billed through your web account, so an App Store subscription cannot be added to it.';
const STRIPE_ACTIVE_GOOGLE =
  'Your plan is billed through your web account, so a Google Play subscription cannot be added to it.';

function requiresTerms(context: unknown): boolean {
  return context === 'onboarding' || context === 'pricing';
}

/** A store purchase landed: the account's billing becomes that subscription. */
function storeBilling(provider: 'apple' | 'google', plan: 'solo' | 'team', cycle: 'monthly' | 'annual', now: number): BillingSnapshot {
  const end = new Date(now);
  if (cycle === 'annual') end.setFullYear(end.getFullYear() + 1);
  else end.setMonth(end.getMonth() + 1);
  return {
    provider,
    plan,
    cycle,
    status: 'active',
    active: true,
    currentPeriodEnd: end.toISOString(),
    cancelAtPeriodEnd: false,
    environment: MOCK_SANDBOX ? 'Sandbox' : 'Production',
    providerRef: provider === 'apple' ? '2000000912345678' : MOCK_USER_ID,
  };
}

route('GET', '/api/mobile/billing', ({ s }) => s.billing);

/** Accepts the purchase mock's `mock-jws:<productId>` in place of a StoreKit JWS. */
route('POST', '/api/mobile/billing/apple/verify', ({ s, body, now }) => {
  const jws = str(body.jws);
  if (!jws) throw new ApiError(400, 'Bad request.');
  if (requiresTerms(body.context) && body.acceptedTerms !== true) {
    throw new ApiError(400, 'Please accept the Terms of Service to continue.');
  }
  const m = /^mock-jws:(.+)$/.exec(jws);
  if (!m) throw new ApiError(400, 'We could not verify this purchase.');
  const plan = PLANS.find((p) => p.storeProductIds.ios.monthly === m[1] || p.storeProductIds.ios.annual === m[1]);
  if (!plan) throw new ApiError(400, 'Unknown product.');
  if (liveStripe(s.billing, now)) throw new ApiError(409, STRIPE_ACTIVE_APPLE, 'stripe_active');
  const cycle = plan.storeProductIds.ios.annual === m[1] ? 'annual' : 'monthly';
  s.billing = storeBilling('apple', plan.id as 'solo' | 'team', cycle, now);
  return s.billing;
});

/** The real route asks RevenueCat; the mock reads the purchase mock's `debugProductId`. */
route('POST', '/api/mobile/billing/google/sync', ({ s, body, now }) => {
  if (requiresTerms(body.context) && body.acceptedTerms !== true) {
    throw new ApiError(400, 'Please accept the Terms of Service to continue.');
  }
  const productId = str(body.debugProductId);
  const plan = PLANS.find(
    (p) => p.storeProductIds.android.monthly === productId || p.storeProductIds.android.annual === productId,
  );
  if (!productId || !plan) throw new ApiError(402, 'No active subscription found on Google Play.');
  if (liveStripe(s.billing, now)) throw new ApiError(409, STRIPE_ACTIVE_GOOGLE, 'stripe_active');
  const cycle = plan.storeProductIds.android.annual === productId ? 'annual' : 'monthly';
  s.billing = storeBilling('google', plan.id as 'solo' | 'team', cycle, now);
  return s.billing;
});

// ── Sign-in ─────────────────────────────────────────────────────────────────

route(
  'POST',
  '/api/mobile/auth/review',
  ({ body }) => {
    if (!str(body.email) || !str(body.code)) throw new ApiError(400, 'Bad request.');
    if (str(body.code) !== MOCK_REVIEW_CODE) throw new ApiError(404, 'Not found.');
    return { access_token: 'mock', refresh_token: 'mock' };
  },
  true,
);

route('POST', '/api/mobile/auth/apple-token', () => ({ ok: true }));

// ── Catalogue and setup funnel ──────────────────────────────────────────────

route('GET', '/api/mobile/catalog', () => CATALOG, true);

/** The step the app may open - web page.tsx `firstIncomplete`. */
function firstIncompleteStep(cfg: OnboardingState['config']): number {
  if (!((cfg.companyName || cfg.companyWebsite) && cfg.assistantName)) return 1;
  if (!cfg.knowledgeDone) return 2;
  if (!cfg.calendarDone) return 3;
  return 4;
}

function paid(s: MockState): boolean {
  return s.billing.status === 'active' || s.billing.status === 'trialing';
}

route('GET', '/api/mobile/onboarding', ({ s }): OnboardingState => {
  const o = s.onboarding;
  const hasAssistants = s.assistants.length > 0;
  return {
    status: o.status,
    step: firstIncompleteStep(o.config),
    paid: paid(s),
    done: o.status === 'done' || (hasAssistants && o.status !== 'provisioning'),
    hasAssistants,
    result: o.result,
    config: o.config,
    calendarsConnected: s.connections.length,
    countries: COUNTRY_LIST,
    plans: PLANS,
    planTerms: PLAN_TERMS,
  };
});

route('POST', '/api/mobile/onboarding', ({ s, body, now }) => {
  const o = s.onboarding;
  const cfg = o.config;
  switch (body.action) {
    case 'basics': {
      const alertPhone = str(body.alertPhone).replace(/[\s().-]/g, '');
      const alertsEmail = str(body.alertsEmail);
      // Persisted BEFORE validating, like the route: a bad field never wipes the rest.
      Object.assign(cfg, {
        companyName: str(body.companyName),
        assistantName: str(body.assistantName) || 'Receptionist',
        voiceId: str(body.voiceId),
        voiceGender: str(body.voiceGender) === 'm' ? 'm' : 'f',
        country: str(body.country).toUpperCase(),
        alertsEmail,
        alertPhone,
        companyWebsite: str(body.companyWebsite),
      });
      if (alertPhone && !E164.test(alertPhone)) {
        throw new ApiError(400, 'Enter the alert number with its country code, like +1 555 123 4567.');
      }
      if (alertsEmail && !EMAIL.test(alertsEmail)) throw new ApiError(400, 'That email does not look right.');
      return { ok: true, step: 2 };
    }
    case 'add-text': {
      const text = str(body.text);
      if (!text) throw new ApiError(400, 'Type something first.');
      const first = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
      cfg.sources = [
        ...cfg.sources,
        { id: `src-${now.toString(36)}`, kind: 'text', title: first.slice(0, 50) || 'What I told it', summary: first.slice(0, 120) },
      ];
      return { ok: true };
    }
    case 'remove-source':
      cfg.sources = cfg.sources.filter((src) => src.id !== str(body.id));
      return { ok: true };
    case 'knowledge-done':
      cfg.knowledgeDone = true;
      return { ok: true, step: 3 };
    case 'calendar-done':
      cfg.calendarDone = true;
      return { ok: true, step: 4 };
    case 'country': {
      const c = str(body.country).toUpperCase();
      if (/^[A-Z]{2}$/.test(c)) cfg.country = c;
      return { ok: true };
    }
    case 'provision':
      return provisionPoll(s, now);
    default:
      throw new ApiError(400, 'Bad request.');
  }
});

/** Two 'provisioning' answers after payment, then done - with the number, or sandbox and none. */
function provisionPoll(s: MockState, now: number): ProvisionPoll {
  const o = s.onboarding;
  if (o.status === 'done') {
    return { status: 'done', e164: o.result?.e164, sandbox: o.result?.sandbox };
  }
  if (!paid(s)) return { status: 'waiting-payment' };
  o.provisionPolls += 1;
  if (o.provisionPolls <= 2) {
    o.status = 'provisioning';
    return { status: 'provisioning' };
  }
  populateAccount(s, now);
  o.status = 'done';
  const e164 = s.numbers[0]?.e164;
  o.result = e164 ? { e164 } : { sandbox: true };
  return e164 ? { status: 'done', e164 } : { status: 'done', sandbox: true };
}
