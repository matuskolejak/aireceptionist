import type {
  AccountDevice,
  AssistantDetail,
  BillingSnapshot,
  Booking,
  CalendarConnection,
  CallActionItem,
  Catalog,
  ExternalEvent,
  KnowledgeGap,
  KnowledgeSourceRow,
  MonthAnalytics,
  OnboardingPlan,
  OnboardingState,
  Latency,
  MonthUsage,
  Sentiment,
  SettingsState,
  TodayUsage,
  VoiceCatalog,
} from '../types';

/**
 * DEV ONLY (EXPO_PUBLIC_MOCK=1). The data behind mock mode: one realistic
 * account - "Harbour Dental" in Dublin, receptionist "Ava" - shaped exactly
 * like the /api/mobile/* payloads (lib/types.ts), so every signed-in screen
 * can be exercised in the simulator without a backend.
 *
 * Never imported statically outside lib/mock. Release bundles fold the one
 * entry point away (see `request` in lib/api.ts); the sentinel below is how
 * the release-bundle check proves it.
 *
 * Every time is relative to "now", in the owner's zone, so the fixtures never
 * go stale: there is always a call from three minutes ago and a booking
 * tomorrow morning.
 */

/** Grepped for in release bundles - it must never be found there. */
export const MOCK_FIXTURE_SENTINEL = 'arn-mock-fixture-7f3a';

export const MOCK_BUSINESS = 'Harbour Dental';
export const MOCK_TZ = 'Europe/Dublin';
/** The receptionist's line, +353 1 592 4410. */
export const MOCK_NUMBER = '+35315924410';
export const MOCK_OWNER_PHONE = '+353871234567';
export const MOCK_OWNER_EMAIL = 'owner@example.com';
export const MOCK_ASSISTANT = 'Ava';
export const MOCK_VOICE_ID = 'XB0fDUnXU5powFXDhCwa'; // Charlotte

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ── Time in the owner's zone ────────────────────────────────────────────────

const wallFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: MOCK_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

interface Wall {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
}

function wallOf(ms: number): Wall {
  const parts = wallFmt.formatToParts(new Date(ms));
  const n = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  // Some engines print midnight as hour 24.
  return { y: n('year'), m: n('month'), d: n('day'), h: n('hour') % 24, min: n('minute') };
}

/** The owner zone's UTC offset at `ms`, in ms. */
function offsetAt(ms: number): number {
  const w = wallOf(ms);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.min) - Math.floor(ms / MIN) * MIN;
}

/** The instant of an owner-zone wall-clock time, `dayOffset` days from today. */
export function zonedAt(now: number, dayOffset: number, hh: number, mm: number): number {
  const today = wallOf(now);
  const wall = Date.UTC(today.y, today.m - 1, today.d + dayOffset, hh, mm);
  // Second pass for a DST change between now and then.
  const first = wall - offsetAt(now);
  return wall - offsetAt(first);
}

/** 'YYYY-MM-DD' of `ms` in the owner zone. */
export function zonedDayKey(ms: number): string {
  const w = wallOf(ms);
  return `${w.y}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`;
}

function zonedHour(ms: number): number {
  return wallOf(ms).h;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Small deterministic PRNG, so the generated call log is the same on every reload. */
function prng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, weighted: readonly (readonly [T, number])[]): T {
  const total = weighted.reduce((n, [, w]) => n + w, 0);
  let r = rand() * total;
  for (const [value, w] of weighted) {
    r -= w;
    if (r < 0) return value;
  }
  return weighted[weighted.length - 1][0];
}

// ── Calls ───────────────────────────────────────────────────────────────────

export interface MockTurn {
  role: 'caller' | 'assistant';
  text: string;
}

/** One call, from which the log row, the detail, Home's row and Activity are all derived. */
export interface MockCall {
  id: string;
  sid: string;
  startedAt: string;
  status: string;
  from: string;
  to: string;
  durationSec: number;
  outcome: string | null;
  sentiment: Sentiment | null;
  summary: string | null;
  needsReview: boolean;
  reviewClaims: string[];
  assistant: string;
  turns: MockTurn[];
  actions: CallActionItem[];
  /** The live call only: everything it will say. `turns` is the part said so far. */
  script?: MockTurn[];
}

/** Ids with a hand-written detail. `gone` is not a call at all: it answers 404. */
export const CALL_IDS = {
  live: 'c-live',
  missed: 'c-missed',
  withheld: 'c-withheld',
  flagged: 'c-flagged',
  spanish: 'c-spanish',
  stale: 'c-stale',
  gone: 'gone',
} as const;

const CALLERS = [
  '+353851234567', '+353862345678', '+353873456789', '+353834567890', '+353895678901',
  '+35315921234', '+35316789012', '+35312345678', '+353857654321', '+353868765432',
  '+447700900123', '+14155550142', '+353879876543', '+353861112244', '+35314567890',
];

const NAMES = [
  'Sinead Walsh', 'Conor Byrne', 'Aoife Kelly', 'Mark Doyle', 'Niamh Murphy', 'Paul Ryan',
  'Emma Byrne', "Liam O'Brien", 'Ciara Nolan', 'Declan Walsh', 'Grace Kavanagh', 'Sean Fitzgerald',
];

const GREETING = `Hi, thanks for calling ${MOCK_BUSINESS}, this is ${MOCK_ASSISTANT}. How can I help?`;

function bookingAction(
  id: string,
  status: 'done' | 'pending' | 'failed',
  start: number,
  name: string,
  phone: string,
  title = 'Check-up',
): CallActionItem {
  return {
    id,
    type: 'booking',
    status,
    payload: {
      title: `${title} - ${name}`,
      start_time: iso(start),
      end_time: iso(start + 30 * MIN),
      attendee_name: name,
      attendee_phone: phone,
      notes: '',
    },
    error: status === 'failed' ? 'Calendar token expired' : null,
  };
}

