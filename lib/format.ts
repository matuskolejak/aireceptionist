/**
 * Render-time formatting. Mirrors the web's `lib/dashboard/rel-time.ts`, the
 * status buckets in `lib/dashboard/calls/format.ts`, the English dictionary
 * (`lib/i18n/dictionaries/en.ts`) and the grouping rules in `formatPhone`
 * (`lib/call-engine/voice/phone-language.ts`), so the same call reads the same
 * way in both surfaces.
 *
 * The app is English-only, so every Intl call here is pinned to 'en' - a German
 * phone must not read "Mo., 3. März" beside an English "Today".
 */

/** Minutes elapsed -> "2 min ago". */
export function relTime(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const hours = Math.floor(m / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** ISO timestamp -> "2 min ago". Empty string when unparseable. */
export function relTimeOf(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return relTime((Date.now() - ms) / 60000);
}

/**
 * The dialling codes this product actually sells numbers in, longest first.
 *
 * Mirrors the server's DIAL_OPTIONS (see `/api/mobile/catalog`). It is here
 * rather than threaded down from the catalogue because `formatPhone` is called
 * from list rows that have no catalogue in scope, and a number must not render
 * differently depending on which screen it is on.
 *
 * Sorted longest-first so +353 wins over +35, and +1 is only reached once no
 * longer code matches.
 */
const DIAL_CODES = [
  '420', '421', '351', '353',
  '31', '32', '33', '34', '39', '41', '43', '44', '46', '48', '49', '61', '64',
  '1',
].sort((a, b) => b.length - a.length);

/**
 * Groups a national number into threes, measured from the RIGHT.
 *
 * From the left, every length that is not a multiple of three ends on a stub -
 * "159 244 10" for an Irish landline. From the right the stub moves to the
 * front, where a short leading group is what a subscriber number actually looks
 * like in most of the plan's countries.
 *
 * Without libphonenumber's per-country metadata any grouping is a guess; this
 * one is at least a consistent guess that never trails off.
 */
function groupNational(n: string): string {
  if (n.length <= 4) return n;

  const groups: string[] = [];
  let i = n.length;
  while (i - 3 > 0) {
    groups.unshift(n.slice(i - 3, i));
    i -= 3;
  }
  let head = n.slice(0, i);
  // A lone leading digit reads as a typo beside three-digit groups, so it joins
  // the group after it: "7700 900 123", not "7 700 900 123".
  if (head.length === 1 && groups.length > 0) head += groups.shift();
  return [head, ...groups].join(' ');
}

/**
 * E.164 -> a grouped, readable number.
 *
 * The country code is split off FIRST. Grouping the whole string in threes -
 * which is what this used to do - swallows the code into the first group and
 * renders +353 1 592 4410 as "+353 159 244 10" and +44 7700 900123 as
 * "+447 700 900 123", so every number outside North America read as a typo on
 * five different screens.
 *
 * NANP keeps its own shape because it is the one format people actively read as
 * wrong when it is grouped generically.
 */
export function formatPhone(e164: string): string {
  const raw = e164 ?? '';
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) return raw;

  if (digits.length === 11 && digits.startsWith('1')) {
    const n = digits.slice(1);
    return `+1 (${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}`;
  }

  const code = DIAL_CODES.find(
    // A code that consumed the whole number would leave nothing to group, which
    // means it is not really the code - fall through to the generic path.
    (c) => digits.startsWith(c) && digits.length > c.length,
  );
  if (!code) return `+${groupNational(digits)}`;

  return `+${code} ${groupNational(digits.slice(code.length))}`;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** Raw DB outcome -> the headline the dashboard shows for it (en.ts outcome*). */
export function outcomeLabel(outcome: string | null): string {
  switch (outcome) {
    case 'booked':
      return 'Booked an appointment';
    case 'message':
      return 'Took a message';
    case 'transferred':
      return 'Passed the call to you';
    case 'resolved':
      return 'Answered the caller';
    case 'abandoned':
      return 'Caller hung up';
    default:
      return 'Call handled';
  }
}

export type StatusBucket = 'completed' | 'unanswered' | 'active';

/**
 * The one "is this call still live" age limit, the web's LIVE_MAX_AGE_MS. A row
 * still reading in-progress/ringing after this long lost its end webhook; it is
 * over, not live forever.
 */
export const LIVE_MAX_AGE_MS = 4 * 60 * 60 * 1000;

function staleLive(dateIso?: string): boolean {
  if (!dateIso) return false;
  const t = Date.parse(dateIso);
  return Number.isFinite(t) && Date.now() - t > LIVE_MAX_AGE_MS;
}

/**
 * Raw carrier/DB status -> the web's three buckets. A port of `statusBucket`
 * in the web's lib/dashboard/calls/format.ts, including the stale-live rule:
 * pass the call's ISO start so a row stuck in 'in-progress' reads as missed.
 */
export function statusBucket(status: string, dateIso?: string): StatusBucket {
  const s = (status ?? '').toLowerCase();
  if (['busy', 'no-answer', 'failed', 'canceled', 'cancelled', 'abandoned'].includes(s)) {
    return 'unanswered';
  }
  if (['completed', 'resolved', 'booked', 'answered'].includes(s)) return 'completed';
  return staleLive(dateIso) ? 'unanswered' : 'active';
}

/** en.ts statusCompleted / statusUnanswered / statusActive. */
export function bucketLabel(bucket: StatusBucket): string {
  switch (bucket) {
    case 'completed':
      return 'Answered';
    case 'unanswered':
      return 'Missed';
    default:
      return 'In progress';
  }
}

/**
 * The one line a call is summed up by: what the receptionist did, else what
 * happened to the call. `date` is the call's ISO start (for the stale-live rule).
 */
export function callHeadline(call: {
  outcome: string | null;
  status: string;
  date?: string;
}): string {
  if (call.outcome) return outcomeLabel(call.outcome);
  const bucket = statusBucket(call.status, call.date);
  if (bucket === 'unanswered') return 'Missed call';
  if (bucket === 'active') return 'In progress';
  return 'Call handled';
}

/** The caller as a person reads it. An empty `from` is a withheld number. */
export function callerLabel(from: string): string {
  return from ? formatPhone(from) : 'Unknown caller';
}

const SENTIMENT_LABELS: Record<string, string> = {
  positive: 'Positive',
  neutral: 'Neutral',
  negative: 'Negative',
  frustrated: 'Frustrated',
  angry: 'Angry',
};

/** en.ts sentiment*. '' when there is none. */
export function sentimentLabel(sentiment: string | null | undefined): string {
  const s = (sentiment ?? '').toLowerCase();
  if (!s) return '';
  return SENTIMENT_LABELS[s] ?? s.charAt(0).toUpperCase() + s.slice(1);
}

export type SentimentTone = 'success' | 'neutral' | 'warning' | 'error';

export function sentimentTone(sentiment: string | null | undefined): SentimentTone {
  switch ((sentiment ?? '').toLowerCase()) {
    case 'positive':
      return 'success';
    case 'frustrated':
      return 'warning';
    case 'negative':
    case 'angry':
      return 'error';
    default:
      return 'neutral';
  }
}

// ── Dates in the owner's zone ───────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One formatter per zone. Building an Intl.DateTimeFormat is the expensive part,
 * and a call list formats every row. An unknown IANA zone throws a RangeError
 * rather than falling back; the device zone is better than a blank row.
 */
const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timezone: string): Intl.DateTimeFormat {
  const key = timezone || '';
  let fmt = partsFormatters.get(key);
  if (!fmt) {
    const opts: Intl.DateTimeFormatOptions = {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
    };
    try {
      fmt = new Intl.DateTimeFormat('en', timezone ? { ...opts, timeZone: timezone } : opts);
    } catch {
      fmt = new Intl.DateTimeFormat('en', opts);
    }
    partsFormatters.set(key, fmt);
  }
  return fmt;
}

interface ZonedDate {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
  weekday: string;
}

/** The calendar date `ms` falls on in `timezone` ('' = the device zone). */
function zonedDate(ms: number, timezone: string): ZonedDate {
  const parts = partsFormatter(timezone).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: get('weekday'),
  };
}

