import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  Alert,
  AppState,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, type IconName } from '@/components/Icon';
import { RecordingPlayer } from '@/components/RecordingPlayer';
import { SaveBar, Sheet, TextField } from '@/components/form';
import {
  Badge,
  Button,
  Card,
  ErrorState,
  ICON,
  LiveDot,
  NotFoundState,
  Notice,
  pressed,
  ripple,
  Row,
  SectionCard,
  Skeleton,
  SkeletonCard,
  StaleNotice,
  TextLink,
  type BadgeTone,
} from '@/components/ui';
import { colors, control, fonts, MAX_FONT_SCALE, radius, shape, spacing, type } from '@/constants/theme';
import { api } from '@/lib/api';
import {
  bucketLabel,
  callerLabel,
  callHeadline,
  formatPhone,
  outcomeLabel,
  sentimentLabel,
  sentimentTone,
  statusBucket,
  type StatusBucket,
} from '@/lib/format';
import { dial } from '@/lib/links';
import type { CallActionItem, CallDetail, CallTurn } from '@/lib/types';
import { useQuery } from '@/lib/use-query';
import { useTranslated } from '@/lib/use-translated';

/** How often a live call is re-read while someone watches it. */
const LIVE_POLL_MS = 5000;

/** How long a live transcript must hold still before it is sent for translation. */
const LIVE_TRANSLATE_DEBOUNCE_MS = 3000;

/** How close to the end of the transcript still counts as "following" it. */
const FOLLOW_SLOP = 80;

const BUCKET_TONE: Record<StatusBucket, BadgeTone> = {
  completed: 'success',
  unanswered: 'error',
  active: 'warning',
};

