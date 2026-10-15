import type { Session } from '@supabase/supabase-js';

import { mockDelay, mockShouldFail } from './state';

/**
 * DEV ONLY (EXPO_PUBLIC_MOCK=1). The fake signed-in session behind mock mode.
 *
 * Never imported statically: context/AuthContext.tsx reaches it through an
 * inline `if (__DEV__ && process.env.EXPO_PUBLIC_MOCK === '1') require(...)`,
 * which a release build folds away together with this whole folder.
 *
 * `EXPO_PUBLIC_MOCK_SESSION=guest` starts signed out (the guest funnel); any
 * other value starts signed in as Alex Morgan. Signing in from the mock sign-in
 * screen accepts any 6-digit code - except the review code below, which fails
 * the normal check on purpose so the App Review fallback path gets exercised.
 */

export const MOCK_USER_ID = '00000000-0000-4000-8000-000000000001';
const MOCK_EMAIL = 'owner@example.com';

/**
 * The mock review route's code (lib/mock/server.ts answers 404 for any other).
 * The normal code check rejects it, like Supabase rejects a code it never sent.
 */
export const MOCK_REVIEW_CODE = '000000';

const TEN_YEARS_S = 10 * 365 * 24 * 60 * 60;

function build(email: string): Session {
  const nowS = Math.floor(Date.now() / 1000);
  return {
    access_token: 'mock',
    refresh_token: 'mock',
    expires_in: TEN_YEARS_S,
    expires_at: nowS + TEN_YEARS_S,
    token_type: 'bearer',
    user: {
      id: MOCK_USER_ID,
      email,
      user_metadata: { full_name: 'Alex Morgan' },
      app_metadata: {},
      aud: 'authenticated',
      created_at: new Date((nowS - 90 * 24 * 60 * 60) * 1000).toISOString(),
    },
  };
}

/** undefined = not seeded from the environment yet. */
let current: Session | null | undefined;

/** The session mock mode starts with, then whatever sign-in / sign-out made of it. */
export function mockSession(): Session | null {
  if (current === undefined) {
    current = process.env.EXPO_PUBLIC_MOCK_SESSION === 'guest' ? null : build(MOCK_EMAIL);
  }
  return current;
}

export function setMockSession(next: Session | null): void {
  current = next;
}

export function startMockSession(email?: string): Session {
  current = build(email?.trim() || MOCK_EMAIL);
  return current;
}

/** Whether the mock backend should treat requests as authenticated. */
export function mockSignedIn(): boolean {
  return mockSession() !== null;
}

/** supabase.auth.signInWithOtp, mocked. EXPO_PUBLIC_MOCK_FAIL=otp makes it fail. */
export async function mockSendCode(email: string): Promise<string | null> {
  await mockDelay();
  if (mockShouldFail('POST /auth/v1/otp')) return 'Error sending magic link email';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return 'Unable to validate email address: invalid format';
  }
  return null;
}

/** supabase.auth.verifyOtp, mocked: any 6-digit code but the review one. */
export async function mockVerifyCode(_email: string, code: string): Promise<string | null> {
  await mockDelay();
  if (mockShouldFail('POST /auth/v1/verify') || !/^\d{6}$/.test(code) || code === MOCK_REVIEW_CODE) {
    return 'Token has expired or is invalid';
  }
  return null;
}