function keyOf(d: { year: number; month: number; day: number }): string {
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

/** The day before a calendar date, as a key. UTC arithmetic: no zone, no DST. */
function previousDayKey(d: { year: number; month: number; day: number }): string {
  const prev = new Date(Date.UTC(d.year, d.month - 1, d.day) - DAY_MS);
  return keyOf({ year: prev.getUTCFullYear(), month: prev.getUTCMonth() + 1, day: prev.getUTCDate() });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * 'YYYY-MM-DD' of the day `iso` falls on in the owner's zone - the grouping key
 * for day sections. '' for a missing or unparseable date (an undated booking).
 */
export function dayKey(iso: string, timezone: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return keyOf(zonedDate(ms, timezone));
}

/**
 * A day heading in the owner's zone: 'Today', 'Yesterday', else 'Mon 3 Mar'
 * (with the year when it is not this year). '' when unparseable.
 */
export function dayLabel(iso: string, timezone: string, now: Date = new Date()): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const day = zonedDate(ms, timezone);
  const today = zonedDate(now.getTime(), timezone);
  const key = keyOf(day);
  if (key === keyOf(today)) return 'Today';
  if (key === previousDayKey(today)) return 'Yesterday';
  const label = `${day.weekday} ${day.day} ${MONTHS[day.month - 1] ?? ''}`.trim();
  return day.year === today.year ? label : `${label} ${day.year}`;
}

const timeFormatters = new Map<string, Intl.DateTimeFormat>();

/** A clock time in the owner's zone: '2:05 PM'. '' when unparseable. */
export function timeLabel(iso: string, timezone: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const key = timezone || '';
  let fmt = timeFormatters.get(key);
  if (!fmt) {
    const opts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
    try {
      fmt = new Intl.DateTimeFormat('en', timezone ? { ...opts, timeZone: timezone } : opts);
    } catch {
      fmt = new Intl.DateTimeFormat('en', opts);
    }
    timeFormatters.set(key, fmt);
  }
  return fmt.format(new Date(ms));
}

/**
 * A booking's start time in the OWNER's timezone, not the phone's.
 *
 * A user travelling would otherwise see appointments shifted by their current
 * offset while the business - and the caller - still expect the original local
 * time. `timezone` comes from the same `ownerTimezone()` the dashboard uses; an
 * empty value falls back to the device zone.
 */
export function formatWhen(iso: string, timezone: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const opts: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  };
  if (timezone) opts.timeZone = timezone;
  try {
    return new Intl.DateTimeFormat('en', opts).format(new Date(ms));
  } catch {
    // An unknown IANA zone throws rather than falling back. Better to show the
    // device's time than to blank the row.
    delete opts.timeZone;
    return new Intl.DateTimeFormat('en', opts).format(new Date(ms));
  }
}

