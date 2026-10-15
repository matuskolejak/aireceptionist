import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { AvatarRing, type AvatarStatus } from '@/components/avatar';
import { BarChart } from '@/components/BarChart';
import { DonutChart } from '@/components/DonutChart';
import { Icon } from '@/components/Icon';
import { Screen } from '@/components/Screen';
import {
  Badge,
  Button,
  CallRow,
  Card,
  cardStyle,
  Dot,
  EmptyState,
  ErrorState,
  ICON,
  IconButton,
  LiveDot,
  Notice,
  pressed,
  ripple,
  SectionCard,
  Segmented,
  Skeleton,
  SkeletonRows,
  StaleNotice,
  StatTile,
  TextLink,
  type BadgeTone,
  type SegmentOption,
} from '@/components/ui';
import { colors, fonts, radius, shape, spacing, type } from '@/constants/theme';
import { api } from '@/lib/api';
import {
  callerLabel,
  callHeadline,
  dayKey,
  forecastMinutes,
  formatPhone,
  formatWhen,
  relTime,
  statusBucket,
  type MinuteForecast,
} from '@/lib/format';
import { markPrimerAnswered, primerAnswered, requestAndRegister, type PushState } from '@/lib/push';
import type { Booking, Overview } from '@/lib/types';
import { useLiveCall } from '@/lib/use-live-call';
import { useQuery } from '@/lib/use-query';

type Range = 'today' | 'month';

const RANGE_OPTIONS: SegmentOption<Range>[] = [
  { value: 'today', label: 'Today' },
  { value: 'month', label: 'This month' },
];

/**
 * When Activity was last opened. Written by app/notifications.tsx each time it
 * comes forward (same key there); the bell's unread dot reads it here.
 */
const LAST_SEEN_KEY = 'activity.lastSeenAt';

/** The line under the receptionist's name - the web sidebar's status words. */
const STATUS_LINE: Record<AvatarStatus, string> = {
  live: 'On a call now',
  offline: 'No phone number yet',
  answering: 'Answering calls',
  paused: 'Paused',
};