function genericContent(
  outcome: string | null,
  name: string,
  from: string,
  id: string,
  startedAt: number,
): Pick<MockCall, 'turns' | 'summary' | 'actions'> {
  const slot = zonedAt(startedAt, 3, 9, 30);
  switch (outcome) {
    case 'booked':
      return {
        turns: [
          { role: 'assistant', text: GREETING },
          { role: 'caller', text: `Hi, this is ${name}. I'd like to book a check-up, please.` },
          { role: 'assistant', text: 'Of course. I have nine thirty or eleven o\'clock later this week. Which suits you?' },
          { role: 'caller', text: 'Nine thirty is perfect.' },
          { role: 'assistant', text: "Lovely, you're booked in. You'll get a text to confirm shortly." },
        ],
        summary: `${name} booked a check-up for later this week at 9:30.`,
        actions: [bookingAction(`${id}-a1`, 'done', slot, name, from)],
      };
    case 'message':
      return {
        turns: [
          { role: 'assistant', text: GREETING },
          { role: 'caller', text: 'Could Dr. Byrne call me back about my crown? It feels loose.' },
          { role: 'assistant', text: "I'll pass that on straight away. What's the best number to reach you on?" },
          { role: 'caller', text: 'This one is fine, thanks.' },
        ],
        summary: `${name} asked for a call back from Dr. Byrne about a loose crown.`,
        actions: [
          {
            id: `${id}-a1`,
            type: 'message',
            status: 'done',
            payload: {
              caller_name: name,
              callback_number: from,
              message: 'Crown feels loose, would like a call back from Dr. Byrne.',
              urgency: 'normal',
            },
            error: null,
          },
        ],
      };
    case 'transferred':
      return {
        turns: [
          { role: 'assistant', text: GREETING },
          { role: 'caller', text: 'I need to talk to someone about my bill.' },
          { role: 'assistant', text: "Of course, I'll put you through to the front desk now." },
        ],
        summary: `${name} had a billing question and was passed to the front desk.`,
        actions: [
          {
            id: `${id}-a1`,
            type: 'transfer',
            status: 'done',
            payload: { to: '+35315924400', reason: 'Billing question' },
            error: null,
          },
        ],
      };
    case 'resolved':
      return {
        turns: [
          { role: 'assistant', text: GREETING },
          { role: 'caller', text: 'What time are you open until on Thursdays?' },
          { role: 'assistant', text: "We're open until six on Thursdays." },
          { role: 'caller', text: 'Great, thanks.' },
        ],
        summary: 'Caller asked about Thursday opening hours and was told 6pm.',
        actions: [],
      };
    case 'abandoned':
      return {
        turns: [{ role: 'assistant', text: GREETING }],
        summary: 'Caller hung up before saying what they needed.',
        actions: [],
      };
    default:
      return {
        turns: [
          { role: 'assistant', text: GREETING },
          { role: 'caller', text: 'Sorry, wrong number.' },
          { role: 'assistant', text: 'No problem at all. Have a good day.' },
        ],
        summary: 'Wrong number.',
        actions: [],
      };
  }
}

/** The live call's whole conversation. It starts six turns in and grows by one per poll. */
export const LIVE_SCRIPT: MockTurn[] = [
  { role: 'assistant', text: GREETING },
  { role: 'caller', text: "Hi, I chipped a tooth at lunch and it's quite sore." },
  { role: 'assistant', text: "I'm sorry to hear that. Is it causing a lot of pain, or any swelling?" },
  { role: 'caller', text: 'A bit of pain, no swelling.' },
  { role: 'assistant', text: 'We keep emergency slots each morning. Could you come in tomorrow at 8:45?' },
  { role: 'caller', text: 'Is there nothing today?' },
  { role: 'assistant', text: "Today is fully booked, I'm afraid. 8:45 tomorrow is the first opening." },
  { role: 'caller', text: "OK, tomorrow at 8:45 then. It's Grace Kavanagh." },
  { role: 'assistant', text: 'Thanks, Grace. Is this the best number to text the confirmation to?' },
  { role: 'caller', text: 'Yes, this number.' },
  { role: 'assistant', text: "You're booked in for 8:45 tomorrow. If the pain gets worse, call us back." },
  { role: 'caller', text: 'Will do, thanks a million.' },
];
export const LIVE_START_TURNS = 6;

const SPANISH_TURNS: MockTurn[] = [
  { role: 'assistant', text: GREETING },
  { role: 'caller', text: 'Hola, buenos días. ¿Hablan español? Quiero pedir una cita para una limpieza.' },
  { role: 'assistant', text: 'Claro que sí. Tenemos una cita el jueves a las diez de la mañana. ¿Le va bien?' },
  { role: 'caller', text: 'Mejor por la tarde, por favor. Trabajo por las mañanas.' },
  { role: 'assistant', text: 'Entiendo. Tomo nota y la clínica le llamará para confirmar una hora por la tarde.' },
  { role: 'caller', text: 'Perfecto, muchas gracias. Me llamo Lucía García.' },
];

const DUBLIN = '+353';

/**
 * 64 inbound calls over the last twelve days: six hand-written ones in the last
 * six hours (Home's recent list) and 58 generated in business hours before that.
 */
