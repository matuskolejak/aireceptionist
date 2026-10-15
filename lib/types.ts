/**
 * The wire shapes returned by `/api/mobile/*` in the web repo.
 *
 * These mirror `lib/dashboard/*` types there but are NOT a copy of them: the
 * routes project a narrower payload (no system prompts on list endpoints, no
 * ElevenLabs mirrors, no knowledge blobs). When a route changes, change the
 * matching type here - there is no shared package between the two repos to keep
 * them honest.
 */

export interface TodayUsage {
  calls: number;
  answered: number;
  missed: number;
  booked: number;
}

export interface MonthUsage {
  callsThisMonth: number;
  minutes: number;
  bookings: number;
}

export interface Latency {
  medianMs: number;
  p95Ms: number;
  targetMs: number;
  degraded: boolean;
}

export interface Bar {
  label: string;
  value: number;
}

export type Sentiment = 'positive' | 'neutral' | 'negative' | 'frustrated' | 'angry';

/** A row in the Home tab's recent-activity list. */
export interface RecentCall {
  id: string;
  name: string;
  number: string;
  flag: string;
  duration: string;
  /** Raw DB value (booked | message | transferred | resolved | abandoned). */
  outcome: string | null;
  sentiment: Sentiment;
  agoMinutes: number;
  /** Formatted clock label in the owner's zone, not a date - never parse it. */
  at: string;
  /** Raw DB status (completed / no-answer / in-progress ...), for `statusBucket`. */
  status: string;
  /** ISO start time. The stale-live rule and any date math read this, not `at`. */
  startedAt: string;
}

export interface Booking {
  id: string;
  callId: string;
  startTime: string;
  endTime: string;
  title: string;
  attendeeName: string;
  attendeePhone: string;
  notes: string;
  status: 'pending' | 'done' | 'failed' | 'cancelled';
  externalId: string | null;
  error: string | null;
  bookedAt: string;
  callerNumber: string;
  assistant: string | null;
  provider: string | null;
  syncAttempts: number;
  cancellation: {
    reason: string;
    offerRebook: boolean;
    notifyStatus: 'pending' | 'calling' | 'answered' | 'sms_sent' | 'failed';
  } | null;
}

/** One slice of the sentiment donut. `color` is chosen server-side so both surfaces agree. */
export interface Segment {
  label: string;
  key?: string;
  value: number;
  color: string;
}

/**
 * The month view. Null unless the request asked for `range=month`, exactly like
 * the web page, which skips the 30-day rollup on today's view.
 */
export interface MonthAnalytics {
  totals: { calls: number; avgDuration: string; answerRate: string; bookings: number };
  /** 30 days - NOT `Overview.callVolume`, which is 14. */
  volume: Bar[];
  sentiment: Segment[];
}

export interface Overview {
  today: TodayUsage;
  monthUsage: MonthUsage;
  latency: Latency;
  recentCalls: RecentCall[];
  analytics: MonthAnalytics | null;
  assistant: { id: string; name: string; enabled: boolean } | null;
  assistantCount: number;
  online: boolean;
  number: string;
  calendarConnected: boolean;
  /** `minutesIncluded: 0` means the tier has no cap - see the route's comment. */
  plan: { name: string; active: boolean; minutesIncluded: number } | null;
  upcoming: Booking[];
  /** Booking requests with no usable date, waiting on a person to confirm. */
  toConfirm: number;
  timezone: string;
}

/**
 * An event already on a connected Google/Outlook calendar - NOT something the
 * receptionist booked. Merged into the agenda because the dashboard merges it
 * too; a phone showing only bookings reports a emptier day than the web does.
 */
export interface ExternalEvent {
  id: string;
  integrationId: string;
  provider: string;
  providerLabel: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  url: string;
}

export interface CallLogRow {
  key: string;
  dbId: string | null;
  sid: string;
  date: string;
  dateLabel: string;
  status: string;
  statusLabel: string;
  direction: string;
  from: string;
  to: string;
  durationSec: number;
  durationLabel: string;
  outcome: string | null;
  assistant: string | null;
  source: 'twilio' | 'db' | 'both';
  needsReview: boolean;
}