export default function HomeScreen() {
  const router = useRouter();
  // Mirrors `/dashboard?range=month`. The month rollup is a separate, heavier
  // query, so - like the web page - it is only requested once you ask for it.
  const [range, setRange] = useState<Range>('today');
  // `range` and `data` are independent state, so for the frame after a segment
  // is tapped the payload on screen is still the previous range's. Tagging every
  // payload with the range it was fetched for is what lets the month checks
  // below wait for the matching response instead of misreading a today payload
  // - which carries `analytics: null` too - as a failed month rollup.
  const { data, error, loading, refreshing, refresh } = useQuery<Overview & { range: Range }>(
    async () => ({ ...(await api.overview(range)), range }),
    [range],
  );
  const liveCallId = useLiveCall();
  const activitySeenAt = useActivitySeenAt();
  const primer = usePushPrimer();

  const openActivity = useCallback(() => router.push('/notifications'), [router]);

  // `tel:` has no handler on an iPad without a dialer and the app ships with
  // `supportsTablet`, so `openURL` genuinely rejects on a supported target.
  // Dropping that promise leaves a button that does nothing and an unhandled
  // rejection behind it.
  const dial = useCallback((e164: string) => {
    Linking.openURL(`tel:${e164}`).catch(() =>
      Alert.alert(
        'Cannot place calls',
        `Dial ${formatPhone(e164)} from a phone to try your receptionist.`,
      ),
    );
  }, []);

  // Optimistic so the button does not lag a network round trip - the same
  // pattern the web hero toggle uses. The override is tied to the payload it was
  // made against: the next payload (a focus refetch, a pull, a range switch)
  // carries the server's own answer, so the override simply stops applying
  // instead of needing a pull-to-refresh spinner nobody asked for to clear it.
  const [power, setPower] = useState<{ enabled: boolean; base: Overview } | null>(null);
  const [powerBusy, setPowerBusy] = useState(false);

  const applyPower = useCallback(async (id: string, next: boolean, base: Overview) => {
    setPower({ enabled: next, base });
    setPowerBusy(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      await api.setAssistantPower(id, next);
    } catch (err) {
      // Roll back rather than leave the band showing a state the phone line is
      // not actually in, and say why - a haptic alone reads as "done".
      setPower(null);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert(next ? 'Could not resume' : 'Could not pause', (err as Error).message);
    } finally {
      setPowerBusy(false);
    }
  }, []);

  // Pausing stops the line answering, and on a phone it sits one thumb away
  // from "Call to try it" - so it asks first. Resuming is harmless and stays
  // one tap.
  const togglePower = useCallback(() => {
    if (!data?.assistant) return;
    const current = power && power.base === data ? power.enabled : data.assistant.enabled;
    const { id } = data.assistant;
    if (!current) {
      void applyPower(id, true, data);
      return;
    }
    Alert.alert('Pause your receptionist?', 'Calls will not be answered until you resume.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Pause', style: 'destructive', onPress: () => void applyPower(id, false, data) },
    ]);
  }, [data, power, applyPower]);

  // Only the very first load blanks the screen, and even then into the shape
  // of what is coming rather than a spinner. A range switch re-runs the query
  // with `loading` true while the previous payload is still in state; that
  // case is handled below, on the tiles alone.
  if (loading && !data) {
    return (
      <Screen title="Home" header={<BrandHeaderSkeleton onBell={openActivity} />}>
        <HomeSkeleton />
      </Screen>
    );
  }

  // `error` is set by any failed fetch, including the focus and foreground
  // revalidations and a failed range switch, while the last good payload stays
  // in state. Only a screen with nothing to show becomes an error card; the
  // rest report the failure as a stale notice above the content.
  if (!data) {
    return (
      <Screen title="Home" right={<BellButton unread={false} onPress={openActivity} />}>
        <ErrorState message={error ?? 'Could not load your overview.'} onRetry={refresh} />
      </Screen>
    );
  }

  // A load with a payload already on screen: a range switch. Only the block
  // that actually depends on the range needs to say it is busy.
  const switching = loading;
  // The segment leads with the range being fetched while a switch is in flight;
  // once it settles it follows the payload actually rendered, so a failed
  // switch does not label the previous range's numbers as something they are not.
  const shownRange = switching ? range : data.range;

  // The route wraps the month rollup in a catch that still answers 200 with
  // `analytics: null`, so on a month payload a null rollup means the query
  // failed, not that it was never asked for. Rendering the zeros it would
  // otherwise produce tells a busy account it took no calls all month.
  const monthFailed = data.range === 'month' && data.analytics === null;
  // A switch still in flight is not a failure: until the response lands
  // `monthFailed` is read off the outgoing payload, and both blocks below have
  // to agree about that or the lower one vanishes while the tiles are still
  // showing their placeholder.
  const showMonthError = !switching && monthFailed;

  // `online` is "any assistant is enabled"; `data.assistant` is only ever the
  // first one, so on a multi-assistant account its flag can read paused while
  // another receptionist is answering. The band, the header, Needs attention
  // and the web dashboard have to give the same answer, and `online` is it.
  // The optimistic override only exists for a single receptionist (the only
  // case with a Pause button), where the two agree.
  const enabled = power && power.base === data ? power.enabled : data.online;
  // Same extended rule as the dashboard: no receptionist or no number means
  // nobody is answering, whatever the enabled flag says.
  const offline = !data.assistant || !data.number;
  const avatarStatus: AvatarStatus = liveCallId
    ? 'live'
    : offline
      ? 'offline'
      : enabled
        ? 'answering'
        : 'paused';
  const bandText = offline
    ? 'No phone number yet'
    : enabled
      ? `Answering calls at ${formatPhone(data.number)}`
      : 'Paused';
  const receptionistName =
    data.assistantCount > 1 ? 'Your receptionists' : data.assistant?.name || 'Your receptionist';

  // `plan.name` is already a full label - it is "Solo" on a paid tier but
  // "No plan" on an unsubscribed account, so appending "plan" unconditionally
  // renders "No plan plan".
  const planLabel = data.plan
    ? data.plan.active
      ? `${data.plan.name} plan`
      : data.plan.name
    : '';

  // An account with no subscription still comes back with a plan object
  // carrying an allowance, so the number only means anything once the plan is
  // active. Reading it unconditionally shows a lapsed account minutes it cannot
  // spend, and Settings already answers this question the same way.
  const minutesIncluded = data.plan?.active ? data.plan.minutesIncluded : 0;
  const minutesCapped = minutesIncluded > 0;
  const minutePct = minutesCapped
    ? Math.min(100, Math.round((data.monthUsage.minutes / minutesIncluded) * 100))
    : 0;
  // The owner's zone, not the phone's: `monthUsage` is the owner's calendar month.
  const forecast = forecastMinutes(
    data.monthUsage.minutes,
    minutesIncluded,
    new Date(),
    data.timezone,
  );

  // The bell's dot: a call newer than the last time Activity was opened.
  // `startedAt` is the ISO start; `at` is a display label and never parsed.
  const newestCall = data.recentCalls[0] ? Date.parse(data.recentCalls[0].startedAt) : NaN;
  const unread =
    activitySeenAt !== null && Number.isFinite(newestCall) && newestCall > activitySeenAt;

  // The web shows three; the server sends up to five.
  const upcoming = data.upcoming.slice(0, 3);

  return (
    <Screen
      title="Home"
      header={
        <BrandHeader
          name={receptionistName}
          status={avatarStatus}
          unread={unread}
          onBell={openActivity}
        />
      }
      onRefresh={refresh}
      refreshing={refreshing}
    >
      {error ? <StaleNotice message={error} onRetry={refresh} /> : null}
      <View style={styles.body}>
        {/* On a call right now. The one thing the web dashboard cannot tell you
            from a pocket, so it sits above everything else on the screen. */}
        {liveCallId && (
          <Pressable
            onPress={() => router.push(`/call/${liveCallId}`)}
            accessibilityRole="button"
            accessibilityLabel="On a call now"
            accessibilityHint="Opens the live call"
            android_ripple={ripple}
            style={({ pressed: down }) => [styles.live, down && pressed]}
          >
            <LiveDot />
            <View style={styles.flex}>
              <Text style={styles.liveTitle}>On a call now</Text>
              <Text style={styles.liveBody}>Tap to follow the conversation as it happens.</Text>
            </View>
            <Icon name="chevron-forward" size={ICON.chevron} color={colors.white} />
          </Pressable>
        )}

        {primer.show && <PushPrimer busy={primer.busy} onAccept={primer.accept} onDismiss={primer.dismiss} />}

        {/* Status band */}
        <Card>
          <View style={styles.statusRow}>
            <Dot color={offline ? colors.error : enabled ? colors.success : colors.warning} size={10} />
            <Text style={styles.statusText} numberOfLines={2}>
              {bandText}
            </Text>
          </View>
          <View style={styles.statusActions}>
            {/* Pausing "the receptionist" is only unambiguous with exactly one. */}
            {data.assistant && data.assistantCount === 1 && (
              <Button
                label={enabled ? 'Pause' : 'Resume'}
                icon={enabled ? 'pause' : 'play'}
                size="pill"
                variant={enabled ? 'secondary' : 'primary'}
                onPress={togglePower}
                busy={powerBusy}
                accessibilityHint={
                  enabled
                    ? `Stops ${data.assistant.name} answering calls`
                    : `${data.assistant.name} starts answering calls again`
                }
                style={styles.flexBtn}
              />
            )}
            {Boolean(data.number) && (
              <Button
                label="Call to try it"
                icon="call-outline"
                size="pill"
                variant="secondary"
                onPress={() => dial(data.number)}
                style={styles.flexBtn}
              />
            )}
          </View>
        </Card>

        {/* Latency: the one quality problem that never announces itself. */}
        {data.latency.degraded && (
          <Notice tone="warning" icon="timer-outline" title="Your receptionist is answering slowly.">
            {`The slowest replies are taking ${(data.latency.p95Ms / 1000).toFixed(1)}s, against a ${(
              data.latency.targetMs / 1000
            ).toFixed(1)}s target. Callers notice this as talking over each other.`}
          </Notice>
        )}

        {/* Range switch, in the same place the web puts it: under the status
            band, above the numbers it switches. */}
        <Segmented<Range>
          options={RANGE_OPTIONS}
          value={shownRange}
          onChange={(r) => {
            if (r === shownRange) return;
            void Haptics.selectionAsync();
            // After a failed switch `range` is already this segment, so setting
            // it again would not re-run the query. The tap has to become the
            // retry instead.
            if (r === range) void refresh();
            else setRange(r);
          }}
        />

        {switching ? (
          <TilesSkeleton />
        ) : showMonthError ? (
          <SectionCard title="This month">
            <ErrorState message="Could not load this month's numbers." onRetry={refresh} />
          </SectionCard>
        ) : data.range === 'month' ? (
          <>
            <View style={styles.tiles}>
              <StatTile label="Total calls" value={data.analytics?.totals.calls ?? 0} />
              <StatTile label="Avg call time" value={data.analytics?.totals.avgDuration ?? '-'} />
            </View>
            <View style={styles.tiles}>
              <StatTile label="Answer rate" value={data.analytics?.totals.answerRate ?? '-'} />
              <StatTile label="Bookings" value={data.analytics?.totals.bookings ?? 0} />
            </View>
          </>
        ) : (
          <>
            <View style={styles.tiles}>
              <StatTile label="Calls" value={data.today.calls} />
              <StatTile label="Answered" value={data.today.answered} />
            </View>
            <View style={styles.tiles}>
              {/* The only tile that goes anywhere: missed calls are the one
                  number you would want to act on straight away. */}
              <StatTile
                label="Missed"
                value={data.today.missed}
                alert
                onPress={() => router.push('/calls?status=unanswered')}
              />
              <StatTile label="Booked" value={data.today.booked} />
            </View>
          </>
        )}

        {/* Needs attention */}
        <Issues
          assistantId={data.assistant?.id ?? null}
          assistantCount={data.assistantCount}
          online={enabled}
          number={data.number}
          calendarConnected={data.calendarConnected}
          minutesUsed={data.monthUsage.minutes}
          minutesIncluded={minutesIncluded}
        />

        {/* Today's one feed / the month's two charts - the same split the web
            makes between its today panel and its month panel. */}
        {showMonthError ? null : data.range === 'month' ? (
          <>
            <SectionCard title="Call volume" subtitle="Calls answered per day, last 30 days">
              <View style={styles.chartWrap}>
                <BarChart data={data.analytics?.volume ?? []} />
              </View>
            </SectionCard>
            <SectionCard title="How callers felt">
              {data.analytics && data.analytics.sentiment.length > 0 ? (
                <DonutChart
                  segments={data.analytics.sentiment}
                  centerLabel={`${
                    data.analytics.sentiment.find((x) => x.key === 'positive')?.value ?? 0
                  }%`}
                  centerSub="Positive"
                />
              ) : (
                <Text style={styles.muted}>No calls in this period yet.</Text>
              )}
            </SectionCard>
          </>
        ) : data.recentCalls.length === 0 ? (
          <Card>
            <EmptyState
              mood="greeting"
              title="No calls yet"
              body="Once your AI receptionist answers its first call, the numbers and each call's AI summary show up here."
            >
              {Boolean(data.number) && (
                <>
                  <Text style={styles.emptyNumber}>{formatPhone(data.number)}</Text>
                  <Button
                    label="Call to try it"
                    icon="call-outline"
                    size="pill"
                    onPress={() => dial(data.number)}
                    style={styles.emptyCta}
                  />
                </>
              )}
            </EmptyState>
          </Card>
        ) : (
          <SectionCard
            title="Recent calls"
            action={
              <TextLink
                label="View all"
                role="link"
                compact
                accessibilityLabel="View all calls"
                onPress={() => router.push('/calls')}
              />
            }
          >
            {data.recentCalls.slice(0, 6).map((c, i) => (
              // `startedAt` (ISO) drives the stale-live rule: a row still
              // 'in-progress' four hours on lost its end webhook and is missed.
              <CallRow
                key={c.id}
                headline={callHeadline({ outcome: c.outcome, status: c.status, date: c.startedAt })}
                caller={`${c.flag ? `${c.flag} ` : ''}${callerLabel(c.number)}`}
                meta={c.duration}
                when={relTime(c.agoMinutes)}
                bucket={statusBucket(c.status, c.startedAt)}
                outcome={c.outcome}
                divided={i > 0}
                onPress={() => router.push(`/call/${c.id}`)}
              />
            ))}
          </SectionCard>
        )}

        {/* Upcoming */}
        <SectionCard
          title="Upcoming appointments"
          action={
            <TextLink
              label="View all"
              role="link"
              compact
              accessibilityLabel="View all appointments"
              onPress={() => router.push('/calendar')}
            />
          }
        >
          {upcoming.length === 0 ? (
            <Text style={styles.muted}>
              Nothing booked yet - appointments your receptionist books will show up here.
            </Text>
          ) : (
            upcoming.map((b, i) => (
              <UpcomingRow key={b.id} booking={b} timezone={data.timezone} divided={i > 0} />
            ))
          )}
          {/* Undated booking requests: the server leaves them out of
              `upcoming`, and the web nudges a person to confirm them. */}
          {data.toConfirm > 0 && (
            <Pressable
              onPress={() => router.push('/calendar')}
              accessibilityRole="button"
              accessibilityLabel={`Requests to confirm, ${data.toConfirm}`}
              accessibilityHint="Opens Appointments"
              android_ripple={ripple}
              style={({ pressed: down }) => [styles.confirmRow, down && pressed]}
            >
              <Text style={styles.confirmText}>Requests to confirm ({data.toConfirm})</Text>
              <Icon name="chevron-forward" size={ICON.chevron} color={colors.warningText} />
            </Pressable>
          )}
        </SectionCard>

        {/* Plan usage. Shown in BOTH ranges, exactly like the web's rail card -
            the allowance does not change with the range you are looking at -
            and, like the web, only when there is a plan to talk about. */}
        {data.plan && (
          <SectionCard
            title="Plan usage"
            action={
              <TextLink
                label={planLabel}
                role="link"
                compact
                accessibilityHint="Opens your subscription in Settings"
                onPress={() => router.push('/(tabs)/settings')}
              />
            }
          >
            <View style={styles.meterHead}>
              <Text style={styles.muted}>Minutes</Text>
              <Text style={styles.meterValue}>
                {data.monthUsage.minutes}
                {minutesCapped ? ` / ${minutesIncluded}` : ''}
              </Text>
            </View>
            {minutesCapped && (
              <View style={styles.meterTrack}>
                <View
                  style={[
                    styles.meterFill,
                    {
                      width: `${minutePct}%`,
                      backgroundColor: minutePct >= 90 ? colors.warning : colors.ink,
                    },
                  ]}
                />
              </View>
            )}
            {forecast && (
              <Text style={[styles.forecast, forecast.willExceed && styles.forecastWarn]}>
                {forecastLine(forecast)}
              </Text>
            )}
          </SectionCard>
        )}
      </View>
    </Screen>
  );
}