export function buildCalls(now: number, assistant: string): MockCall[] {
  const base = (over: Partial<MockCall> & Pick<MockCall, 'id' | 'startedAt' | 'status' | 'from'>): MockCall => ({
    sid: `CA${over.id.replace(/[^a-z0-9]/gi, '').padEnd(32, '0').slice(0, 32)}`,
    to: MOCK_NUMBER,
    durationSec: 0,
    outcome: null,
    sentiment: null,
    summary: null,
    needsReview: false,
    reviewClaims: [],
    assistant,
    turns: [],
    actions: [],
    ...over,
  });

  const flaggedAt = now - 130 * MIN;
  const special: MockCall[] = [
    base({
      id: CALL_IDS.live,
      startedAt: iso(now - 3 * MIN),
      status: 'in-progress',
      from: '+353861234567',
      turns: LIVE_SCRIPT.slice(0, LIVE_START_TURNS),
      script: LIVE_SCRIPT,
    }),
    base({ id: CALL_IDS.missed, startedAt: iso(now - 25 * MIN), status: 'no-answer', from: '+353872345678' }),
    base({
      id: CALL_IDS.withheld,
      startedAt: iso(now - 70 * MIN),
      status: 'completed',
      from: '',
      durationSec: 94,
      outcome: 'message',
      sentiment: 'neutral',
      summary: 'A caller with a withheld number asked whether the practice takes new patients and left a message.',
      turns: [
        { role: 'assistant', text: GREETING },
        { role: 'caller', text: 'Are you taking new patients at the moment?' },
        { role: 'assistant', text: "We are. I can take your details and someone will call you back." },
        { role: 'caller', text: "I'll ring back myself, thanks. Tell them Maria called." },
      ],
      actions: [
        {
          id: 'c-withheld-a1',
          type: 'message',
          status: 'done',
          payload: { caller_name: 'Maria', callback_number: '', message: 'Asked about new patients, will ring back.', urgency: 'low' },
          error: null,
        },
      ],
    }),
    base({
      id: CALL_IDS.flagged,
      startedAt: iso(flaggedAt),
      status: 'completed',
      from: '+353857654321',
      durationSec: 212,
      outcome: 'booked',
      sentiment: 'frustrated',
      needsReview: true,
      reviewClaims: [
        'Told the caller a check-up costs €45 - no price is in the knowledge base.',
        'Said the practice is open on Saturdays.',
      ],
      summary:
        'Sinead Walsh booked a check-up and left an urgent message for Dr. Byrne about a toothache. She asked to speak to the dentist, but the transfer did not go through.',
      turns: [
        { role: 'assistant', text: GREETING },
        { role: 'caller', text: "Hi, I've had a bad toothache since last night. Can I see someone?" },
        { role: 'assistant', text: 'I can book you in for a check-up. A check-up is €45.' },
        { role: 'caller', text: 'Are you open on Saturday?' },
        { role: 'assistant', text: 'Yes, we are open on Saturdays.' },
        { role: 'caller', text: "Can I just talk to the dentist?" },
        { role: 'assistant', text: "Let me try to put you through." },
        { role: 'assistant', text: "I couldn't reach Dr. Byrne, so I've left an urgent message and booked you in." },
      ],
      actions: [
        bookingAction('c-flagged-a1', 'done', zonedAt(now, 1, 9, 30), 'Sinead Walsh', '+353857654321'),
        {
          id: 'c-flagged-a2',
          type: 'message',
          status: 'done',
          payload: {
            caller_name: 'Sinead Walsh',
            callback_number: '+353857654321',
            message: 'Severe toothache since last night, wants a call back from Dr. Byrne today.',
            urgency: 'high',
          },
          error: null,
        },
        {
          id: 'c-flagged-a3',
          type: 'transfer',
          status: 'failed',
          payload: { to: MOCK_OWNER_PHONE, reason: 'Caller asked to speak to the dentist' },
          error: 'Dial leg failed: SIP 480 Temporarily Unavailable (+353871234567)',
        },
      ],
    }),
    base({
      id: CALL_IDS.spanish,
      startedAt: iso(now - 4 * HOUR),
      status: 'completed',
      from: '+34612345678',
      durationSec: 158,
      outcome: 'message',
      sentiment: 'positive',
      summary: 'Lucia Garcia asked, in Spanish, for a cleaning appointment in the afternoon. The practice will call her back to confirm a time.',
      turns: SPANISH_TURNS,
      actions: [
        {
          id: 'c-spanish-a1',
          type: 'message',
          status: 'done',
          payload: {
            caller_name: 'Lucía García',
            callback_number: '+34612345678',
            message: 'Quiere una cita para una limpieza por la tarde.',
            urgency: 'normal',
          },
          error: null,
        },
      ],
    }),
    // Lost its end webhook: still 'in-progress' six hours later. Must read as missed.
    base({
      id: CALL_IDS.stale,
      startedAt: iso(now - 6 * HOUR),
      status: 'in-progress',
      from: '+353861112233',
      durationSec: 47,
      turns: [
        { role: 'assistant', text: GREETING },
        { role: 'caller', text: 'Hello? Hello, can you hear me?' },
      ],
    }),
  ];

  const rand = prng(20260928);
  const generated: MockCall[] = [];
  let t = now - 6.5 * HOUR;
  for (let i = 0; i < 58; i++) {
    t -= (1 + rand() * 3.5) * HOUR;
    // Business hours only: the line is quiet overnight.
    while (zonedHour(t) < 8 || zonedHour(t) >= 19) t -= HOUR;
    t -= Math.floor(rand() * 50) * MIN;

    const status = pick(rand, [
      ['completed', 78],
      ['no-answer', 10],
      ['busy', 5],
      ['canceled', 4],
      ['failed', 3],
    ] as const);
    const answered = status === 'completed';
    const outcome = answered
      ? pick(rand, [
          ['booked', 30],
          ['message', 25],
          ['resolved', 25],
          ['transferred', 10],
          ['abandoned', 5],
          [null, 5],
        ] as const)
      : null;
    const from = CALLERS[Math.floor(rand() * CALLERS.length)];
    const name = NAMES[Math.floor(rand() * NAMES.length)];
    const id = `c-${String(i + 1).padStart(3, '0')}`;
    const content = answered
      ? genericContent(outcome, name, from, id, t)
      : { turns: [], summary: null, actions: [] };
    generated.push(
      base({
        id,
        startedAt: iso(t),
        status,
        from,
        durationSec: answered ? 35 + Math.floor(rand() * 260) : 0,
        outcome,
        sentiment: answered
          ? pick(rand, [
              ['positive', 50],
              ['neutral', 35],
              ['frustrated', 8],
              ['negative', 5],
              ['angry', 2],
            ] as const)
          : null,
        needsReview: answered && rand() < 0.08,
        ...content,
      }),
    );
  }

  return [...special, ...generated];
}

/** Whether a caller number is Irish - for Home's flag column. */
export function flagFor(e164: string): string {
  if (e164.startsWith(DUBLIN)) return '🇮🇪';
  if (e164.startsWith('+44')) return '🇬🇧';
  if (e164.startsWith('+34')) return '🇪🇸';
  if (e164.startsWith('+1')) return '🇺🇸';
  return '';
}

