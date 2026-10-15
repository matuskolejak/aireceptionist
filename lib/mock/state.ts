import type {
  AccountDevice,
  BillingSnapshot,
  Booking,
  CalendarConnection,
  ExternalEvent,
  OnboardingState,
  SettingsState,
} from '../types';
import {
  MOCK_BILLING_KINDS,
  MOCK_BUSINESS,
  MOCK_BUSINESS_ID,
  MOCK_NUMBER,
  buildAssistant,
  buildBilling,
  buildBookings,
  buildCalls,
  buildConnections,
  buildDevices,
  buildEvents,
  buildKnowledge,
  buildProfile,
  buildSecondAssistant,
  onboardingConfig,
  type MockAssistant,
  type MockBillingKind,
  type MockCall,
  type MockKnowledge,
} from './fixtures';

/**
 * DEV ONLY (EXPO_PUBLIC_MOCK=1). The mock backend's in-memory database: one
 * account, seeded from the environment, mutated by the writes lib/mock/server.ts
 * handles, and reset on reload.
 *
 *   EXPO_PUBLIC_MOCK_SETUP     done (default) | funnel (signed in, at the plan
 *                              step) | fresh (signed in, nothing set up - the
 *                              default when EXPO_PUBLIC_MOCK_SESSION=guest, so
 *                              signing in from the guest funnel continues it)
 *   EXPO_PUBLIC_MOCK_BILLING   none | apple | google | stripe | stripe_past_due |
 *                              comp (default: apple when done, none otherwise)
 *   EXPO_PUBLIC_MOCK_SANDBOX   1 = store purchases are test ones (no live number)
 *   EXPO_PUBLIC_MOCK_ASSISTANTS 2 = a second receptionist
 *   EXPO_PUBLIC_MOCK_FAIL      comma-separated substrings; a request whose
 *                              "METHOD /path?query action=<body action>" contains
 *                              one fails with a 500 (e.g. `power`,
 *                              `status=unanswered`, `action=provision`, `otp`)
 *
 * Every value is read as a literal `process.env.EXPO_PUBLIC_*` so Expo inlines
 * it at bundle time.
 */

export type MockSetup = 'done' | 'funnel' | 'fresh';

const FAIL = (process.env.EXPO_PUBLIC_MOCK_FAIL ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** Whether EXPO_PUBLIC_MOCK_FAIL targets this request. */
export function mockShouldFail(haystack: string): boolean {
  return FAIL.some((needle) => haystack.includes(needle));
}

/** A phone's worth of latency, so loading states are visible. */
export function mockDelay(): Promise<void> {
  const ms = 300 + Math.floor(Math.random() * 300);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const MOCK_SANDBOX = process.env.EXPO_PUBLIC_MOCK_SANDBOX === '1';
const EXTRA_ASSISTANT = process.env.EXPO_PUBLIC_MOCK_ASSISTANTS === '2';

function envSetup(): MockSetup {
  const s = process.env.EXPO_PUBLIC_MOCK_SETUP;
  if (s === 'done' || s === 'funnel' || s === 'fresh') return s;
  return process.env.EXPO_PUBLIC_MOCK_SESSION === 'guest' ? 'fresh' : 'done';
}

function envBilling(setup: MockSetup): MockBillingKind {
  const b = process.env.EXPO_PUBLIC_MOCK_BILLING as MockBillingKind | undefined;
  if (b && MOCK_BILLING_KINDS.includes(b)) return b;
  return setup === 'done' ? 'apple' : 'none';
}

export interface MockNumber {
  id: string;
  e164: string;
  assistantId: string;
}

export interface MockState {
  userId: string;
  billing: BillingSnapshot;
  onboarding: {
    status: OnboardingState['status'];
    config: OnboardingState['config'];
    result: OnboardingState['result'];
    /** 'provisioning' answers given since payment landed; the third poll finishes. */
    provisionPolls: number;
  };
  profile: SettingsState['profile'];
  alerts: { email: boolean; sms: boolean };
  assistants: MockAssistant[];
  numbers: MockNumber[];
  calls: MockCall[];
  bookings: Booking[];
  events: ExternalEvent[];
  connections: CalendarConnection[];
  /**
   * Home's "connect a calendar" issue. Deliberately false while the
   * connections screen lists Google as connected, so both screens have their
   * interesting state in one run; connecting a calendar from the app sets it.
   */
  calendarConnected: boolean;
  knowledge: MockKnowledge | null;
  business: { id: string; name: string } | null;
  devices: AccountDevice[];
  pushTokens: Record<string, boolean>;
}

/** Whether the store purchase behind `billing` is a test one. */
export function isSandbox(billing: BillingSnapshot): boolean {
  return billing.active && billing.environment === 'Sandbox';
}

/**
 * Fill the account the way a finished setup leaves it: receptionist, number,
 * call history, bookings, calendars, knowledge. Also what the provisioning poll
 * runs when a funnel purchase completes, so "Open the app" lands on real data.
 */
export function populateAccount(state: MockState, now: number = Date.now()): void {
  const cfg = state.onboarding.config;
  const business = cfg.companyName || MOCK_BUSINESS;
  const first = buildAssistant(now, cfg.assistantName || undefined, business);
  state.assistants = EXTRA_ASSISTANT ? [first, buildSecondAssistant(now)] : [first];
  // No live number without a plan, or on a store test purchase.
  state.numbers =
    state.billing.provider === null || isSandbox(state.billing)
      ? []
      : [{ id: 'n1', e164: MOCK_NUMBER, assistantId: first.id }];
  state.calls = buildCalls(now, first.name);
  state.bookings = buildBookings(now);
  state.events = buildEvents(now);
  state.connections = buildConnections();
  state.calendarConnected = false;
  state.knowledge = buildKnowledge(now);
  state.business = { id: MOCK_BUSINESS_ID, name: business };
  state.profile = { ...buildProfile(true), fullName: state.profile.fullName || 'Alex Morgan', company: business };
  state.alerts = { email: true, sms: true };
}

export function seedState(setup: MockSetup, billingKind: MockBillingKind, userId: string): MockState {
  const now = Date.now();
  const billing = buildBilling(billingKind, MOCK_SANDBOX, now, userId);
  const state: MockState = {
    userId,
    billing,
    onboarding: {
      status: setup === 'done' ? 'done' : 'draft',
      config: onboardingConfig(setup !== 'fresh', now),
      result: null,
      provisionPolls: 0,
    },
    profile: buildProfile(setup !== 'fresh'),
    alerts: { email: true, sms: false },
    assistants: [],
    numbers: [],
    calls: [],
    bookings: [],
    events: [],
    connections: [],
    calendarConnected: false,
    knowledge: null,
    business: null,
    devices: buildDevices(now),
    pushTokens: {},
  };
  if (setup === 'done') {
    populateAccount(state, now);
    state.onboarding.result = state.numbers[0]
      ? { e164: state.numbers[0].e164 }
      : isSandbox(billing)
        ? { sandbox: true }
        : null;
  }
  return state;
}

let state: MockState | null = null;

/** The account. Seeded on first use from the environment. */
export function mockState(userId: string): MockState {
  if (!state) {
    const setup = envSetup();
    state = seedState(setup, envBilling(setup), userId);
  }
  return state;
}

/** After an account deletion: the next sign-in is a brand-new account. */
export function resetMockState(userId: string): void {
  state = seedState('fresh', 'none', userId);
}