/**
 * The Home header: the receptionist in the web's avatar ring with its status
 * dot, its name, what it is doing right now, and the bell. It replaces a page
 * title - the tab already says Home, and the web home has no title either.
 */
function BrandHeader({
  name,
  status,
  unread,
  onBell,
}: {
  name: string;
  status: AvatarStatus;
  unread: boolean;
  onBell: () => void;
}) {
  const line = STATUS_LINE[status];
  return (
    <View style={styles.brand}>
      <AvatarRing size={44} mood="greeting" status={status} />
      <View
        style={styles.brandText}
        accessible
        accessibilityRole="header"
        accessibilityLabel={`${name}, ${line}`}
      >
        <Text style={styles.brandName} numberOfLines={1}>
          {name}
        </Text>
        <Text style={styles.brandStatus} numberOfLines={1}>
          {line}
        </Text>
      </View>
      <BellButton unread={unread} onPress={onBell} />
    </View>
  );
}

function BrandHeaderSkeleton({ onBell }: { onBell: () => void }) {
  return (
    <View style={styles.brand}>
      <Skeleton width={44} height={44} radius={22} />
      <View style={[styles.brandText, styles.brandSkeleton]}>
        <Skeleton width="45%" height={16} />
        <Skeleton width="30%" height={12} />
      </View>
      <BellButton unread={false} onPress={onBell} />
    </View>
  );
}