// ── Home ────────────────────────────────────────────────────────────────────

export const TODAY: TodayUsage = { calls: 14, answered: 11, missed: 3, booked: 4 };
/** 920 of the Solo plan's 1000 minutes: Home's "running low" issue. */
export const MONTH_USAGE: MonthUsage = { callsThisMonth: 212, minutes: 920, bookings: 48 };
export const LATENCY: Latency = { medianMs: 780, p95Ms: 1350, targetMs: 1500, degraded: false };

export function buildAnalytics(now: number): MonthAnalytics {
  const rand = prng(3003);
  const volume = Array.from({ length: 30 }, (_, i) => {
    const day = zonedAt(now, i - 29, 12, 0);
    return { label: String(Number(zonedDayKey(day).slice(8))), value: 3 + Math.floor(rand() * 11) };
  });
  return {
    totals: { calls: 212, avgDuration: '2m 14s', answerRate: '87%', bookings: 48 },
    volume,
    sentiment: [
      { key: 'positive', label: 'Positive', value: 58, color: '#16a34a' },
      { key: 'neutral', label: 'Neutral', value: 30, color: '#a3a3a3' },
      { key: 'frustrated', label: 'Frustrated', value: 7, color: '#ea580c' },
      { key: 'negative', label: 'Negative', value: 4, color: '#dc2626' },
      { key: 'angry', label: 'Angry', value: 1, color: '#b91c1c' },
    ],
  };
}

// ── Calendar ────────────────────────────────────────────────────────────────

function booking(over: Partial<Booking> & Pick<Booking, 'id' | 'startTime' | 'title' | 'attendeeName'>): Booking {
  const start = Date.parse(over.startTime);
  return {
    callId: 'c-001',
    endTime: Number.isFinite(start) ? iso(start + 30 * MIN) : '',
    attendeePhone: '+353851234567',
    notes: '',
    status: 'done',
    externalId: 'evt_mock',
    error: null,
    bookedAt: iso(Date.now() - 2 * DAY),
    callerNumber: '+353851234567',
    assistant: MOCK_ASSISTANT,
    provider: 'google',
    syncAttempts: 1,
    cancellation: null,
    ...over,
  };
}

export function buildBookings(now: number): Booking[] {
  return [
    booking({
      id: 'bk-1',
      callId: CALL_IDS.flagged,
      startTime: iso(zonedAt(now, 1, 9, 30)),
      title: 'Check-up - Sinead Walsh',
      attendeeName: 'Sinead Walsh',
      attendeePhone: '+353857654321',
      callerNumber: '+353857654321',
      notes: 'Toothache since last night',
    }),
    booking({
      id: 'bk-2',
      startTime: iso(zonedAt(now, 1, 14, 0)),
      title: 'Cleaning - Conor Byrne',
      attendeeName: 'Conor Byrne',
      status: 'pending',
      externalId: null,
    }),
    booking({
      id: 'bk-3',
      startTime: iso(zonedAt(now, 2, 11, 0)),
      title: 'Filling - Aoife Kelly',
      attendeeName: 'Aoife Kelly',
      status: 'failed',
      externalId: null,
      error: 'Calendar token expired',
      provider: 'outlook',
      syncAttempts: 3,
    }),
    booking({
      id: 'bk-4',
      startTime: iso(zonedAt(now, 3, 10, 15)),
      title: 'Whitening consultation - Mark Doyle',
      attendeeName: 'Mark Doyle',
      attendeePhone: '+353873456789',
      callerNumber: '+353873456789',
    }),
    booking({
      id: 'bk-5',
      startTime: iso(zonedAt(now, 5, 16, 30)),
      title: 'Check-up - Niamh Murphy',
      attendeeName: 'Niamh Murphy',
    }),
    booking({
      id: 'bk-6',
      startTime: iso(zonedAt(now, 6, 12, 0)),
      title: 'Crown fitting - Paul Ryan',
      attendeeName: 'Paul Ryan',
      status: 'cancelled',
      cancellation: { reason: 'Dr. Byrne is away that day', offerRebook: true, notifyStatus: 'sms_sent' },
    }),
    booking({
      id: 'bk-7',
      startTime: iso(zonedAt(now, -1, 10, 0)),
      title: 'Check-up - Emma Byrne',
      attendeeName: 'Emma Byrne',
    }),
    booking({
      id: 'bk-8',
      startTime: iso(zonedAt(now, -3, 15, 30)),
      title: "Cleaning - Liam O'Brien",
      attendeeName: "Liam O'Brien",
    }),
    booking({
      id: 'bk-9',
      startTime: iso(zonedAt(now, -5, 9, 0)),
      title: 'Filling - Grace Kavanagh',
      attendeeName: 'Grace Kavanagh',
    }),
    // Requests to confirm: the caller never settled on a time.
    booking({
      id: 'bk-10',
      startTime: '',
      title: 'Appointment request - Ciara Nolan',
      attendeeName: 'Ciara Nolan',
      attendeePhone: '+353834567890',
      callerNumber: '+353834567890',
      notes: 'Wants "sometime next week after work"',
      status: 'pending',
      externalId: null,
      provider: null,
      syncAttempts: 0,
    }),
    booking({
      id: 'bk-11',
      startTime: '',
      title: 'Emergency visit - Declan Walsh',
      attendeeName: 'Declan Walsh',
      attendeePhone: '+353895678901',
      callerNumber: '+353895678901',
      notes: 'Asked for the first slot available',
      status: 'pending',
      externalId: null,
      provider: null,
      syncAttempts: 0,
    }),
  ];
}