export default function CallDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [reportOpen, setReportOpen] = useState(false);
  const [reported, setReported] = useState(false);
  const [textOpen, setTextOpen] = useState(false);
  // The last text sent from this screen, said under the actions: a sheet that
  // simply closes leaves "did that go?" hanging.
  const [textSent, setTextSent] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);

  // Bumped by the live poll below. A dependency rather than `refresh()`:
  // `refresh` is the pull-to-refresh, and binding the control to it would spin
  // the spinner (and offset the transcript) every five seconds with nobody
  // touching the screen. A dependency change refetches with the payload kept.
  const [poll, setPoll] = useState(0);

  const { data, error, errorStatus, loading, refreshing, refresh } = useQuery<CallDetail>(
    () => api.call(String(id)),
    [id, poll],
  );

  // The receptionist's name is only worth a place in the header when there is
  // more than one to tell apart - the web's rule. The detail does not say how
  // many there are, so ask; until that answers (or if it fails) the name is
  // simply left out, never waited for.
  const team = useQuery(() => api.assistants(), []);
  const manyReceptionists = (team.data?.assistants.length ?? 0) > 1;

  const title = data ? callerLabel(data.from) : null;
  useEffect(() => {
    if (title) navigation.setOptions({ title });
  }, [navigation, title]);

  const live = Boolean(data?.isLive);

  // Follow a live call: poll only while this screen is focused and the app is
  // in the foreground. A timer running behind another screen, or in a pocket,
  // is battery spent on a transcript nobody is reading.
  useFocusEffect(
    useCallback(() => {
      if (!live) return;
      let timer: ReturnType<typeof setInterval> | null = null;
      const start = () => {
        if (!timer) timer = setInterval(() => setPoll((n) => n + 1), LIVE_POLL_MS);
      };
      const stop = () => {
        if (timer) clearInterval(timer);
        timer = null;
      };
      if (AppState.currentState === 'active') start();
      const sub = AppState.addEventListener('change', (next) => {
        if (next === 'active') start();
        else stop();
      });
      return () => {
        stop();
        sub.remove();
      };
    }, [live]),
  );

  // The moment the call ends while it is on screen: say so, once.
  const wasLive = useRef<boolean | null>(null);
  const [ended, setEnded] = useState(false);
  useEffect(() => {
    if (!data) return;
    if (wasLive.current === true && !data.isLive) {
      setEnded(true);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      AccessibilityInfo.announceForAccessibility('Call ended');
    }
    wasLive.current = data.isLive;
  }, [data]);

  // -- Translation --
  // Summary, claims and turns go out as ONE request. While the call is live
  // each new turn is new content, so the request waits for the transcript to
  // hold still for a few seconds instead of going out on every poll.
  const source = useMemo(() => {
    const texts: string[] = [];
    if (!data) return { texts, summaryAt: -1, claimsAt: 0, turnsAt: 0 };
    const summaryAt = data.summary ? texts.push(data.summary) - 1 : -1;
    const claimsAt = texts.length;
    texts.push(...data.reviewClaims);
    const turnsAt = texts.length;
    texts.push(...data.turns.map((t) => t.text));
    return { texts, summaryAt, claimsAt, turnsAt };
  }, [data]);
  const translation = useTranslated(source.texts, {
    enabled: Boolean(data),
    debounceMs: live ? LIVE_TRANSLATE_DEBOUNCE_MS : 0,
  });
  const shown = showOriginal ? source.texts : translation.texts;

  // -- Following the transcript while live --
  const scrollRef = useRef<ScrollView>(null);
  const viewport = useRef({ y: 0, height: 0 });
  const transcriptBottom = useRef(0);
  const turnCount = useRef<number | null>(null);
  const turnsNow = data?.turns.length ?? 0;

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    viewport.current = {
      y: e.nativeEvent.contentOffset.y,
      height: e.nativeEvent.layoutMeasurement.height,
    };
  }, []);

  // The transcript's own bottom edge, not the page's: while live the
  // transcript sits under the header with the other cards below it, so the
  // end of the page is not where the newest words are.
  const onTranscriptLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const { y, height } = e.nativeEvent.layout;
      const bottom = y + height;
      const before = transcriptBottom.current;
      const prevCount = turnCount.current;
      transcriptBottom.current = bottom;
      turnCount.current = turnsNow;
      if (!live || prevCount === null || turnsNow <= prevCount) return;
      const v = viewport.current;
      // Only when they were already reading the end. Someone who scrolled up
      // to re-read a turn is not yanked away from it.
      if (v.y + v.height < before - FOLLOW_SLOP) return;
      // Forward only: when the new turn already fits on screen there is
      // nothing to follow, and scrolling back up to line it up would move the
      // page under their thumb.
      const target = bottom - v.height + spacing.lg;
      if (target <= v.y) return;
      scrollRef.current?.scrollTo({ y: target, animated: true });
    },
    [live, turnsNow],
  );

  // Only a first load with nothing to show takes the whole screen: `useQuery`
  // keeps the last good payload and sets `error` on every failed refetch,
  // including the live poll, so checking `error` first would unmount a loaded
  // call - transcript, player mid-playback and all - on one dropped packet.
  if (loading && !data) return <DetailSkeleton />;
  if (!data) {
    if (errorStatus === 404) {
      return (
        <View style={styles.root}>
          <NotFoundState
            title="This call is no longer available"
            body="It may have been deleted, or it belongs to another account."
            actionLabel="Back"
            onAction={() => (router.canGoBack() ? router.back() : router.replace('/calls'))}
          />
        </View>
      );
    }
    return (
      <View style={styles.root}>
        <ErrorState message={error ?? 'Could not load this call.'} onRetry={refresh} />
      </View>
    );
  }

  const bucket = statusBucket(data.status, data.date);
  const withheld = !data.from;
  const meta = [data.dateLabel, data.durationLabel, manyReceptionists ? data.assistant : '']
    .filter(Boolean)
    .join(' · ');
  const mood = sentimentLabel(data.sentiment);
  // As on the web: the outcome as a badge too, except "hung up", which the
  // web leaves to the headline.
  const outcome =
    data.outcome && data.outcome.toLowerCase() !== 'abandoned' ? outcomeLabel(data.outcome) : '';
  const badgeWords = [
    data.isLive ? 'Live' : '',
    bucketLabel(bucket),
    outcome,
    mood ? `Caller mood ${mood}` : '',
  ].filter(Boolean);

  // The toggle sits on each card whose words actually changed - a Spanish
  // transcript under an English summary gets one on the transcript only. One
  // state behind all of them, so the page never shows half of each language.
  const changed = (from: number, count: number) =>
    translation.hasTranslation &&
    translation.texts
      .slice(from, from + count)
      .some((s, i) => s.trim() !== (source.texts[from + i] ?? '').trim());
  const toggle = (
    <TranslationToggle showOriginal={showOriginal} onToggle={() => setShowOriginal((v) => !v)} />
  );
  const summaryToggle = source.summaryAt >= 0 && changed(source.summaryAt, 1) ? toggle : null;
  const claimsToggle = changed(source.claimsAt, data.reviewClaims.length) ? toggle : null;
  const turnsToggle = changed(source.turnsAt, data.turns.length) ? toggle : null;
  // Not while live: a live transcript keeps changing, so dimming it until the
  // first debounced reply would grey out even an English call for seconds.
  const dim = translation.translating && !showOriginal && !live ? styles.dim : null;

  const claims = shown.slice(source.claimsAt, source.claimsAt + data.reviewClaims.length);

  const header = (
    <Card key="header">
      <Text style={styles.headline} accessibilityRole="header">
        {callHeadline({ outcome: data.outcome, status: data.status, date: data.date })}
      </Text>
      {meta ? <Text style={styles.meta}>{meta}</Text> : null}
      <View style={styles.badges} accessible accessibilityLabel={badgeWords.join(', ')}>
        {data.isLive ? <Badge label="Live" tone="live" /> : null}
        <Badge label={bucketLabel(bucket)} tone={BUCKET_TONE[bucket]} />
        {outcome ? <Badge label={outcome} tone="neutral" /> : null}
        {mood ? <Badge label={mood} tone={sentimentTone(data.sentiment)} /> : null}
      </View>
      {ended ? (
        <Notice tone="success" icon="checkmark-circle" live style={styles.noticeGap}>
          Call ended
        </Notice>
      ) : null}
      <CallerActions
        from={data.from}
        withheld={withheld}
        onText={() => setTextOpen(true)}
      />
      {textSent ? (
        <Notice tone="success" icon="checkmark-circle" live style={styles.noticeGap}>
          {`Text sent to ${formatPhone(data.from)}`}
        </Notice>
      ) : null}
    </Card>
  );

  const recording = data.hasAudio ? (
    <SectionCard key="recording" title="Recording">
      <RecordingPlayer key={data.id} callId={data.id} />
    </SectionCard>
  ) : null;

  const summary = (
    <SectionCard key="summary" title="Summary" action={summaryToggle}>
      {source.summaryAt >= 0 ? (
        <Text style={[styles.summary, dim]}>{shown[source.summaryAt]}</Text>
      ) : (
        <Text style={styles.placeholder}>
          {live ? 'The summary is written once the call ends.' : 'No summary for this call.'}
        </Text>
      )}
    </SectionCard>
  );

  // Right under the summary, above the actions, as on the web: something the
  // receptionist told a caller that the knowledge base does not back up is the
  // most important thing on the page, and each claim is a gap to fill.
  const review = data.needsReview ? (
    <SectionCard
      key="review"
      title="Worth a look"
      action={
        claimsToggle ?? <Icon name="alert-circle-outline" size={18} color={colors.warningText} />
      }
    >
      {data.reviewClaims.length > 0 ? (
        <>
          <Text style={styles.bodySecondary}>
            Your receptionist told this caller things your knowledge base doesn&apos;t back up:
          </Text>
          <View style={[styles.claims, dim]}>
            {claims.map((claim, i) => (
              <Notice key={i} tone="warning" icon={null}>
                {claim}
              </Notice>
            ))}
          </View>
          <Button
            label="Add the right answer to your knowledge"
            variant="secondary"
            icon="book-outline"
            onPress={() => router.push('/knowledge')}
            style={styles.reviewButton}
          />
        </>
      ) : (
        <Text style={styles.bodySecondary}>
          Something about this call is worth reading in full - an unhappy caller, or a promise
          that may need following up.
        </Text>
      )}
    </SectionCard>
  ) : null;

  const actions = (
    <SectionCard key="actions" title="What it did">
      {data.actions.length === 0 ? (
        <Text style={styles.placeholder}>No actions taken on this call.</Text>
      ) : (
        data.actions.map((a, i) => (
          <ActionRow
            key={a.id}
            action={a}
            divided={i > 0}
            onOpenDay={(day) => router.push({ pathname: '/calendar', params: { day } })}
          />
        ))
      )}
    </SectionCard>
  );

  const transcript = (
    <View key="transcript" onLayout={onTranscriptLayout}>
      <SectionCard
        title="Transcript"
        action={
          live ? (
            <View style={styles.transcriptActions}>
              {turnsToggle}
              <LiveMark />
            </View>
          ) : (
            turnsToggle
          )
        }
      >
        {data.turns.length === 0 ? (
          <Text style={styles.placeholder}>No transcript yet.</Text>
        ) : (
          <View style={[styles.turns, dim]}>
            {data.turns.map((t, i) => (
              <Turn key={t.id} turn={t} text={shown[source.turnsAt + i] ?? t.text} />
            ))}
          </View>
        )}
      </SectionCard>
    </View>
  );

  const details = (
    <SectionCard key="details" title="Details">
      <Row label="From" value={callerLabel(data.from)} />
      <Row label="To" value={formatPhone(data.to)} />
    </SectionCard>
  );

  // Live, the transcript is the page: straight under the header, where it can
  // be followed. Once the call ends the usual reading order comes back.
  const blocks: ReactNode[] = live
    ? [header, transcript, actions, summary, review, details]
    : [header, recording, summary, review, actions, transcript, details];

  return (
    <View style={styles.root}>
      {error ? (
        <View style={styles.staleWrap}>
          <StaleNotice message={error} onRetry={refresh} />
        </View>
      ) : null}
      <ScrollView
        ref={scrollRef}
        style={styles.flex}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]}
        onScroll={onScroll}
        scrollEventThrottle={32}
        onLayout={(e) => {
          viewport.current = { ...viewport.current, height: e.nativeEvent.layout.height };
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={colors.textSecondary}
            colors={[colors.ink]}
          />
        }
      >
        {blocks}

        {reported ? (
          <Notice tone="success" icon="checkmark-circle" live style={styles.reportSent}>
            Report sent - thanks
          </Notice>
        ) : (
          <Pressable
            onPress={() => setReportOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Report an issue"
            accessibilityHint="Tell us what went wrong on this call"
            style={({ pressed: down }) => [styles.report, down && pressed]}
          >
            <Icon name="flag-outline" size={ICON.chevron} color={colors.textSecondary} />
            <Text style={styles.reportText}>Report an issue</Text>
          </Pressable>
        )}
      </ScrollView>

      <TextBackSheet
        visible={textOpen}
        callId={data.id}
        to={data.from}
        onClose={() => setTextOpen(false)}
        onSent={(message) => {
          setTextOpen(false);
          setTextSent(message);
        }}
      />

      <ReportSheet
        visible={reportOpen}
        callId={data.id}
        onClose={() => setReportOpen(false)}
        onSent={() => {
          setReportOpen(false);
          setReported(true);
        }}
      />
    </View>
  );
}

