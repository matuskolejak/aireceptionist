/**
 * GoTrue's messages in plain words. The known ones are matched loosely (the
 * wording has shifted between releases); anything else is shown as sent, which
 * is still better than a blank.
 */
export function friendlyAuthError(message: string): string {
  const m = message.toLowerCase();
  if (/expired|invalid|incorrect|not found/.test(m) && /token|otp|code/.test(m)) {
    return 'That code is wrong or has expired. Send a new one.';
  }
  if (/rate limit|too many|security purposes/.test(m)) {
    return 'Too many attempts. Wait a minute and try again.';
  }
  if (/signups? not allowed|disabled/.test(m)) {
    return 'Sign-ups are not open right now.';
  }
  if (/validate email|invalid format|valid email/.test(m)) {
    return 'Enter a valid email address.';
  }
  if (/error sending|magic link|smtp|email/.test(m) && /send|deliver/.test(m)) {
    return 'The email could not be sent. Try again in a moment.';
  }
  if (/network|fetch|connection/.test(m)) {
    return 'No connection. Check your network and try again.';
  }
  return message;
}

/**
 * Google and Apple sign-in errors in plain words: the provider callback, the
 * code exchange and Apple's id token. Unlike friendlyAuthError, an unknown
 * message is not shown as sent: it is provider English that tells an owner
 * nothing. Its "code" is the OAuth code, not the emailed one, so the
 * one-time-code rule in friendlyAuthError would misread it.
 */
export function friendlyOAuthError(message: string): string {
  const m = message.toLowerCase();
  if (/rate limit|too many|security purposes/.test(m)) {
    return 'Too many attempts. Wait a minute and try again.';
  }
  if (/signups? not allowed/.test(m)) {
    return 'Sign-ups are not open right now.';
  }
  if (/unverified email|confirmation email/.test(m)) {
    return 'Confirm your email first: open the link we sent you, then try again.';
  }
  if (/network|fetch|connection/.test(m)) {
    return 'No connection. Check your network and try again.';
  }
  return 'Sign-in did not complete. Try again.';
}