export function buildEvents(now: number): ExternalEvent[] {
  const leaveDay = zonedDayKey(zonedAt(now, 2, 12, 0));
  const leaveNext = zonedDayKey(zonedAt(now, 3, 12, 0));
  return [
    {
      id: 'ev-1',
      integrationId: 'int-google',
      provider: 'google',
      providerLabel: 'Google Calendar',
      title: 'Team lunch',
      start: iso(zonedAt(now, 1, 13, 0)),
      end: iso(zonedAt(now, 1, 14, 0)),
      allDay: false,
      location: '',
      url: '',
    },
    {
      id: 'ev-2',
      integrationId: 'int-google',
      provider: 'google',
      providerLabel: 'Google Calendar',
      title: 'Dr. Byrne on leave',
      start: `${leaveDay}T00:00:00Z`,
      end: `${leaveNext}T00:00:00Z`,
      allDay: true,
      location: '',
      url: '',
    },
    {
      id: 'ev-3',
      integrationId: 'int-google',
      provider: 'google',
      providerLabel: 'Google Calendar',
      title: 'Supplier meeting',
      start: iso(zonedAt(now, 4, 17, 30)),
      end: iso(zonedAt(now, 4, 18, 30)),
      allDay: false,
      location: 'Harbour Dental, 12 Pearse Street, Dublin 2',
      url: 'https://meet.google.com/abc-defg-hij',
    },
  ];
}

export function buildConnections(): CalendarConnection[] {
  return [
    {
      id: 'int-google',
      provider: 'google',
      name: 'Google Calendar',
      account: MOCK_OWNER_EMAIL,
      isPrimary: true,
      needsReconnect: false,
    },
    {
      id: 'int-outlook',
      provider: 'outlook',
      name: 'Microsoft Calendar',
      account: 'alex@harbourdental.ie',
      isPrimary: false,
      needsReconnect: true,
    },
  ];
}

/** The server's CALENDAR_PROVIDERS (web lib/calendar/providers.ts), exactly. */
export const CALENDAR_PROVIDERS = [
  { id: 'google', name: 'Google Calendar' },
  { id: 'outlook', name: 'Microsoft Calendar' },
  { id: 'calcom', name: 'Cal.com' },
];

// ── Receptionists ───────────────────────────────────────────────────────────

/** An assistant as stored. The derived fields (number, plan, zone) are filled per request. */
export type MockAssistant = AssistantDetail & { createdAt: string };

const WEEKDAYS = { start: '09:00', end: '17:30' };

export function buildAssistant(now: number, name = MOCK_ASSISTANT, business = MOCK_BUSINESS): MockAssistant {
  return {
    id: 'a1',
    createdAt: iso(now - 40 * DAY),
    name,
    greeting: `Hi, thanks for calling ${business}, this is ${name}. How can I help?`,
    systemPrompt:
      `You are ${name}, the receptionist at ${business}, a family dental practice in Dublin. Be warm and brief. ` +
      'Book check-ups, cleanings and fillings into the calendar. Take a message for anything clinical.',
    language: 'multi',
    voiceId: MOCK_VOICE_ID,
    voiceName: 'Charlotte',
    enabled: true,
    connected: true,
    number: '',
    numberId: '',
    timezone: MOCK_TZ,
    timezoneIsAccount: true,
    planActive: true,
    canAddNumber: false,
    multilingual: true,
    smsAlerts: true,
    emailTranscripts: { enabled: true, to: MOCK_OWNER_EMAIL },
    voice: { tier: 'natural', speed: 1, stability: 0.5, byLanguage: {} },
    escalation: {
      targets: [
        {
          id: 'tprimary',
          label: 'Dr. Byrne',
          number: MOCK_OWNER_PHONE,
          when: 'Emergencies and anything clinical',
          warm: true,
          // A zone that is NOT the account's, on purpose: the schedule must keep it.
          hours: {
            timezone: 'Europe/Bratislava',
            days: [null, WEEKDAYS, WEEKDAYS, WEEKDAYS, WEEKDAYS, WEEKDAYS, null],
          },
        },
        {
          id: 'tfrontdesk',
          label: 'Front desk',
          number: '+35315924400',
          when: 'Billing questions',
          warm: null,
          hours: null,
        },
      ],
      triggers: ['Caller mentions severe pain or swelling', 'Caller asks for a dentist by name'],
      callbackSlaMinutes: 60,
      page: null,
    },
    guardrails: {
      neverDiscuss: ['Prices for treatment plans', 'Medical advice'],
      alwaysEscalate: ['Complaints'],
      disclosure: 'if_asked',
    },
    customTools: [
      {
        id: 'tool1',
        name: 'check_insurance',
        description: "Checks whether a patient's insurer is accepted",
        url: 'https://example.com/api/insurance',
        method: 'POST',
        timeoutSecs: 10,
        authHeader: 'Authorization',
        hasSecret: true,
        enabled: true,
        params: [{ name: 'insurer', type: 'string', description: 'Insurer name', required: true }],
      },
    ],
    // Access levels per connected calendar; the list itself follows the
    // account's connections at request time. 'read' is what legacy 'busy'
    // arrives as.
    calendars: [
      { id: 'int-google', provider: 'google', name: 'Google Calendar', level: 'book' },
      { id: 'int-outlook', provider: 'outlook', name: 'Microsoft Calendar', level: 'read' },
    ],
    setup: {
      items: [
        { key: 'voice', done: true },
        { key: 'greeting', done: true },
        { key: 'transfer', done: true },
        { key: 'calendar', done: true },
        { key: 'behaviour', done: false },
      ],
      percent: 80,
    },
    numberCountries: [],
  };
}

/** The optional second receptionist (EXPO_PUBLIC_MOCK_ASSISTANTS=2): off, no number. */
export function buildSecondAssistant(now: number): MockAssistant {
  const first = buildAssistant(now, 'Leo', 'Harbour Dental Cork');
  return {
    ...first,
    id: 'a2',
    createdAt: iso(now - 10 * DAY),
    enabled: false,
    escalation: { ...first.escalation, targets: [], triggers: [] },
    customTools: [],
    calendars: [],
    setup: {
      items: [
        { key: 'voice', done: true },
        { key: 'greeting', done: true },
        { key: 'transfer', done: false },
        { key: 'calendar', done: false },
        { key: 'behaviour', done: false },
      ],
      percent: 40,
    },
  };
}