function DetailSkeleton() {
  return (
    <View style={styles.root}>
      <View style={styles.content}>
        <Card>
          <View style={styles.skeletonHead} accessible accessibilityLabel="Loading">
            <Skeleton width="55%" height={18} />
            <Skeleton width="40%" height={12} />
            <View style={styles.skeletonBadges}>
              <Skeleton width={72} height={20} radius={radius.sm} />
              <Skeleton width={84} height={20} radius={radius.sm} />
            </View>
            <View style={styles.actions}>
              {[0, 1, 2].map((i) => (
                <View key={i} style={styles.flex}>
                  <Skeleton height={60} radius={radius.md} />
                </View>
              ))}
            </View>
          </View>
        </Card>
        <SkeletonCard lines={3} />
        <SkeletonCard lines={2} />
        <SkeletonCard lines={4} />
      </View>
    </View>
  );
}

/** Call back, copy, text back - all three need the caller's number. */
function CallerActions({
  from,
  withheld,
  onText,
}: {
  from: string;
  withheld: boolean;
  onText: () => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const hint = withheld ? 'Number withheld' : undefined;
  return (
    <>
      <View style={styles.actions}>
        <IconAction
          icon="call-outline"
          label="Call back"
          disabled={withheld}
          hint={hint}
          onPress={() => void dial(from)}
        />
        <IconAction
          icon={copied ? 'checkmark' : 'copy-outline'}
          label={copied ? 'Copied' : 'Copy number'}
          disabled={withheld}
          hint={hint}
          onPress={async () => {
            await Clipboard.setStringAsync(from);
            setCopied(true);
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            AccessibilityInfo.announceForAccessibility('Number copied');
          }}
        />
        <IconAction
          icon="chatbubble-outline"
          label="Text back"
          disabled={withheld}
          hint={hint}
          onPress={onText}
        />
      </View>
      {withheld ? (
        // Said for sighted users too: three greyed buttons with no reason
        // read as a broken screen.
        <Text style={styles.withheld} importantForAccessibility="no" accessibilityElementsHidden>
          Number withheld
        </Text>
      ) : null}
    </>
  );
}

function IconAction({
  icon,
  label,
  onPress,
  disabled,
  hint,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: Boolean(disabled) }}
      android_ripple={ripple}
      style={({ pressed: down }) => [
        styles.iconAction,
        down && !disabled && pressed,
        disabled && styles.off,
      ]}
    >
      <Icon name={icon} size={ICON.row} color={colors.ink} />
      <Text style={styles.iconActionLabel} maxFontSizeMultiplier={MAX_FONT_SCALE}>
        {label}
      </Text>
    </Pressable>
  );
}

