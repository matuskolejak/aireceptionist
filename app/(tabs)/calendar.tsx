import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native';

import { SaveBar, Sheet, SwitchRow, TextField } from '@/components/form';
import { Icon } from '@/components/Icon';
import { Screen } from '@/components/Screen';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  ICON,
  Notice,
  pressed,
  SkeletonCard,
  StaleNotice,
  TextLink,
  type BadgeTone,
} from '@/components/ui';
import { colors, fonts, spacing, type } from '@/constants/theme';
import { api, ApiError } from '@/lib/api';
import { callerLabel, dayKey, formatPhone, formatWhen, relTimeOf, timeLabel } from '@/lib/format';
import { dial, openExternal } from '@/lib/links';
import { deviceTimeZone } from '@/lib/locale';
import type { Booking, ExternalEvent } from '@/lib/types';
import { useQuery } from '@/lib/use-query';

/**
 * Appointments: what the receptionist booked, merged with the connected
 * calendar's own events, in the OWNER's time zone (the phone's when the account
 * has none saved - never a silent UTC).
 *
 * Sections, top to bottom - the same split the web calendar makes:
 *   Requests to confirm  callers who asked for an appointment but no time was
 *                        captured. They can only be followed up by hand, so
 *                        they get Call and Open call, never Cancel (the server
 *                        would phone the customer about an appointment that
 *                        does not exist) and never Retry (there is nothing to
 *                        sync without a time).
 *   Needs attention      dated bookings that did not reach the calendar: Retry.
 *   one section per day  upcoming bookings and events, by owner-local day.
 *   Past                 newest first.
 *
 * `?day=YYYY-MM-DD` (Home's upcoming rows) scrolls to that owner-local day.
 */