/** A new, bare receptionist from "Add a receptionist". */
export function blankAssistant(id: string, name: string, now: number): MockAssistant {
  const first = buildAssistant(now, name);
  return {
    ...first,
    id,
    createdAt: iso(now),
    systemPrompt: '',
    escalation: { targets: [], triggers: [], callbackSlaMinutes: null, page: null },
    guardrails: { neverDiscuss: [], alwaysEscalate: [], disclosure: 'if_asked' },
    customTools: [],
    calendars: [],
    setup: {
      items: [
        { key: 'voice', done: true },
        { key: 'greeting', done: true },
        { key: 'transfer', done: false },
        { key: 'calendar', done: false },
        { key: 'behaviour', done: false },
      ],
      percent: 40,
    },
  };
}

// ── Countries, plans, voices ────────────────────────────────────────────────

/** web lib/number-pricing.ts COUNTRY_RATES + DIAL_PREFIXES. */
const COUNTRIES: { code: string; name: string; flag: string; perMinuteUsd: number; dial: string }[] = [
  { code: 'US', name: 'United States', flag: '🇺🇸', perMinuteUsd: 0.0085, dial: '+1' },
  { code: 'CA', name: 'Canada', flag: '🇨🇦', perMinuteUsd: 0.0085, dial: '+1' },
  { code: 'GB', name: 'United Kingdom', flag: '🇬🇧', perMinuteUsd: 0.01, dial: '+44' },
  { code: 'IE', name: 'Ireland', flag: '🇮🇪', perMinuteUsd: 0.01, dial: '+353' },
  { code: 'NL', name: 'Netherlands', flag: '🇳🇱', perMinuteUsd: 0.01, dial: '+31' },
  { code: 'FR', name: 'France', flag: '🇫🇷', perMinuteUsd: 0.011, dial: '+33' },
  { code: 'DE', name: 'Germany', flag: '🇩🇪', perMinuteUsd: 0.011, dial: '+49' },
  { code: 'ES', name: 'Spain', flag: '🇪🇸', perMinuteUsd: 0.011, dial: '+34' },
  { code: 'IT', name: 'Italy', flag: '🇮🇹', perMinuteUsd: 0.012, dial: '+39' },
  { code: 'SE', name: 'Sweden', flag: '🇸🇪', perMinuteUsd: 0.013, dial: '+46' },
  { code: 'PT', name: 'Portugal', flag: '🇵🇹', perMinuteUsd: 0.013, dial: '+351' },
  { code: 'BE', name: 'Belgium', flag: '🇧🇪', perMinuteUsd: 0.013, dial: '+32' },
  { code: 'PL', name: 'Poland', flag: '🇵🇱', perMinuteUsd: 0.014, dial: '+48' },
  { code: 'AU', name: 'Australia', flag: '🇦🇺', perMinuteUsd: 0.016, dial: '+61' },
  { code: 'NZ', name: 'New Zealand', flag: '🇳🇿', perMinuteUsd: 0.02, dial: '+64' },
  { code: 'AT', name: 'Austria', flag: '🇦🇹', perMinuteUsd: 0.02, dial: '+43' },
  { code: 'CH', name: 'Switzerland', flag: '🇨🇭', perMinuteUsd: 0.02, dial: '+41' },
  { code: 'CZ', name: 'Czechia', flag: '🇨🇿', perMinuteUsd: 0.03, dial: '+420' },
  { code: 'SK', name: 'Slovakia', flag: '🇸🇰', perMinuteUsd: 0.085, dial: '+421' },
];

export const COUNTRY_LIST = COUNTRIES.map(({ code, name, flag }) => ({ code, name, flag }));

/** The server's creditsPerMinute: the rate relative to the cheapest country, at least 1. */
export function numberCountries(includedMinutes: number | null) {
  return COUNTRIES.map((c) => {
    const creditsPerMinute = Math.max(1, Math.round(c.perMinuteUsd / 0.0085));
    return {
      code: c.code,
      name: c.name,
      flag: c.flag,
      creditsPerMinute,
      estMinutes: includedMinutes === null ? null : Math.floor(includedMinutes / creditsPerMinute),
    };
  });
}

/** A plausible number to hand out in a country. */
export function numberIn(country: string): string {
  const dial = COUNTRIES.find((c) => c.code === country)?.dial ?? '+1';
  const tail: Record<string, string> = { '+353': '15924410', '+1': '4155550199', '+44': '2071838750' };
  return `${dial}${tail[dial] ?? '123456789'}`;
}

function plan(
  id: 'solo' | 'team',
  name: string,
  tagline: string,
  monthlyAmountCents: number,
  highlight: boolean,
  included: string[],
  features: string[],
  limits: { minutesIncluded: number; phoneNumbers: number; concurrentCalls: number; contacts: number },
): OnboardingPlan {
  const annualAmountCents = Math.round(monthlyAmountCents * 12 * 0.85);
  return {
    id,
    name,
    tagline,
    monthlyAmountCents,
    annualAmountCents,
    annualMonthlyCents: Math.round(annualAmountCents / 12),
    currency: 'eur',
    highlight,
    included,
    features,
    storeProductIds: {
      ios: {
        monthly: `com.aireceptionistnow.app.${id}.monthly`,
        annual: `com.aireceptionistnow.app.${id}.annual`,
      },
      android: {
        monthly: `${id}:monthly`,
        annual: `${id}:annual`,
        packageMonthly: `${id}_monthly`,
        packageAnnual: `${id}_annual`,
      },
    },
    storeIncluded: included
      .map((line) => line.split(' - €')[0].trim())
      .filter((line) => line !== '' && !line.startsWith('€')),
    storeFeatures: features.filter((f) => !['Connect own SIP', 'Outbound calls & Campaigns'].includes(f)),
    ...limits,
  };
}

/** web lib/plans.ts PLANS, through lib/mobile/plans.ts. */
export const PLANS: OnboardingPlan[] = [
  plan(
    'solo',
    'Solo',
    'Suitable for 1-20 calls/day',
    9900,
    false,
    [
      '1000 minutes - €0.09 per extra minute',
      '1,000 contacts',
      'No parallel calls',
      '1 phone number - €7/mo per additional',
      'Assistants',
      '1 user',
    ],
    ['20+ voices', '25+ languages', 'Scheduler'],
    { minutesIncluded: 1000, phoneNumbers: 1, concurrentCalls: 1, contacts: 1000 },
  ),
  plan(
    'team',
    'Team',
    'Suitable for 20-100 calls/day',
    29900,
    true,
    [
      '3000 minutes - €0.09 per extra minute',
      '3,000 contacts',
      '3 concurrent calls',
      '3 phone numbers - €7/mo per additional',
      'Assistants',
      'Users',
    ],
    ['Everything in Solo', 'Connect own SIP', 'Outbound calls & Campaigns'],
    { minutesIncluded: 3000, phoneNumbers: 3, concurrentCalls: 3, contacts: 3000 },
  ),
];