export interface CallLog {
  rows: CallLogRow[];
  twilioConnected: boolean;
  /** The owner's IANA zone every `dateLabel` is in. Group and label rows by it. */
  timezone: string;
  /** The last row's `date` when older rows remain - pass it back as `before`. */
  nextCursor: string | null;
}

export interface CallTurn {
  id: number;
  role: string;
  text: string;
  tsMs: number;
  atLabel: string;
}

export interface CallActionItem {
  id: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  error: string | null;
}

export interface CallDetail {
  id: string;
  sid: string;
  date: string;
  dateLabel: string;
  status: string;
  statusLabel: string;
  direction: string;
  from: string;
  to: string;
  durationLabel: string;
  outcome: string | null;
  sentiment: string | null;
  summary: string | null;
  assistant: string | null;
  recordingUrl: string | null;
  /** True when the call's audio can be streamed from /api/mobile/calls/[id]/recording. */
  hasAudio: boolean;
  isLive: boolean;
  needsReview: boolean;
  reviewClaims: string[];
  turns: CallTurn[];
  actions: CallActionItem[];
}

export interface AssistantSummary {
  id: string;
  name: string;
  greeting: string;
  language: string;
  enabled: boolean;
  createdAt: string;
  connected: boolean;
  number: string;
}

// ── Assistant detail ────────────────────────────────────────────────────────

/** One weekly schedule. `days[0]` is Sunday, matching `Date.getDay()`. */
export interface WeeklyHours {
  timezone: string;
  days: ({ start: string; end: string } | null)[];
}

export interface EscalationTarget {
  id: string;
  label: string;
  number: string;
  when: string;
  /** null means "not chosen", which is NOT the same as cold. See the web type. */
  warm: boolean | null;
  hours: WeeklyHours | null;
}

export interface CustomToolParam {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description: string;
  required: boolean;
}

export interface AssistantCustomTool {
  id: string;
  name: string;
  description: string;
  url: string;
  method: 'GET' | 'POST';
  timeoutSecs: number;
  authHeader: string;
  hasSecret: boolean;
  enabled: boolean;
  params: CustomToolParam[];
}

export type SetupKey = 'voice' | 'greeting' | 'transfer' | 'calendar' | 'behaviour';

export interface AssistantDetail {
  id: string;
  name: string;
  greeting: string;
  systemPrompt: string;
  language: string;
  voiceId: string;
  voiceName: string;
  enabled: boolean;
  connected: boolean;
  number: string;
  numberId: string;
  /** The account zone, else the `tz` the app sent, else 'UTC'. */
  timezone: string;
  /** False when `timezone` is the phone's zone because the account has none saved. */
  timezoneIsAccount: boolean;
  planActive: boolean;
  /** Whether a number request would pass the plan gate right now. */
  canAddNumber: boolean;
  /** False only for an agent on the English-only model. */
  multilingual: boolean;
  smsAlerts: boolean;
  emailTranscripts: { enabled: boolean; to: string };
  voice: {
    tier: 'fast' | 'natural';
    speed: number;
    stability: number;
    byLanguage: Record<string, string>;
  };
  escalation: {
    targets: EscalationTarget[];
    triggers: string[];
    callbackSlaMinutes: number | null;
    page: { enabled: boolean; number: string } | null;
  };
  guardrails: {
    neverDiscuss: string[];
    alwaysEscalate: string[];
    /**
     * Only two modes exist. The server runs the stored value through
     * `parseDisclosure`, which lands anything unrecognised - including the
     * retired "deflect" still on older assistants - on 'if_asked', so a third
     * value can never reach the client and must not be offered back.
     */
    disclosure: 'if_asked' | 'upfront';
  };
  customTools: AssistantCustomTool[];
  /** `level` is 'none' | 'read' | 'book' ... - legacy 'busy' arrives as 'read'. */
  calendars: { id: string; provider: string; name: string; level: string }[];
  setup: { items: { key: SetupKey; done: boolean }[]; percent: number };
  numberCountries: NumberCountryOption[];
}