/** The bell: the shared round icon button with the unread dot laid over it. */
function BellButton({ unread, onPress }: { unread: boolean; onPress: () => void }) {
  return (
    <View>
      <IconButton
        icon="notifications-outline"
        label={unread ? 'Recent activity, new calls' : 'Recent activity'}
        onPress={onPress}
      />
      {unread ? <View style={styles.bellDot} pointerEvents="none" /> : null}
    </View>
  );
}

/** en.ts calendar status words; a confirmed booking needs no badge. */
function bookingBadge(status: Booking['status']): { label: string; tone: BadgeTone } | null {
  switch (status) {
    case 'pending':
      return { label: 'Pending', tone: 'neutral' };
    case 'failed':
      return { label: "Didn't sync", tone: 'error' };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'neutral' };
    default:
      return null;
  }
}

/** One upcoming appointment. Opens Appointments on the day it sits on, in the owner's zone. */
function UpcomingRow({
  booking: b,
  timezone,
  divided,
}: {
  booking: Booking;
  timezone: string;
  divided: boolean;
}) {
  const router = useRouter();
  const name = b.attendeeName || b.title || 'Unknown caller';
  const when = formatWhen(b.startTime, timezone);
  const meta = b.assistant ? `${when} · ${b.assistant}` : when;
  const badge = bookingBadge(b.status);
  const day = dayKey(b.startTime, timezone);
  return (
    <Pressable
      onPress={() =>
        day ? router.push({ pathname: '/calendar', params: { day } }) : router.push('/calendar')
      }
      accessibilityRole="button"
      accessibilityLabel={[name, meta, badge?.label].filter(Boolean).join(', ')}
      accessibilityHint="Opens this day in Appointments"
      android_ripple={ripple}
      style={({ pressed: down }) => [styles.activityRow, divided && styles.divided, down && pressed]}
    >
      <View style={styles.flex}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {name}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {meta}
        </Text>
      </View>
      {badge ? <Badge label={badge.label} tone={badge.tone} /> : null}
      <Icon name="chevron-forward" size={ICON.chevron} color={colors.textMuted} />
    </Pressable>
  );
}