export const PLAN_TERMS = { annualDiscount: 0.15, extraMinuteEur: 0.09 };

/** web FALLBACK_VOICES. Previews are null: mock mode has no ElevenLabs. */
const VOICES: { voiceId: string; name: string; description: string; gender: 'f' | 'm' }[] = [
  { voiceId: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', description: 'American · professional, calm', gender: 'f' },
  { voiceId: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', description: 'American · professional, soft', gender: 'f' },
  { voiceId: MOCK_VOICE_ID, name: 'Charlotte', description: 'English · friendly', gender: 'f' },
  { voiceId: 'cgSgspJ2msm6clMCkdW9', name: 'Jessica', description: 'American · expressive', gender: 'f' },
  { voiceId: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', description: 'British · warm', gender: 'm' },
  { voiceId: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel', description: 'British · news', gender: 'm' },
  { voiceId: 'TX3LPaxmHKxFdv7VOQHJ', name: 'Liam', description: 'American · narration', gender: 'm' },
  { voiceId: 'pNInz6obpgDQGcFmaJgB', name: 'Adam', description: 'American · deep', gender: 'm' },
];

const FUNNEL_VOICE_IDS = ['21m00Tcm4TlvDq8ikWAM', MOCK_VOICE_ID, 'pNInz6obpgDQGcFmaJgB', 'JBFqnCBsd6RMkjVDRZzb'];

export const VOICE_CATALOG: VoiceCatalog = {
  voices: VOICES.map(({ voiceId, name, description, gender }) => ({
    voiceId,
    name,
    description,
    gender,
    previewUrl: null,
  })),
  funnelVoiceIds: FUNNEL_VOICE_IDS,
  languages: [
    { code: 'multi', name: 'Auto-detect (match caller)', flag: '🌐' },
    { code: 'en', name: 'English', flag: '🇺🇸' },
    { code: 'en-GB', name: 'English (UK)', flag: '🇬🇧' },
    { code: 'es', name: 'Spanish', flag: '🇪🇸' },
    { code: 'fr', name: 'French', flag: '🇫🇷' },
    { code: 'de', name: 'German', flag: '🇩🇪' },
    { code: 'it', name: 'Italian', flag: '🇮🇹' },
    { code: 'pt', name: 'Portuguese', flag: '🇵🇹' },
    { code: 'pl', name: 'Polish', flag: '🇵🇱' },
    { code: 'sk', name: 'Slovak', flag: '🇸🇰' },
  ],
};

export const CATALOG: Catalog = {
  plans: PLANS,
  terms: PLAN_TERMS,
  countries: COUNTRY_LIST,
  dialCodes: COUNTRIES.map(({ code, flag, dial }) => ({ code, flag, dial })),
  voices: FUNNEL_VOICE_IDS.map((id) => {
    const v = VOICES.find((x) => x.voiceId === id)!;
    return { voiceId: v.voiceId, name: v.name, description: v.description, gender: v.gender, previewUrl: null };
  }),
};

// ── Knowledge ───────────────────────────────────────────────────────────────

export const MOCK_BUSINESS_ID = 'org-1';

export interface MockKnowledge {
  digest: string;
  notes: string;
  verified: string;
  sources: KnowledgeSourceRow[];
  gaps: KnowledgeGap[];
  ownerNotesShared: boolean;
}

export function buildKnowledge(now: number): MockKnowledge {
  return {
    digest:
      `${MOCK_BUSINESS} is a family dental practice at 12 Pearse Street, Dublin 2. Open Monday to Friday, ` +
      '8:30 to 18:00 (Thursdays until 18:00, closed weekends). Taking new patients. Check-ups, cleanings, ' +
      'fillings, crowns and whitening. Emergency slots every morning from 8:45. Pay and display parking on ' +
      'Pearse Street; Pearse DART station is two minutes away.',
    notes: 'Dr. Byrne is off every second Friday. Never quote treatment prices over the phone.',
    verified:
      'Do you take new patients? | Yes, we are taking new patients.\n' +
      'Are you open on Saturdays? | No, we are open Monday to Friday only.\n' +
      'Is there parking? | Pay and display on Pearse Street.',
    sources: [
      {
        id: 'src-web',
        kind: 'website',
        title: 'harbourdental.ie',
        url: 'https://harbourdental.ie',
        summary: 'Services, opening hours, team and contact details.',
        charCount: 18_240,
        addedAt: iso(now - 30 * DAY),
      },
      {
        id: 'src-pdf',
        kind: 'pdf',
        title: 'Patient information 2026.pdf',
        url: '',
        summary: 'Cancellation policy, what to bring to a first visit, payment options.',
        charCount: 6_120,
        addedAt: iso(now - 21 * DAY),
      },
      {
        id: 'src-text',
        kind: 'text',
        title: 'Emergency policy',
        url: '',
        summary: 'Emergency slots are held each morning; severe swelling goes to Dr. Byrne directly.',
        charCount: 640,
        addedAt: iso(now - 9 * DAY),
      },
    ],
    gaps: [
      {
        id: 101,
        kind: 'unanswered',
        topic: 'Do you offer payment plans?',
        quote: 'Can I pay for the implant in instalments?',
        createdAt: iso(now - 1 * DAY),
        callId: 'c-004',
      },
      {
        id: 102,
        kind: 'unanswered',
        topic: 'Is there wheelchair access?',
        quote: "My mother uses a wheelchair - can she get into the surgery?",
        createdAt: iso(now - 2 * DAY),
        callId: 'c-009',
      },
      {
        id: 103,
        kind: 'unanswered',
        topic: 'Do you accept the medical card?',
        quote: 'Do you take the medical card for fillings?',
        createdAt: iso(now - 4 * DAY),
        callId: null,
      },
      {
        id: 104,
        kind: 'not_offered',
        topic: 'Orthodontics / braces',
        quote: 'Do you do Invisalign or braces for teenagers?',
        createdAt: iso(now - 3 * DAY),
        callId: 'c-015',
      },
    ],
    ownerNotesShared: true,
  };
}

// ── Account ─────────────────────────────────────────────────────────────────

export function buildProfile(filled: boolean): SettingsState['profile'] {
  return {
    fullName: 'Alex Morgan',
    company: filled ? MOCK_BUSINESS : '',
    role: filled ? 'Practice manager' : '',
    phone: filled ? MOCK_OWNER_PHONE : '',
    // Empty for a fresh account: the app then sends the phone's zone and the
    // server answers with `timezoneIsAccount: false`.
    timezone: filled ? MOCK_TZ : '',
    about: filled ? 'Family dental practice in Dublin 2, open weekdays.' : '',
    shareWithAssistants: filled,
  };
}

/** A short list is enough for a picker; the server sends Intl.supportedValuesOf('timeZone'). */
export const TIMEZONES = [
  'Europe/Dublin', 'Europe/London', 'Europe/Lisbon', 'Europe/Madrid', 'Europe/Paris', 'Europe/Berlin',
  'Europe/Amsterdam', 'Europe/Rome', 'Europe/Prague', 'Europe/Bratislava', 'Europe/Warsaw',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Toronto',
  'Australia/Sydney', 'Pacific/Auckland', 'UTC',
];

export function buildDevices(now: number): AccountDevice[] {
  return [
    {
      deviceId: 'mock-device-iphone',
      platform: 'ios',
      model: 'iPhone 17 Pro',
      osVersion: 'iOS 26.0',
      appVersion: '1.0.0',
      lastSeenAt: iso(now),
      createdAt: iso(now - 30 * DAY),
      current: true,
    },
    {
      deviceId: 'mock-device-ipad',
      platform: 'ios',
      model: 'iPad Air',
      osVersion: 'iPadOS 26.0',
      appVersion: '1.0.0',
      lastSeenAt: iso(now - 3 * DAY),
      createdAt: iso(now - 60 * DAY),
    },
    {
      deviceId: 'mock-device-pixel',
      platform: 'android',
      model: 'Pixel 9',
      osVersion: 'Android 16',
      appVersion: '0.9.0',
      lastSeenAt: iso(now - 20 * DAY),
      createdAt: iso(now - 90 * DAY),
    },
  ];
}

// ── Billing ─────────────────────────────────────────────────────────────────

export type MockBillingKind = 'none' | 'apple' | 'google' | 'stripe' | 'stripe_past_due' | 'comp';

export const MOCK_BILLING_KINDS: readonly MockBillingKind[] = [
  'none',
  'apple',
  'google',
  'stripe',
  'stripe_past_due',
  'comp',
];

export const NO_BILLING: BillingSnapshot = {
  provider: null,
  plan: null,
  cycle: null,
  status: null,
  active: false,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  environment: null,
  providerRef: null,
};

/** One snapshot per MOCK_BILLING value. `sandbox` marks store purchases as test ones. */
export function buildBilling(kind: MockBillingKind, sandbox: boolean, now: number, userId: string): BillingSnapshot {
  const storeEnv = sandbox ? 'Sandbox' : 'Production';
  switch (kind) {
    case 'apple':
      return {
        provider: 'apple',
        plan: 'solo',
        cycle: 'monthly',
        status: 'active',
        active: true,
        currentPeriodEnd: iso(now + 16 * DAY),
        cancelAtPeriodEnd: false,
        environment: storeEnv,
        providerRef: '2000000912345678',
      };
    case 'google':
      return {
        provider: 'google',
        plan: 'solo',
        cycle: 'annual',
        status: 'active',
        active: true,
        currentPeriodEnd: iso(now + 200 * DAY),
        cancelAtPeriodEnd: false,
        environment: storeEnv,
        providerRef: userId,
      };
    case 'stripe':
      return {
        provider: 'stripe',
        plan: 'solo',
        cycle: 'monthly',
        status: 'active',
        active: true,
        currentPeriodEnd: iso(now + 12 * DAY),
        cancelAtPeriodEnd: false,
        environment: null,
        providerRef: null,
      };
    case 'stripe_past_due':
      return {
        provider: 'stripe',
        plan: 'solo',
        cycle: 'monthly',
        status: 'past_due',
        active: false,
        currentPeriodEnd: iso(now + 20 * DAY),
        cancelAtPeriodEnd: false,
        environment: null,
        providerRef: null,
      };
    case 'comp':
      return {
        provider: 'comp',
        plan: 'solo',
        cycle: null,
        status: 'active',
        active: true,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        environment: null,
        providerRef: null,
      };
    default:
      return { ...NO_BILLING };
  }
}

// ── Onboarding ──────────────────────────────────────────────────────────────

export function onboardingConfig(filled: boolean, now: number): OnboardingState['config'] {
  if (!filled) {
    return {
      companyName: '',
      companyWebsite: '',
      assistantName: '',
      voiceId: '',
      voiceGender: 'f',
      country: '',
      alertsEmail: '',
      alertPhone: '',
      knowledgeDone: false,
      calendarDone: false,
      sources: [],
    };
  }
  return {
    companyName: MOCK_BUSINESS,
    companyWebsite: 'https://harbourdental.ie',
    assistantName: MOCK_ASSISTANT,
    voiceId: MOCK_VOICE_ID,
    voiceGender: 'f',
    country: 'IE',
    alertsEmail: MOCK_OWNER_EMAIL,
    alertPhone: MOCK_OWNER_PHONE,
    knowledgeDone: true,
    calendarDone: true,
    sources: [
      {
        id: `src-${now.toString(36)}`,
        kind: 'text',
        title: 'Opening hours',
        summary: 'Open Monday to Friday, 8:30 to 18:00.',
      },
    ],
  };
}