/** A country the "get a number" picker offers, with what the plan's minutes buy there. */
export interface NumberCountryOption {
  code: string;
  name: string;
  flag: string;
  creditsPerMinute: number;
  /** Talk time the plan's included minutes buy at this rate; null without an active plan. */
  estMinutes: number | null;
}

/**
 * The section markers `buildAssistantPatch` reads on the server.
 *
 * A save must name every section it carries: a field whose section is absent is
 * left alone, and a checkbox whose section IS present but whose key is absent is
 * read as off. Get this wrong and a save silently wipes config - which is the
 * entire reason the patch layer exists. Mirrors `SECTION` in
 * lib/dashboard/assistant-patch.ts.
 */
export const SECTION = {
  basics: '_s_basics',
  role: '_s_role',
  alerts: '_s_alerts',
  calendar: '_s_calendar',
  email: '_s_email',
  voice: '_s_voice',
  voiceLang: '_s_voicelang',
  crm: '_s_crm',
  escalation: '_s_escalation',
  guardrails: '_s_guardrails',
  customTools: '_s_customtools',
} as const;

export interface AssistantPatch {
  sections: string[];
  /** Booleans become checkboxes: true -> "on", false -> the key is omitted. */
  fields: Record<string, string | number | boolean | undefined>;
}

// ── Voices ──────────────────────────────────────────────────────────────────

export interface VoiceOption {
  voiceId: string;
  name: string;
  description: string;
  gender: 'f' | 'm' | null;
  previewUrl: string | null;
}

export interface LanguageOption {
  code: string;
  name: string;
  flag: string;
}

export interface VoiceCatalog {
  voices: VoiceOption[];
  funnelVoiceIds: string[];
  languages: LanguageOption[];
}

// ── Knowledge ───────────────────────────────────────────────────────────────

export interface KnowledgeSourceRow {
  id: string;
  kind: 'website' | 'pdf' | 'text';
  title: string;
  url: string;
  summary: string;
  charCount: number;
  addedAt: string;
}

/** A question the receptionist could not answer, or a service callers asked for that is not offered. */
export interface KnowledgeGap {
  /** The demand signal id - `signalId` in the answerGap / dismissGap actions. */
  id: number;
  kind: 'unanswered' | 'not_offered';
  topic: string;
  /** The caller's own words. */
  quote: string;
  createdAt: string;
  callId: string | null;
}

export interface KnowledgeState {
  businesses: { id: string; name: string }[];
  activeBusinessId: string;
  digest: string;
  notes: string;
  /** "Question | Answer" lines, the same text format the web textarea uses. */
  verified: string;
  sources: KnowledgeSourceRow[];
  ownerNotesShared: boolean;
  calendarsConnected: number;
  /** The open "Questions it could not answer" list, the same one the web shows. */
  gaps: KnowledgeGap[];
  /** The digest is being rebuilt - refetch shortly. */
  digestPending: boolean;
}

// ── Settings ────────────────────────────────────────────────────────────────

export interface SettingsState {
  profile: {
    fullName: string;
    company: string;
    role: string;
    phone: string;
    timezone: string;
    about: string;
    shareWithAssistants: boolean;
  };
  notifications: {
    email: boolean;
    emailAddress: string;
    sms: boolean;
    /** Falls back to the profile phone when no alert number is saved. */
    smsNumber: string;
  };
  /** A company rename only renames the business when there is exactly one. */
  businessCount: number;
  plan: {
    id: string | null;
    name: string;
    active: boolean;
    minutesIncluded: number;
    numbersUsed: number;
    numbersIncluded: number;
    assistantsUsed: number;
    assistantsIncluded: number;
  } | null;
  timezones: string[];
}