export default function AppointmentsScreen() {
  const router = useRouter();
  const { day } = useLocalSearchParams<{ day?: string }>();
  const { data, error, loading, refreshing, refresh } = useQuery(
    () => api.calendar(deviceTimeZone()),
    [],
  );
  const [cancelling, setCancelling] = useState<Booking | null>(null);
  const timezone = data?.timezone ?? '';

  const sections = useMemo(
    () => (data ? buildSections(data.bookings, data.events, data.timezone) : []),
    [data],
  );

  // ── Scroll to a day ────────────────────────────────────────────────────────

  const listRef = useRef<SectionList<Item, AgendaSection>>(null);
  const pendingScroll = useRef<{ sectionIndex: number; attempts: number } | null>(null);

  const scrollToSection = useCallback((sectionIndex: number) => {
    // itemIndex 0 is the section's header row in a SectionList.
    listRef.current?.scrollToLocation({
      sectionIndex,
      itemIndex: 0,
      viewOffset: 0,
      animated: true,
    });
  }, []);

  // Not tied to the effect below: clearing `day` re-runs that effect, and its
  // cleanup would cancel the scroll it had just scheduled.
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (scrollTimer.current) clearTimeout(scrollTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!day || !data) return;
    const index = sectionForDay(sections, day, data.timezone);
    if (index >= 0) {
      pendingScroll.current = { sectionIndex: index, attempts: 0 };
      if (scrollTimer.current) clearTimeout(scrollTimer.current);
      // One frame for the list to lay out the rows it has just received.
      scrollTimer.current = setTimeout(() => scrollToSection(index), 60);
    }
    // Consumed either way, so tapping the same Home row again later scrolls
    // again instead of landing on an unchanged param.
    router.setParams({ day: undefined });
  }, [day, data, sections, router, scrollToSection]);

  /**
   * A section outside the rendered window cannot be scrolled to directly (the
   * rows have no fixed height to compute from). Jump to the estimate, let the
   * list render there, and try again - three times at most.
   */
  const onScrollToIndexFailed = useCallback(
    (info: { index: number; averageItemLength: number }) => {
      const pending = pendingScroll.current;
      if (!pending || pending.attempts >= 3) return;
      pending.attempts += 1;
      listRef.current
        ?.getScrollResponder()
        ?.scrollTo({ y: info.averageItemLength * info.index, animated: false });
      setTimeout(() => scrollToSection(pending.sectionIndex), 120);
    },
    [scrollToSection],
  );

  // ── Rows ───────────────────────────────────────────────────────────────────

  const renderItem = useCallback(
    ({ item }: { item: Item }) => {
      switch (item.kind) {
        case 'request':
          return <RequestCard booking={item.booking} />;
        case 'event':
          return (
            <EventCard event={item.event} timezone={timezone} showDate={item.showDate} past={item.past} />
          );
        default:
          return (
            <BookingCard
              booking={item.booking}
              timezone={timezone}
              showDate={item.showDate}
              past={item.past}
              onRefresh={refresh}
              onCancel={() => setCancelling(item.booking)}
            />
          );
      }
    },
    [timezone, refresh],
  );

  const renderSectionHeader = useCallback(
    ({ section }: { section: AgendaSection }) => <SectionHeader section={section} />,
    [],
  );

  const subtitle = data
    ? `Times in ${zoneName(data.timezone)}${data.timezoneIsAccount ? '' : ' (this phone)'}`
    : undefined;

  // A word, not a link glyph: "Calendars" says where it goes.
  const headerButton = (
    <TextLink
      label="Calendars"
      accessibilityLabel="Connected calendars"
      onPress={() => router.push('/calendar/connections')}
    />
  );

  if (loading) {
    return (
      <Screen title="Appointments" right={headerButton}>
        <View style={styles.skeletons}>
          <SkeletonCard lines={2} />
          <SkeletonCard lines={3} />
          <SkeletonCard lines={2} />
        </View>
      </Screen>
    );
  }

  // Only a screen with nothing to show is a dead end. `error` is set by the
  // focus refetch and the pull to refresh too, so failing on it would throw
  // away a perfectly good agenda over one lost packet.
  if (!data) {
    return (
      <Screen title="Appointments" right={headerButton}>
        <ErrorState message={error ?? 'Could not load your appointments.'} onRetry={refresh} />
      </Screen>
    );
  }

  return (
    <>
      <Screen title="Appointments" subtitle={subtitle} scroll={false} right={headerButton}>
        <SectionList<Item, AgendaSection>
          ref={listRef}
          sections={sections}
          keyExtractor={keyOfItem}
          renderItem={renderItem}
          renderSectionHeader={renderSectionHeader}
          stickySectionHeadersEnabled={false}
          onScrollToIndexFailed={onScrollToIndexFailed}
          contentContainerStyle={sections.length === 0 ? styles.emptyWrap : styles.list}
          ListHeaderComponent={error ? <StaleNotice message={error} onRetry={refresh} /> : null}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={refresh}
              tintColor={colors.textSecondary}
              colors={[colors.ink]}
            />
          }
          ListEmptyComponent={
            <EmptyState
              mood="greeting"
              title="No appointments yet"
              body="Connect a calendar and your receptionist can book real appointments. Until then it takes messages."
            >
              <Button
                label="Connect a calendar"
                variant="secondary"
                size="pill"
                icon="calendar-outline"
                onPress={() => router.push('/calendar/connections')}
                style={styles.emptyAction}
              />
            </EmptyState>
          }
        />
      </Screen>

      <CancelSheet
        booking={cancelling}
        onClose={() => setCancelling(null)}
        onCancelled={refresh}
      />
    </>
  );
}

// ── The agenda model ─────────────────────────────────────────────────────────

type Item =
  | { kind: 'request'; booking: Booking }
  | { kind: 'booking'; booking: Booking; past: boolean; showDate: boolean }
  | { kind: 'event'; event: ExternalEvent; past: boolean; showDate: boolean };