/**
 * Whether to show the push primer, and its two answers.
 *
 * The OS prompt is shown once in an install's life, so it is only asked for
 * behind this card - after setup, when there is something to be alerted about.
 * Only offered while the OS can still ask: after a system-level "no", the
 * Alerts screen is the way back, and a card whose button can do nothing is
 * worse than none.
 */
function usePushPrimer() {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

  // On focus, not mount: the tabs keep Home mounted, and alerts turned on in
  // Settings > Alerts or the OS settings must take the card away.
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void (async () => {
        if (await primerAnswered()) {
          if (alive) setShow(false);
          return;
        }
        try {
          const permission = await Notifications.getPermissionsAsync();
          if (alive) setShow(!permission.granted && permission.canAskAgain);
        } catch {
          // No permission API on this build: no primer.
        }
      })();
      return () => {
        alive = false;
      };
    }, []),
  );

  const accept = useCallback(async () => {
    setBusy(true);
    let result: PushState;
    try {
      result = await requestAndRegister();
    } catch (err) {
      result = { status: 'error', reason: (err as Error).message };
    }
    await markPrimerAnswered();
    setBusy(false);
    setShow(false);
    // A "no" at the system prompt was the user's own answer and needs no
    // reply; a phone that could not register at all does.
    if (result.status === 'error' || result.status === 'unsupported') {
      Alert.alert('Alerts are not on', result.reason);
    }
  }, []);

  const dismiss = useCallback(() => {
    setShow(false);
    void markPrimerAnswered();
  }, []);

  return { show, busy, accept: () => void accept(), dismiss };
}