function LiveMark() {
  return (
    <View style={styles.liveMark} accessible accessibilityLabel="Live, updating as the call goes on">
      <LiveDot size={8} />
      <Text style={styles.liveMarkText}>Live</Text>
    </View>
  );
}

function TranslationToggle({
  showOriginal,
  onToggle,
}: {
  showOriginal: boolean;
  onToggle: () => void;
}) {
  return (
    <TextLink
      label={showOriginal ? 'Show translation' : 'Show original'}
      compact
      onPress={onToggle}
    />
  );
}

/**
 * One turn, as the web draws it: who spoke and when above the bubble, the
 * caller dark on the left, the receptionist light on the right. One VoiceOver
 * stop per turn that says who is speaking - a bare bubble never did.
 */
function Turn({ turn, text }: { turn: CallTurn; text: string }) {
  const caller = turn.role === 'caller';
  const speaker = caller ? 'Caller' : 'Receptionist';
  return (
    <View
      style={[styles.turn, caller ? styles.turnLeft : styles.turnRight]}
      accessible
      accessibilityLabel={turn.atLabel ? `${speaker}, ${turn.atLabel}: ${text}` : `${speaker}: ${text}`}
    >
      <View style={[styles.turnMeta, !caller && styles.turnMetaRight]}>
        <Text style={styles.turnSpeaker} maxFontSizeMultiplier={MAX_FONT_SCALE}>
          {speaker}
        </Text>
        {turn.atLabel ? (
          <Text style={styles.turnAt} maxFontSizeMultiplier={MAX_FONT_SCALE}>
            {turn.atLabel}
          </Text>
        ) : null}
      </View>
      <View style={[styles.bubble, caller ? styles.bubbleCaller : styles.bubbleAgent]}>
        <Text style={[styles.bubbleText, caller && styles.bubbleTextCaller]}>{text}</Text>
      </View>
    </View>
  );
}