interface AgendaSection {
  key: string;
  title: string;
  subtitle?: string;
  /** Shown as a pill after the title (the requests count). */
  count?: { value: number; tone: BadgeTone };
  /** Owner-local 'YYYY-MM-DD' for a day section. */
  day?: string;
  data: Item[];
}

// External event ids are namespaced with their integration id and booking ids
// are UUIDs, so the two cannot collide.
const keyOfItem = (i: Item) => (i.kind === 'event' ? `e:${i.event.id}` : `b:${i.booking.id}`);

const isUndated = (b: Booking) => !Number.isFinite(Date.parse(b.startTime));

/** A booking is over once it has ENDED - an owner cancelling a no-show at 10:05 still needs it. */
function bookingEnded(b: Booking, now: number): boolean {
  const end = Date.parse(b.endTime);
  return (Number.isFinite(end) ? end : Date.parse(b.startTime)) <= now;
}

/** The next calendar day after a 'YYYY-MM-DD' key. UTC arithmetic: no zone, no DST. */
function nextDayKey(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

function dayTitle(key: string, today: string): string {
  if (key === today) return 'Today';
  if (key === nextDayKey(today)) return 'Tomorrow';
  const [y, m, d] = key.split('-').map(Number);
  if (!y || !m || !d) return key;
  return new Intl.DateTimeFormat('en', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(key.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

function buildSections(bookings: Booking[], events: ExternalEvent[], tz: string): AgendaSection[] {
  const now = Date.now();
  const today = dayKey(new Date(now).toISOString(), tz);

  // We read back the very calendar the receptionist books into, so a synced
  // booking arrives twice: once as a Booking and once as the provider's echo
  // of it. Matching on the stored provider event id keeps one card per
  // appointment - the Booking one, which is the only one with actions.
  const booked = new Set(bookings.map((b) => b.externalId).filter((v): v is string => Boolean(v)));
  const ownEvents = events.filter((e) => !booked.has(e.id.slice(e.integrationId.length + 1)));

  const requests = bookings
    .filter(isUndated)
    .sort((a, b) => (Date.parse(b.bookedAt) || 0) - (Date.parse(a.bookedAt) || 0));
  const dated = bookings.filter((b) => !isUndated(b));
  const attention = dated
    .filter((b) => b.status === 'failed' && !b.cancellation && !bookingEnded(b, now))
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  const inAttention = new Set(attention.map((b) => b.id));

  type Agenda =
    | { kind: 'booking'; at: number; booking: Booking }
    | { kind: 'event'; at: number; event: ExternalEvent };
  const agenda: Agenda[] = [
    ...dated
      .filter((b) => !inAttention.has(b.id))
      .map((b) => ({ kind: 'booking' as const, at: Date.parse(b.startTime), booking: b })),
    ...ownEvents
      .filter((e) => Number.isFinite(Date.parse(e.start)))
      .map((e) => ({ kind: 'event' as const, at: Date.parse(e.start), event: e })),
  ];

  /**
   * All-day events are date-anchored and the providers hand them back at UTC
   * midnight, so converting that instant into a zone moves them a day (a New
   * York owner would see today's holiday as yesterday's). Their day is the
   * date prefix; everything else is the owner-local day of the start.
   */
  const keyOf = (i: Agenda) =>
    i.kind === 'event' && i.event.allDay ? i.event.start.slice(0, 10) : dayKey(new Date(i.at).toISOString(), tz);
  const isAllDay = (i: Agenda) => i.kind === 'event' && i.event.allDay;
  const isPast = (i: Agenda) => {
    if (i.kind === 'booking') return bookingEnded(i.booking, now);
    if (i.event.allDay) return i.event.start.slice(0, 10) < today;
    const end = Date.parse(i.event.end);
    return (Number.isFinite(end) ? end : i.at) <= now;
  };
  const cmp = (a: Agenda, b: Agenda) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka !== kb) return ka < kb ? -1 : 1;
    if (isAllDay(a) !== isAllDay(b)) return isAllDay(a) ? -1 : 1;
    return a.at - b.at;
  };
  const toItem = (i: Agenda, past: boolean, showDate: boolean): Item =>
    i.kind === 'booking'
      ? { kind: 'booking', booking: i.booking, past, showDate }
      : { kind: 'event', event: i.event, past, showDate };

  const sections: AgendaSection[] = [];

  if (requests.length > 0) {
    sections.push({
      key: 'requests',
      title: 'Requests to confirm',
      subtitle: 'The caller asked for an appointment but no time was captured. Follow these up by hand.',
      count: { value: requests.length, tone: 'warning' },
      data: requests.map((booking) => ({ kind: 'request', booking })),
    });
  }

  if (attention.length > 0) {
    sections.push({
      key: 'attention',
      title: 'Needs attention',
      subtitle: 'These did not reach your calendar.',
      count: { value: attention.length, tone: 'error' },
      data: attention.map((booking) => ({ kind: 'booking', booking, past: false, showDate: true })),
    });
  }

  const upcoming = agenda.filter((i) => !isPast(i)).sort(cmp);
  let current: AgendaSection | null = null;
  for (const i of upcoming) {
    const key = keyOf(i);
    if (!current || current.day !== key) {
      current = { key: `day:${key}`, title: dayTitle(key, today), day: key, data: [] };
      sections.push(current);
    }
    current.data.push(toItem(i, false, false));
  }

  const past = agenda.filter(isPast).sort((a, b) => cmp(b, a));
  if (past.length > 0) {
    sections.push({ key: 'past', title: 'Past', data: past.map((i) => toItem(i, true, true)) });
  }

  return sections;
}

/**
 * Which section `?day=` means. Home links from a booking row, never from a
 * calendar event, so: that day's section when it holds one of our bookings;
 * else the attention section when the day's booking is a failed one waiting
 * there (the day itself may still have a section, for someone else's event);
 * else that day's section; else the next day that has anything on it.
 */
function sectionForDay(sections: AgendaSection[], day: string, tz: string): number {
  const exact = sections.findIndex((s) => s.day === day);
  if (exact >= 0 && sections[exact].data.some((i) => i.kind === 'booking')) return exact;
  const attention = sections.findIndex(
    (s) =>
      s.key === 'attention' &&
      s.data.some((i) => i.kind === 'booking' && dayKey(i.booking.startTime, tz) === day),
  );
  if (attention >= 0) return attention;
  if (exact >= 0) return exact;
  return sections.findIndex((s) => s.day !== undefined && s.day > day);
}

/** 'America/New_York' -> 'America/New York'. */
function zoneName(tz: string): string {
  return (tz || 'UTC').replace(/_/g, ' ');
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function SectionHeader({ section }: { section: AgendaSection }) {
  const label = section.count ? `${section.title}, ${section.count.value}` : section.title;
  return (
    <View style={styles.sectionHead}>
      <View style={styles.sectionTitleRow} accessible accessibilityRole="header" accessibilityLabel={label}>
        <Text style={styles.sectionTitle}>{section.title}</Text>
        {section.count ? <Badge label={String(section.count.value)} tone={section.count.tone} /> : null}
      </View>
      {section.subtitle ? <Text style={styles.sectionSubtitle}>{section.subtitle}</Text> : null}
    </View>
  );
}

/** Start and end on the day the section already names: '9:30 AM - 10:00 AM'. */
function timeRange(start: string, end: string, tz: string): string {
  const from = timeLabel(start, tz);
  const to = timeLabel(end, tz);
  return to && to !== from ? `${from} - ${to}` : from;
}

/**
 * All-day events are date-anchored, so the label has to come from the date
 * prefix. Formatting the instant would show the neighbouring day for anyone
 * west of UTC.
 */
function formatAllDay(iso: string, withDate: boolean): string {
  if (!withDate) return 'All day';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return 'All day';
  const when = new Intl.DateTimeFormat('en', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
  return `All day, ${when}`;
}

/** A caller who asked for an appointment without a usable time. */
function RequestCard({ booking }: { booking: Booking }) {
  const router = useRouter();
  const phone = booking.attendeePhone || booking.callerNumber;
  const name = booking.attendeeName || callerLabel(phone);
  const booked = relTimeOf(booking.bookedAt);
  const meta = [booking.attendeeName && phone ? formatPhone(phone) : null, booked ? `Booked ${booked}` : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <Card style={styles.card}>
      <Text style={styles.cardTitle}>{name}</Text>
      {meta ? <Text style={styles.meta}>{meta}</Text> : null}
      {Boolean(booking.notes) && (
        <Text style={styles.notes} numberOfLines={3}>
          {booking.notes}
        </Text>
      )}
      <View style={styles.actions}>
        {Boolean(phone) && (
          <Button
            label="Call"
            icon="call-outline"
            size="pill"
            variant="secondary"
            onPress={() => void dial(phone)}
            accessibilityHint={`Rings ${formatPhone(phone)}`}
          />
        )}
        {Boolean(booking.callId) && (
          <Button
            label="Open call"
            icon="document-text-outline"
            size="pill"
            variant="secondary"
            onPress={() => router.push(`/call/${booking.callId}`)}
          />
        )}
      </View>
    </Card>
  );
}

/**
 * Somebody else's entry on your calendar.
 *
 * Deliberately without actions: this is not ours to cancel or re-sync, and
 * offering either would fail against the provider. Tapping opens it where it
 * lives.
 */
function EventCard({
  event,
  timezone,
  showDate,
  past,
}: {
  event: ExternalEvent;
  timezone: string;
  showDate: boolean;
  past: boolean;
}) {
  const title = event.title || 'Busy';
  const when = event.allDay
    ? formatAllDay(event.start, showDate)
    : showDate
      ? formatWhen(event.start, timezone)
      : timeRange(event.start, event.end, timezone);

  const body = (
    <Card style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.cardTitle} numberOfLines={1}>
          {title}
        </Text>
        <Badge label={event.providerLabel} tone="neutral" />
      </View>
      <View style={styles.whenRow}>
        <Text style={[styles.when, past && styles.whenPast]}>{when}</Text>
        {event.url ? <Icon name="open-outline" size={ICON.chevron} color={colors.textSecondary} /> : null}
      </View>
      {Boolean(event.location) && (
        <Text style={styles.meta} numberOfLines={1}>
          {event.location}
        </Text>
      )}
    </Card>
  );

  if (!event.url) {
    return (
      <View accessible accessibilityLabel={`${title}, ${when}, ${event.providerLabel}`}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      onPress={() => void openExternal(event.url)}
      accessibilityRole="link"
      accessibilityLabel={`${title}, ${when}, ${event.providerLabel}`}
      accessibilityHint={`Opens it in ${event.providerLabel}`}
      style={({ pressed: down }) => down && pressed}
    >
      {body}
    </Pressable>
  );
}

const STATUS_BADGE: Partial<Record<Booking['status'], { label: string; tone: BadgeTone }>> = {
  pending: { label: 'Pending', tone: 'neutral' },
  failed: { label: "Didn't sync", tone: 'error' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

function BookingCard({
  booking,
  timezone,
  showDate,
  past,
  onRefresh,
  onCancel,
}: {
  booking: Booking;
  timezone: string;
  showDate: boolean;
  past: boolean;
  onRefresh: () => Promise<void>;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const phone = booking.attendeePhone || booking.callerNumber;
  const cancelled = booking.status === 'cancelled' || Boolean(booking.cancellation);
  // "Done" on every row is noise that trains people to stop reading the badges.
  const badge = booking.cancellation ? STATUS_BADGE.cancelled : STATUS_BADGE[booking.status];
  const title = booking.title || booking.attendeeName || 'Appointment';
  const when = showDate
    ? formatWhen(booking.startTime, timezone)
    : timeRange(booking.startTime, booking.endTime, timezone);
  const detail = [
    booking.attendeeName && !title.includes(booking.attendeeName) ? booking.attendeeName : null,
    booking.assistant ? `Booked by ${booking.assistant}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  // The web offers Cancel only here: a confirmed, dated appointment nobody has
  // cancelled yet. Cancelling phones the customer, so a failed or pending sync
  // (which the customer may not even know about) never gets it.
  const canCancel = booking.status === 'done' && !booking.cancellation && !past;
  // Ended bookings sit under Past, where retrying would push an appointment
  // that is already over; only Needs attention offers it.
  const canRetry = booking.status === 'failed' && !booking.cancellation && !past;

  async function retry() {
    setBusy(true);
    setRetryError(null);
    try {
      await api.retryBooking(booking.id);
      await onRefresh();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      setRetryError((err as Error).message || "Still couldn't reach your calendar. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={[styles.cardTitle, cancelled && styles.struck]} numberOfLines={2}>
          {title}
        </Text>
        {badge ? <Badge label={badge.label} tone={badge.tone} /> : null}
      </View>
      <Text style={[styles.when, past && styles.whenPast]}>{when}</Text>
      {detail ? (
        <Text style={styles.meta} numberOfLines={1}>
          {detail}
        </Text>
      ) : null}
      {Boolean(booking.notes) && (
        <Text style={styles.notes} numberOfLines={3}>
          {booking.notes}
        </Text>
      )}

      {/* The provider's raw error is diagnostics, not something to act on. */}
      {canRetry ? (
        <Notice tone="error" icon={null} style={styles.syncFailed}>
          {retryError ?? "Didn't reach your calendar."}
        </Notice>
      ) : null}

      {booking.cancellation ? (
        <Text style={styles.cancelNote}>
          Cancelled{booking.cancellation.reason ? `: ${booking.cancellation.reason}` : ''} -{' '}
          {notifyLabel(booking.cancellation.notifyStatus)}
        </Text>
      ) : null}

      {(Boolean(phone) || Boolean(booking.callId) || canRetry || canCancel) && (
        <View style={styles.actions}>
          {canRetry && (
            <Button
              label="Retry sync"
              icon="refresh-outline"
              size="pill"
              variant="secondary"
              busy={busy}
              onPress={() => void retry()}
            />
          )}
          {Boolean(phone) && (
            <Button
              label="Call"
              icon="call-outline"
              size="pill"
              variant="secondary"
              onPress={() => void dial(phone)}
              accessibilityHint={`Rings ${formatPhone(phone)}`}
            />
          )}
          {Boolean(booking.callId) && (
            <Button
              label="Open call"
              icon="document-text-outline"
              size="pill"
              variant="secondary"
              onPress={() => router.push(`/call/${booking.callId}`)}
            />
          )}
          {canCancel && (
            // Never a bare "Cancel": on a phone that word means "never mind".
            <Button
              label="Cancel appointment"
              icon="close-circle-outline"
              size="pill"
              variant="danger"
              onPress={onCancel}
              accessibilityHint="Your receptionist lets the customer know"
            />
          )}
        </View>
      )}
    </Card>
  );
}

/**
 * Cancelling is not just removing a row: the receptionist rings the customer to
 * tell them (or texts, if it cannot call). The sheet says so out loud, because
 * an owner who does not expect that call will be surprised by it.
 */
function CancelSheet({
  booking,
  onClose,
  onCancelled,
}: {
  booking: Booking | null;
  onClose: () => void;
  onCancelled: () => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [rebook, setRebook] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [state, setState] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (!booking) return;
    setReason('');
    setRebook(true);
    setState(null);
    setDone(false);
  }, [booking]);

  async function submit() {
    if (!booking) return;
    setBusy(true);
    setState(null);
    try {
      const res = await api.cancelBooking(booking.id, reason.trim(), rebook);
      // The cancellation has happened by now, warning or not. Latch before the
      // refresh await: a second tap would place a second cancellation call to
      // the customer, since the route is not idempotent.
      setDone(true);
      await onCancelled();
      if (res.warning) {
        // Green, not red. The appointment IS cancelled; the caveat is only that
        // the calendar entry has to be removed by hand.
        setState({ ok: true, message: res.warning });
      } else {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        onClose();
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Already cancelled, or a request with no time: the server says which.
        // Nothing a second tap could change, so latch and show the new state.
        setDone(true);
        setState({ ok: false, message: err.message });
        void onCancelled();
      } else {
        // Left un-latched on purpose, so a genuine network failure stays retryable.
        setState({ ok: false, message: (err as Error).message });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      visible={Boolean(booking)}
      title="Cancel this appointment?"
      onClose={onClose}
      footer={
        // The web's pair: the destructive verb spelled out, and a quiet way
        // out that is not another "Cancel".
        <SaveBar
          onSave={submit}
          busy={busy}
          dirty={!done}
          state={state}
          label="Cancel appointment"
          secondary={done ? undefined : { label: 'Keep it', onPress: onClose }}
        />
      }
    >
      <Text style={styles.sheetLead}>
        Your receptionist rings {booking?.attendeeName || 'the customer'} to let them know, and
        texts them if it cannot get through.
      </Text>
      <View style={{ height: spacing.lg }} />
      <TextField
        label="Why (they will hear this)"
        value={reason}
        onChangeText={setReason}
        placeholder="Something came up and we have to move it."
        multiline
        maxLength={500}
      />
      <SwitchRow
        title="Offer to rebook"
        body="It asks whether they would like another time."
        value={rebook}
        onValueChange={setRebook}
      />
    </Sheet>
  );
}

function notifyLabel(status: string): string {
  switch (status) {
    case 'calling':
      return 'calling them now';
    case 'answered':
      return 'they were told';
    case 'sms_sent':
      return 'texted them';
    case 'failed':
      return 'could not reach them';
    default:
      return 'letting them know';
  }
}

const styles = StyleSheet.create({
  // The rows carry their own horizontal inset rather than the list, so a
  // StaleNotice in the list header lines up with the cards instead of being
  // indented twice.
  list: {
    paddingBottom: spacing.xxl,
  },
  emptyWrap: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  emptyAction: { marginTop: spacing.lg },
  skeletons: { paddingHorizontal: spacing.lg, gap: spacing.md },
  sectionHead: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
  },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  // Off-card list headings are eyebrows, as on the Calls tab.
  sectionTitle: { ...type.eyebrow, flexShrink: 1 },
  sectionSubtitle: { ...type.caption, marginTop: 2 },
  card: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
  },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  cardTitle: {
    ...type.body,
    fontFamily: fonts.semibold,
    flexShrink: 1,
  },
  struck: {
    textDecorationLine: 'line-through',
    color: colors.textSecondary,
  },
  whenRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  when: {
    ...type.bodySm,
    fontFamily: fonts.medium,
    marginTop: spacing.xs,
    fontVariant: ['tabular-nums'],
  },
  whenPast: { color: colors.textSecondary },
  meta: {
    ...type.caption,
    marginTop: spacing.xs,
  },
  notes: {
    ...type.bodySm,
    marginTop: spacing.sm,
    paddingLeft: spacing.sm,
    borderLeftWidth: 2,
    borderLeftColor: colors.border,
    color: colors.textSecondary,
  },
  syncFailed: { marginTop: spacing.sm },
  cancelNote: {
    ...type.caption,
    marginTop: spacing.sm,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  sheetLead: { ...type.bodySm, color: colors.textSecondary },
});