function PushPrimer({
  busy,
  onAccept,
  onDismiss,
}: {
  busy: boolean;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  return (
    <Card>
      <View style={styles.primerHead}>
        <View style={styles.primerIcon}>
          <Icon name="notifications-outline" size={18} color={colors.ink} />
        </View>
        <View style={styles.flex}>
          <Text style={styles.primerTitle} accessibilityRole="header">
            Know the moment a call ends
          </Text>
          <Text style={styles.primerBody}>
            Get an alert with who called and what your receptionist did: bookings, messages, and
            anything that needs you.
          </Text>
        </View>
      </View>
      <View style={styles.statusActions}>
        <Button
          label="Turn on alerts"
          size="pill"
          onPress={onAccept}
          busy={busy}
          style={styles.flexBtn}
        />
        <Button
          label="Not now"
          size="pill"
          variant="secondary"
          onPress={onDismiss}
          disabled={busy}
          style={styles.flexBtn}
        />
      </View>
    </Card>
  );
}

/** When Activity was last opened (ms), re-read whenever Home comes forward. Null until read. */
function useActivitySeenAt(): number | null {
  const [seenAt, setSeenAt] = useState<number | null>(null);
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      AsyncStorage.getItem(LAST_SEEN_KEY)
        .then((raw) => {
          if (!alive) return;
          // Never opened: everything counts as new, the same as the web bell.
          const t = raw ? Date.parse(raw) : 0;
          setSeenAt(Number.isFinite(t) ? t : 0);
        })
        .catch(() => {
          // Unreadable storage: no dot rather than a dot that never clears.
        });
      return () => {
        alive = false;
      };
    }, []),
  );
  return seenAt;
}