export interface Account {
  profile: {
    fullName: string;
    company: string;
    role: string;
    phone: string;
    timezone: string;
  };
  notifications: {
    email: boolean;
    emailAddress: string;
    sms: boolean;
    smsNumber: string;
  };
  plan: {
    id: string | null;
    name: string;
    active: boolean;
    minutesIncluded: number;
    numbersIncluded: number;
    numbersUsed: number;
    assistantsUsed: number;
    /** The plan card's limit rows. 0 = unlimited (Infinity does not survive JSON). */
    limits: {
      phoneNumbers: number;
      concurrentCalls: number;
      minutesIncluded: number;
      contacts: number;
      users: number;
    };
  } | null;
  numbers: { id: string; e164: string }[];
}

/** DELETE /api/mobile/account. */
export interface DeleteAccountResult {
  ok: true;
  /** A store subscription the server could not cancel - send the user to that store. */
  storeSubscription: 'apple' | 'google' | null;
  warnings: string[];
}

// ── Calendar connections ────────────────────────────────────────────────────

export interface CalendarConnection {
  id: string;
  provider: string;
  name: string;
  account: string;
  isPrimary: boolean;
  needsReconnect: boolean;
}

export interface CalendarConnections {
  connected: CalendarConnection[];
  /**
   * The providers a calendar can be connected from. The link is minted at tap
   * time with `api.webLink({ target: 'calendar', provider, returnUrl })`.
   */
  connectable: {
    id: string;
    name: string;
  }[];
}

/** GET /api/mobile/calendar. */
export interface CalendarState {
  bookings: Booking[];
  events: ExternalEvent[];
  /** The account zone, else the `tz` the app sent, else 'UTC'. */
  timezone: string;
  /** False when `timezone` is the phone's zone because the account has none saved. */
  timezoneIsAccount: boolean;
}

// ── Onboarding ──────────────────────────────────────────────────────────────

export interface OnboardingPlan {
  id: string;
  name: string;
  tagline: string;
  monthlyAmountCents: number;
  /** The full yearly charge on the annual cycle, already discounted. */
  annualAmountCents: number;
  /** What the annual charge works out to per month - the figure the card leads with. */
  annualMonthlyCents: number;
  currency: string;
  highlight: boolean;
  included: string[];
  features: string[];
  /** The store identifiers that buy this plan. The app never hardcodes a sku. */
  storeProductIds: StoreProductIds;
  /** `included` minus Stripe-only price lines (overage, extra numbers). */
  storeIncluded: string[];
  /**
   * `features` minus lines the product does not deliver yet. Store paywalls
   * render this, never `features` - App Review checks the list against the app.
   */
  storeFeatures: string[];
  minutesIncluded: number;
  phoneNumbers: number;
  concurrentCalls: number;
  contacts: number;
}

/** Catalogue-level numbers quoted outside any one plan. */
export interface PlanTerms {
  /** 0.15 = the annual cycle's 15% off. Rendered as the "save" badge. */
  annualDiscount: number;
  extraMinuteEur: number;
}

/** The anonymous payload behind the guest funnel and the pricing screen. */
export interface Catalog {
  plans: OnboardingPlan[];
  terms: PlanTerms;
  countries: { code: string; name: string; flag: string }[];
  /** Prefixes for the transfer-number field, from the server's DIAL_OPTIONS. */
  dialCodes: { code: string; flag: string; dial: string }[];
  voices: {
    voiceId: string;
    name: string;
    description: string;
    gender: 'f' | 'm';
    previewUrl: string | null;
  }[];
}

export type BillingCycle = 'monthly' | 'annual';

export interface StoreProductIds {
  /** App Store product ids, e.g. 'com.aireceptionistnow.app.solo.monthly'. */
  ios: { monthly: string; annual: string };
  /**
   * Google Play product ids as RevenueCat names them ('solo:monthly'), plus
   * the RevenueCat package ids in the default offering ('solo_monthly').
   */
  android: { monthly: string; annual: string; packageMonthly: string; packageAnnual: string };
}