// -- What it did (the web's ActionItems.tsx) --

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function actionTypeLabel(type: string): string {
  switch (type) {
    case 'booking':
      return 'Appointment booked';
    case 'message':
      return 'Message taken';
    case 'transfer':
      return 'Call passed to you';
    default:
      // Never the raw DB type - that is internal vocabulary.
      return 'Other action';
  }
}

function actionStatus(status: string): { label: string; tone: BadgeTone } {
  switch (status) {
    case 'done':
      return { label: 'Done', tone: 'success' };
    case 'failed':
      return { label: "Didn't go through", tone: 'error' };
    default:
      return { label: 'Pending', tone: 'neutral' };
  }
}

/**
 * The instant, shifted to the wall clock its own offset encodes - the
 * business's local time, whatever zone the phone is in. Reading the result
 * in UTC gives that local time.
 */
function wallClock(iso: string): Date | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const m = iso.match(/([+-])(\d{2}):?(\d{2})$/);
  const offsetMin = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  return new Date(ms + offsetMin * 60_000);
}

function formatWhen(startIso: string, endIso: string): string {
  const start = wallClock(startIso);
  if (!start) return '';
  const day = start.toLocaleDateString('en', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const time = (d: Date) =>
    d.toLocaleTimeString('en', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' });
  const end = wallClock(endIso);
  return `${day} · ${time(start)}${end ? ` - ${time(end)}` : ''}`;
}

/** 'YYYY-MM-DD' of the booking in the business's own zone - the calendar's day key. */
function bookingDay(startIso: string): string {
  const start = wallClock(startIso);
  if (!start) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${start.getUTCFullYear()}-${pad(start.getUTCMonth() + 1)}-${pad(start.getUTCDate())}`;
}

function ActionRow({
  action,
  divided,
  onOpenDay,
}: {
  action: CallActionItem;
  divided: boolean;
  onOpenDay: (day: string) => void;
}) {
  const label = actionTypeLabel(action.type);
  const status = actionStatus(action.status);
  const p = action.payload;

  const head = (
    <View style={styles.actionHead}>
      <Text style={styles.actionType}>{label}</Text>
      <Badge label={status.label} tone={status.tone} />
    </View>
  );
  // Plain words, never the upstream error ("Dial leg failed: SIP 480 ..."),
  // which nobody running a business can act on. A failed row's badge already
  // says it; this is for an error on a row that is not marked failed.
  const failure =
    action.error && action.status !== 'failed' ? (
      <Text style={styles.actionFailed}>Didn&apos;t go through</Text>
    ) : null;

  if (action.type === 'booking') {
    const title = str(p.title);
    const when = formatWhen(str(p.start_time), str(p.end_time));
    const who = str(p.attendee_name);
    const phone = str(p.attendee_phone);
    const notes = str(p.notes);
    const day = bookingDay(str(p.start_time));
    const body = (
      <>
        {head}
        {title ? <Text style={styles.actionTitle}>{title}</Text> : null}
        {when ? <Text style={styles.actionWhen}>{when}</Text> : null}
        {who || phone ? (
          <Text style={styles.actionMeta}>
            {[who, phone ? formatPhone(phone) : ''].filter(Boolean).join(' · ')}
          </Text>
        ) : null}
        {notes ? <Text style={styles.actionMeta}>{notes}</Text> : null}
        {failure}
      </>
    );
    if (!day) return <View style={[styles.actionRow, divided && styles.divided]}>{body}</View>;
    return (
      <Pressable
        onPress={() => onOpenDay(day)}
        accessibilityRole="button"
        accessibilityLabel={[label, status.label, title, when].filter(Boolean).join(', ')}
        accessibilityHint="Opens your calendar on that day"
        android_ripple={ripple}
        style={({ pressed: down }) => [styles.actionRow, divided && styles.divided, down && pressed]}
      >
        {body}
        <View style={styles.openDay}>
          <Text style={styles.openDayText}>Open in calendar</Text>
          <Icon name="chevron-forward" size={ICON.chevron} color={colors.ink} />
        </View>
      </Pressable>
    );
  }

  if (action.type === 'message') {
    const message = str(p.message);
    const who = str(p.caller_name);
    const callback = str(p.callback_number);
    // The take_message tool's enum is low | normal | high; "urgent" is kept for
    // rows written before the enum existed.
    const urgency = str(p.urgency).toLowerCase();
    const urgent = urgency === 'high' || urgency === 'urgent';
    return (
      <View style={[styles.actionRow, divided && styles.divided]}>
        {head}
        {message ? <Text style={styles.actionTitle}>&quot;{message}&quot;</Text> : null}
        {who || callback || urgent ? (
          <View style={styles.messageMeta}>
            {/* The separator rides on the name, so it is not a stop of its own. */}
            {who ? <Text style={styles.actionMeta}>{callback ? `${who} ·` : who}</Text> : null}
            {callback ? (
              <Pressable
                onPress={() => void dial(callback)}
                accessibilityRole="link"
                accessibilityLabel={`Call ${formatPhone(callback)}`}
                hitSlop={{ top: 12, bottom: 12, left: 4, right: 4 }}
              >
                <Text style={styles.callbackLink}>{formatPhone(callback)}</Text>
              </Pressable>
            ) : null}
            {urgent ? (
              <View style={styles.urgent}>
                <Text style={styles.urgentText} maxFontSizeMultiplier={MAX_FONT_SCALE}>
                  urgent
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}
        {failure}
      </View>
    );
  }

  // A transfer, or anything newer: no payload dump - raw DB keys are not
  // something a business owner can act on.
  return (
    <View style={[styles.actionRow, divided && styles.divided]}>
      {head}
      {failure}
    </View>
  );
}

/**
 * Texting the caller back.
 *
 * The templates are the point, not decoration. This screen is used one-handed,
 * usually while doing something else, and the three things a business actually
 * sends after a missed call are always the same three - so typing is the
 * fallback, not the default.
 *
 * The text goes out from the line the caller rang, so their reply comes back to
 * the business rather than to whoever's phone happened to be nearest.
 */
const TEMPLATES = [
  "Hi, sorry we missed you - what can we help with?",
  "Thanks for calling. We'll get back to you shortly.",
  'Hi, we got your message and are looking into it now.',
] as const;

function TextBackSheet({
  visible,
  callId,
  to,
  onClose,
  onSent,
}: {
  visible: boolean;
  callId: string;
  to: string;
  onClose: () => void;
  /** The text went out; the detail says so. */
  onSent: (message: string) => void;
}) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (visible) setState(null);
  }, [visible]);

  async function send() {
    setBusy(true);
    setState(null);
    const text = message.trim();
    try {
      await api.textBack(callId, text);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setMessage('');
      onSent(text);
    } catch (err) {
      setState({ ok: false, message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  // A tapped template is one tap to bring back; typed words are not.
  function requestClose() {
    const typed = message.trim();
    if (!typed || TEMPLATES.some((t) => t === typed)) return onClose();
    Alert.alert('Discard this text?', 'It has not been sent.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: onClose },
    ]);
  }

  return (
    <Sheet
      visible={visible}
      title={`Text ${formatPhone(to)}`}
      onClose={requestClose}
      footer={
        <SaveBar
          onSave={send}
          busy={busy}
          dirty={message.trim().length > 0}
          state={state}
          label="Send text"
        />
      }
    >
      <View style={styles.templates}>
        {TEMPLATES.map((t) => {
          const on = message === t;
          return (
            <Pressable
              key={t}
              onPress={() => {
                setMessage(t);
                void Haptics.selectionAsync();
              }}
              accessibilityRole="button"
              accessibilityLabel={t}
              accessibilityState={{ selected: on }}
              android_ripple={ripple}
              style={({ pressed: down }) => [
                styles.template,
                on && styles.templateOn,
                down && pressed,
              ]}
            >
              <Text style={[styles.templateText, on && styles.templateTextOn]}>{t}</Text>
            </Pressable>
          );
        })}
      </View>
      <TextField
        label="Message"
        value={message}
        onChangeText={setMessage}
        placeholder="Type a reply..."
        multiline
        maxLength={300}
        hint="Sent from your receptionist's number, so replies come back to your line."
      />
    </Sheet>
  );
}

/**
 * Reporting a bad call.
 *
 * The server snapshots the transcript alongside the message, because a report
 * that just says "it got the price wrong" is not actionable once the call row
 * has been re-summarised. That is worth saying here so nobody "simplifies" the
 * payload later.
 */
function ReportSheet({
  visible,
  callId,
  onClose,
  onSent,
}: {
  visible: boolean;
  callId: string;
  onClose: () => void;
  /** Reporting is one-shot: the link is replaced by a thank-you once sent. */
  onSent: () => void;
}) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (visible) setState(null);
  }, [visible]);

  async function send() {
    setBusy(true);
    setState(null);
    try {
      await api.reportCall(callId, message.trim());
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setMessage('');
      onSent();
    } catch (err) {
      setState({ ok: false, message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  function requestClose() {
    if (!message.trim()) return onClose();
    Alert.alert('Discard this report?', 'It has not been sent.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: onClose },
    ]);
  }

  return (
    <Sheet
      visible={visible}
      title="Report an issue"
      onClose={requestClose}
      footer={
        <SaveBar
          onSave={send}
          busy={busy}
          dirty={message.trim().length > 0}
          state={state}
          label="Send report"
        />
      }
    >
      <TextField
        label="What went wrong on this call?"
        value={message}
        onChangeText={setMessage}
        placeholder="e.g. The name was misheard and the wrong time was booked"
        multiline
        maxLength={2000}
        hint="The transcript is sent with this so we can see exactly what happened."
      />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.md },
  staleWrap: { paddingTop: spacing.md },
  off: { opacity: 0.5 },
  dim: { opacity: 0.7 },

  // One step above the native title, so the two do not stack as equals.
  headline: { ...type.heading },
  meta: { ...type.caption, marginTop: spacing.xs, fontVariant: ['tabular-nums'] },
  badges: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    marginTop: spacing.md,
  },
  noticeGap: { marginTop: spacing.md },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  iconAction: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    minHeight: control.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xs,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSubtle,
    overflow: 'hidden',
  },
  // Ink on the grey fill: textSecondary there is under 4.5:1.
  iconActionLabel: { ...type.caption, fontFamily: fonts.medium, color: colors.ink, textAlign: 'center' },
  withheld: { ...type.caption, marginTop: spacing.sm, textAlign: 'center' },

  summary: { ...type.body },
  placeholder: { ...type.bodySm, color: colors.textSecondary },
  bodySecondary: { ...type.bodySm, color: colors.textSecondary },
  claims: { gap: 6, marginTop: spacing.sm },
  reviewButton: { marginTop: spacing.md },

  transcriptActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  liveMark: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  liveMarkText: { ...type.label, color: colors.warningText },

  turns: { gap: spacing.lg },
  turn: { maxWidth: '85%', gap: spacing.xs },
  turnLeft: { alignSelf: 'flex-start', alignItems: 'flex-start' },
  turnRight: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  turnMeta: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  turnMetaRight: { justifyContent: 'flex-end' },
  turnSpeaker: { ...type.micro },
  turnAt: { ...type.caption, fontVariant: ['tabular-nums'] },
  bubble: {
    paddingHorizontal: 14,
    paddingVertical: spacing.sm,
  },
  bubbleCaller: { ...shape.bubbleLeft, backgroundColor: colors.ink },
  bubbleAgent: {
    ...shape.bubbleRight,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  bubbleText: { ...type.bodySm },
  bubbleTextCaller: { color: colors.white },

  actionRow: { paddingVertical: spacing.md, gap: 2 },
  openDay: { flexDirection: 'row', alignItems: 'center', gap: 2, marginTop: spacing.xs },
  openDayText: { ...type.footnote, fontFamily: fonts.medium, color: colors.ink },
  divided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  actionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  actionType: { ...type.bodySm, fontFamily: fonts.medium, flexShrink: 1 },
  actionTitle: { ...type.bodySm },
  actionWhen: { ...type.caption, fontVariant: ['tabular-nums'] },
  actionMeta: { ...type.caption },
  actionFailed: { ...type.caption, color: colors.errorText, marginTop: 2 },
  messageMeta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  callbackLink: {
    ...type.caption,
    fontFamily: fonts.medium,
    color: colors.ink,
    textDecorationLine: 'underline',
  },
  urgent: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: radius.pill,
    backgroundColor: colors.errorSoft,
  },
  urgentText: { ...type.micro, color: colors.errorText },

  report: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: control.md,
    paddingVertical: spacing.md,
  },
  reportText: { ...type.bodySm, fontFamily: fonts.medium, color: colors.textSecondary },
  reportSent: { alignSelf: 'center' },

  skeletonHead: { gap: spacing.sm },
  skeletonBadges: { flexDirection: 'row', gap: 6, marginTop: spacing.xs },

  templates: { gap: spacing.sm, marginBottom: spacing.lg },
  template: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
  },
  templateOn: { borderColor: colors.ink, backgroundColor: colors.surfaceSubtle },
  templateText: { ...type.bodySm, color: colors.textSecondary },
  templateTextOn: { fontFamily: fonts.medium, color: colors.text },
});