/** The first-load placeholder, in the layout it stands in for. */
function HomeSkeleton() {
  return (
    <View style={styles.body} accessible accessibilityLabel="Loading">
      <Card>
        <View style={styles.statusRow}>
          <Skeleton width={10} height={10} radius={5} />
          <Skeleton width="62%" height={14} />
        </View>
        <View style={styles.statusActions}>
          <View style={styles.flex}>
            <Skeleton height={40} radius={radius.pill} />
          </View>
          <View style={styles.flex}>
            <Skeleton height={40} radius={radius.pill} />
          </View>
        </View>
      </Card>
      <Skeleton height={40} radius={radius.pill} />
      <TilesSkeleton />
      <Card>
        <Skeleton width="35%" height={14} style={styles.skeletonHeading} />
        <SkeletonRows count={4} />
      </Card>
    </View>
  );
}

/** Two rows of two tiles, the height of the StatTiles they stand in for. */
function TilesSkeleton() {
  return (
    <View style={styles.tilesSkeleton}>
      {[0, 1].map((row) => (
        <View key={row} style={styles.tiles}>
          {[0, 1].map((col) => (
            <View key={col} style={styles.tileSkeleton}>
              <View style={styles.tileSkeletonLabel}>
                <Skeleton width="55%" height={11} />
              </View>
              <View style={styles.tileSkeletonValue}>
                <Skeleton width="35%" height={22} />
              </View>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

/**
 * The forecast in one sentence.
 *
 * Three cases, not two. An account that has already burned its allowance needs
 * the past tense - telling someone on the 20th that they "would" run out on the
 * 16th reads as a prediction about something that already cost them money.
 */
function forecastLine(f: MinuteForecast): string {
  if (f.alreadyExceeded) {
    return `Past your monthly minutes - about ${f.projected} by month end at this rate.`;
  }
  if (f.willExceed) {
    return f.exhaustedOnDay
      ? `On pace for about ${f.projected} minutes - you'd use up your allowance around the ${ordinal(f.exhaustedOnDay)}.`
      : `On pace for about ${f.projected} minutes, over your allowance.`;
  }
  return `On pace for about ${f.projected} minutes this month.`;
}

/** 1 -> "1st". Only ever fed a day of the month. */
function ordinal(day: number): string {
  const rem100 = day % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

/**
 * Needs attention: real operational issues, most urgent first, capped at three
 * so the card never becomes a to-do list. An empty list says so plainly rather
 * than disappearing - "is anything broken?" deserves an explicit no.
 */
interface Issue {
  level: 'red' | 'amber';
  text: string;
  /** What tapping it does about the problem. Every web issue is a link; a row that only names a fault is a dead end. */
  action: string;
  go: () => void;
}

function Issues({
  assistantId,
  assistantCount,
  online,
  number,
  calendarConnected,
  minutesUsed,
  minutesIncluded,
}: {
  assistantId: string | null;
  assistantCount: number;
  online: boolean;
  number: string;
  calendarConnected: boolean;
  minutesUsed: number;
  minutesIncluded: number;
}) {
  const router = useRouter();

  // With one receptionist the fix is on its own screen; the list would only
  // be one more tap in the way.
  const toReceptionist = () =>
    assistantId && assistantCount === 1
      ? router.push(`/assistant/${assistantId}`)
      : router.push('/assistant');

  // Same four rules, same order, same thresholds and the same words as the web
  // overview. Keep them in step: a phone that disagrees about whether anything
  // is wrong is worse than a phone that says nothing.
  const issues: Issue[] = [];
  if (assistantId && !online) {
    issues.push({
      level: 'amber',
      text: 'Your receptionist is paused',
      action: 'Resume',
      go: toReceptionist,
    });
  }
  if (!number) {
    issues.push({
      level: 'red',
      text: 'No phone number connected',
      action: 'Get a number',
      go: toReceptionist,
    });
  }
  if (!calendarConnected) {
    issues.push({
      level: 'amber',
      text: "Calendar isn't connected",
      action: 'Connect',
      go: () => router.push('/calendar/connections'),
    });
  }
  if (minutesIncluded > 0 && minutesUsed / minutesIncluded >= 0.9) {
    issues.push({
      level: 'amber',
      text: "You've nearly used all your plan minutes",
      // The in-app paywall, never the browser. It shows store plans to a
      // store subscriber and plain status text to a web-billed or comp one.
      action: 'See plans',
      go: () => router.push({ pathname: '/paywall', params: { reason: 'minutes' } }),
    });
  }

  return (
    <SectionCard title="Needs attention">
      {issues.length === 0 ? (
        <View style={styles.statusRow} accessible>
          <Dot color={colors.success} />
          <Text style={[styles.muted, styles.flex]}>All systems go - nothing needs your attention</Text>
        </View>
      ) : (
        issues.slice(0, 3).map((issue) => (
          <Pressable
            key={issue.text}
            onPress={issue.go}
            accessibilityRole="button"
            accessibilityLabel={`${issue.text}. ${issue.action}`}
            android_ripple={ripple}
            style={({ pressed: down }) => [styles.issueRow, down && pressed]}
          >
            <Dot color={issue.level === 'red' ? colors.error : colors.warning} />
            <Text style={styles.issueText} numberOfLines={2}>
              {issue.text}
            </Text>
            <Text style={styles.issueAction}>{issue.action}</Text>
            <Icon name="chevron-forward" size={ICON.chevron} color={colors.textMuted} />
          </Pressable>
        ))
      )}
    </SectionCard>
  );
}

const styles = StyleSheet.create({
  body: {
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  flex: { flex: 1 },
  flexBtn: { flex: 1 },

  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  brandText: { flex: 1 },
  brandSkeleton: { gap: 6 },
  brandName: { ...type.title },
  brandStatus: { ...type.caption, marginTop: 1 },
  bellDot: {
    position: 'absolute',
    top: 9,
    right: 10,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.ink,
    borderWidth: 2,
    borderColor: colors.surfaceSubtle,
  },

  live: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.ink,
    ...shape.card,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    overflow: 'hidden',
  },
  liveTitle: { ...type.body, fontFamily: fonts.semibold, color: colors.white },
  liveBody: { ...type.caption, color: colors.textOnInk, marginTop: 1 },

  primerHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  primerIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceSubtle,
  },
  primerTitle: { ...type.section, fontFamily: fonts.semibold },
  primerBody: { ...type.bodySm, color: colors.textSecondary, marginTop: 2 },

  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  statusText: {
    ...type.bodySm,
    fontFamily: fonts.medium,
    flex: 1,
  },
  statusActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
  },

  tiles: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  tilesSkeleton: { gap: spacing.md },
  tileSkeleton: {
    ...cardStyle,
    flex: 1,
    padding: spacing.lg,
  },
  // The StatTile's caption line (16) and stat line (30, 4 below it).
  tileSkeletonLabel: { height: 16, justifyContent: 'center' },
  tileSkeletonValue: { height: 30, marginTop: 4, justifyContent: 'center' },
  skeletonHeading: { marginBottom: spacing.lg },

  activityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 52,
    paddingVertical: 10,
  },
  divided: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  rowTitle: { ...type.bodySm, fontFamily: fonts.medium },
  rowMeta: { ...type.caption, marginTop: 2 },

  confirmRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    minHeight: 44,
    marginTop: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.warningBorder,
    backgroundColor: colors.warningSoft,
  },
  confirmText: { ...type.label, color: colors.warningText },

  emptyNumber: {
    ...type.heading,
    fontFamily: fonts.medium,
    fontVariant: ['tabular-nums'],
    marginTop: spacing.lg,
  },
  emptyCta: { marginTop: spacing.md },

  muted: {
    ...type.bodySm,
    color: colors.textSecondary,
  },

  // These rows are the screen's real CTAs, so they get a thumb-sized target of
  // their own rather than the bare `statusRow` layout the status band uses. The
  // padding also supplies the gap between rows, so they need no margin.
  issueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 44,
    paddingVertical: spacing.sm,
  },
  issueText: { ...type.bodySm, flex: 1 },
  issueAction: { ...type.caption, fontFamily: fonts.medium },

  meterHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  meterValue: {
    ...type.bodySm,
    fontFamily: fonts.semibold,
    fontVariant: ['tabular-nums'],
  },
  meterTrack: {
    marginTop: spacing.sm,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.surfaceSubtle,
    overflow: 'hidden',
  },
  meterFill: {
    height: '100%',
    borderRadius: 3,
  },
  forecast: { ...type.caption, marginTop: spacing.sm },
  forecastWarn: { color: colors.warningText, fontFamily: fonts.medium },
  chartWrap: {
    marginTop: spacing.lg,
  },
});