// ── Billing ─────────────────────────────────────────────────────────────────

export type BillingProvider = 'stripe' | 'apple' | 'google' | 'comp';

/**
 * Why a store purchase is being reported. 'onboarding' and 'pricing' follow a
 * Subscribe tap and must carry `acceptedTerms: true`; 'restore' and
 * 'reconcile' never need it.
 */
export type PurchaseContext = 'onboarding' | 'pricing' | 'restore' | 'reconcile';

/**
 * The account's subscription, whoever bills it. GET /api/mobile/billing and the
 * 2xx body of the store verify / sync routes.
 *
 * LIVE STRIPE rule (the paywall and the server's guard use it word for word):
 * provider 'stripe' AND status in (active, trialing, past_due, unpaid,
 * incomplete) AND (currentPeriodEnd null or in the future). Such an account is
 * billed elsewhere: the app never offers it a purchase, and a store verify
 * answers 409 'stripe_active'. `active` alone is not that rule - it is false
 * for past_due.
 */
export interface BillingSnapshot {
  provider: BillingProvider | null;
  plan: 'solo' | 'team' | null;
  cycle: BillingCycle | null;
  /** Raw: active | trialing | past_due | canceled | paused | ... */
  status: string | null;
  /** (active or trialing) and a plan. */
  active: boolean;
  /** ISO. */
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** Store purchases only; 'Sandbox' is App Review / TestFlight / licence testers. */
  environment: 'Production' | 'Sandbox' | null;
  /** Apple originalTransactionId, or the RevenueCat app user id. Null for Stripe and comp. */
  providerRef: string | null;
}

/**
 * One app install signed into this account.
 *
 * `current` marks the handset that asked. Note that revoking a row does not end
 * that device's session - see the route and migration for why.
 */
export interface AccountDevice {
  deviceId: string;
  platform: string;
  model: string | null;
  osVersion: string | null;
  appVersion: string | null;
  lastSeenAt: string;
  createdAt: string;
  current?: boolean;
}

export interface OnboardingState {
  status: 'draft' | 'provisioning' | 'done' | 'error';
  /** The furthest step the app may open, computed server-side from the config. */
  step: number;
  paid: boolean;
  /** Also true for an account that already owns assistants (the web dashboard's gate). */
  done: boolean;
  /**
   * Always sent by the server. Optional only because the guest funnel builds
   * this shape locally (lib/use-funnel.ts `synthesize`) without it.
   */
  hasAssistants?: boolean;
  /** `sandbox` marks a store sandbox purchase, which deploys without a live number. */
  result: { e164?: string; sandbox?: boolean } | null;
  config: {
    companyName: string;
    companyWebsite: string;
    assistantName: string;
    voiceId: string;
    voiceGender: 'f' | 'm';
    /** '' until the user picks one - the client default (countryForLocale) applies. */
    country: string;
    alertsEmail: string;
    alertPhone: string;
    knowledgeDone: boolean;
    calendarDone: boolean;
    sources: { id: string; kind: string; title: string; summary: string }[];
  };
  calendarsConnected: number;
  countries: { code: string; name: string; flag: string }[];
  plans: OnboardingPlan[];
  planTerms: PlanTerms;
}

export interface ProvisionPoll {
  status: 'guest' | 'nothing' | 'waiting-payment' | 'provisioning' | 'done' | 'error';
  e164?: string;
  error?: string;
  /** Done on a store sandbox purchase: deployed, but no live number. */
  sandbox?: boolean;
}

export interface NotificationItem {
  id: string;
  /** The web bell's English title/subtitle/href. The app formats its own rows from the raw fields below. */
  title: string;
  subtitle: string;
  at: string;
  href: string;
  /** The call this item is about. */
  callId: string | null;
  /** Caller's number as stored, '' when withheld. */
  from: string;
  /** Raw DB outcome (booked / message / ...), null when the call had none. */
  outcome: string | null;
  /** Raw DB status (completed / no-answer / in-progress ...). */
  status: string;
  durationSec: number;
}