export interface MinuteForecast {
  /** Minutes this month if the rest of it looks like the part already used. */
  projected: number;
  /** True when that projection lands over the plan's allowance. */
  willExceed: boolean;
  /**
   * Day of the month the allowance runs out on, when it does. May be in the
   * PAST - that is the already-spent case, and the caller must word it in the
   * right tense rather than promising a future overage that has happened.
   */
  exhaustedOnDay: number | null;
  /** The allowance is gone already, not merely on track to be. */
  alreadyExceeded: boolean;
}

/**
 * Where this month's minutes are heading.
 *
 * Pass the owner's `timezone`: `used` is the server's calendar month in that
 * zone, so "day 30 of 30" must be read there too. On the device's own calendar
 * a phone that is already on the 1st while the account is still on the 30th
 * would extrapolate a whole month's minutes from one day.
 *
 * The single loudest complaint about this category of product is the bill: the
 * allowance is consumed by callers, not by the account holder, so the first
 * signal that a long-winded caller has cost real money is the invoice. A used /
 * included meter cannot warn about that - it only ever reports the past.
 *
 * Straight-line extrapolation on purpose. Weighting recent days, or modelling
 * weekday-vs-weekend, would produce a more confident-looking number off the
 * same handful of data points; this one is easy to explain and hard to
 * misread, which matters more for something that says "you are about to be
 * charged extra".
 *
 * Returns null before day 4: two days of calls extrapolated over a month says
 * more about the two days than about the month.
 */
export function forecastMinutes(
  used: number,
  included: number,
  now: Date = new Date(),
  timezone?: string,
): MinuteForecast | null {
  if (included <= 0) return null; // uncapped tier - nothing to run out of

  let day: number;
  let daysInMonth: number;
  if (timezone) {
    const d = zonedDate(now.getTime(), timezone);
    day = d.day;
    // Day 0 of the next month is the last day of this one.
    daysInMonth = new Date(Date.UTC(d.year, d.month, 0)).getUTCDate();
  } else {
    day = now.getDate();
    daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  }
  if (day < 4) return null;

  const perDay = used / day;
  if (perDay <= 0) return null;

  const projected = Math.round(perDay * daysInMonth);
  const dayHit = Math.ceil(included / perDay);
  return {
    projected,
    willExceed: projected > included,
    exhaustedOnDay: dayHit <= daysInMonth ? dayHit : null,
    alreadyExceeded: used >= included,
  };
}
