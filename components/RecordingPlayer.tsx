import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  type AccessibilityActionEvent,
  type GestureResponderEvent,
} from 'react-native';

import { Icon } from '@/components/Icon';
import { colors, control, fonts, MAX_FONT_SCALE, radius, spacing, type } from '@/constants/theme';
import { api } from '@/lib/api';
import { probeRecording, PROBE_TIMEOUT_MS } from '@/lib/recording-probe';

/**
 * Playing a call back inside the app.
 *
 * The audio is proxied through `/api/mobile/calls/[id]/recording` behind this
 * user's bearer token, so the player is handed an explicit Authorization
 * header rather than a URL - there is no signed link to open, deliberately.
 *
 * Speed control is here because of what this audio actually is: a five-minute
 * call where the useful thirty seconds are somewhere in the middle. Reviewing
 * one at 1x is the reason people stop reviewing them.
 */

const SPEEDS = [1, 1.5, 2] as const;

/** How long the player gets to load before we call the recording unplayable. */
const LOAD_TIMEOUT_MS = PROBE_TIMEOUT_MS;

/** Skip granularity. Ten seconds is about one exchange of a phone conversation. */
const SKIP_SECONDS = 10;

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function RecordingPlayer({ callId }: { callId: string }) {
  const [source, setSource] = useState<{ uri: string; headers: Record<string, string> } | null>(
    null,
  );
  // The reason the player cannot run, ready to show. Not a boolean: a call that
  // is still in progress and a recording that has aged out are both dead ends,
  // but telling someone "could not be loaded" about a call still ringing sends
  // them looking for a fault that is not there.
  const [unavailable, setUnavailable] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let probe: { cancel: () => void } | null = null;

    void (async () => {
      let next: Awaited<ReturnType<typeof api.recordingSource>>;
      try {
        next = await api.recordingSource(callId);
      } catch {
        if (alive) setUnavailable('The recording could not be loaded.');
        return;
      }
      if (!alive) return;
      if (!next) {
        setUnavailable('The recording could not be loaded.');
        return;
      }

      const pending = probeRecording(next.uri, next.headers);
      probe = pending;
      const status = await pending.status;
      if (!alive) return;

      if (status === 409) {
        setUnavailable('The recording appears once the call has ended.');
        return;
      }
      if (status === 404) {
        setUnavailable('This recording is no longer available.');
        return;
      }
      if (status < 200 || status >= 300) {
        setUnavailable('The recording could not be loaded.');
        return;
      }
      setSource(next);
    })();

    return () => {
      alive = false;
      probe?.cancel();
    };
  }, [callId]);

  // Play through the earpiece-independent route and keep going when the phone
  // is on silent: someone reviewing a call has explicitly asked to hear it, and
  // iOS otherwise honours the ring switch and plays nothing at all.
  useEffect(() => {
    void setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: false });
  }, []);

  const player = useAudioPlayer(source);
  const status = useAudioPlayerStatus(player);

  const [speedIndex, setSpeedIndex] = useState(0);
  // While a finger is on the bar, the thumb follows the finger rather than the
  // player - otherwise every status tick yanks it back to the real position.
  const [scrubTo, setScrubTo] = useState<number | null>(null);
  const [width, setWidth] = useState(0);

  const duration = status.duration || 0;
  const position = scrubTo ?? status.currentTime ?? 0;
  const progress = duration > 0 ? Math.min(1, position / duration) : 0;

  // PanResponder is memoized once and closes over whatever it captured, so
  // everything it reads at gesture time lives in a ref instead of state.
  const widthRef = useRef(0);
  const durationRef = useRef(0);
  widthRef.current = width;
  durationRef.current = duration;
  const barRef = useRef<View>(null);
  /** The bar's x in window coords, needed to turn a drag's absolute x into a position. */
  const originRef = useRef(0);
  /** Last scrub target. Read on release, because a tap produces no move event. */
  const scrubRef = useRef<number | null>(null);

  const measureBar = useCallback(() => {
    barRef.current?.measureInWindow((x) => {
      originRef.current = x;
    });
  }, []);

  const seekToX = useCallback((x: number): number => {
    const w = widthRef.current;
    const d = durationRef.current;
    if (w <= 0 || d <= 0) return 0;
    return Math.max(0, Math.min(d, (x / w) * d));
  }, []);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e: GestureResponderEvent) => {
          // locationX is correct for the initial touch; the drag below needs
          // the bar's window origin, which is measured here and on layout.
          measureBar();
          const next = seekToX(e.nativeEvent.locationX);
          scrubRef.current = next;
          setScrubTo(next);
        },
        onPanResponderMove: (_e, gesture) => {
          // Not locationX: once the finger leaves the bar's bounds it stops
          // tracking, which pins the thumb instead of letting you scrub past
          // either end.
          const next = seekToX(gesture.moveX - originRef.current);
          scrubRef.current = next;
          setScrubTo(next);
        },
        onPanResponderRelease: () => {
          const target = scrubRef.current;
          scrubRef.current = null;
          setScrubTo(null);
          if (target !== null) void player.seekTo(target);
        },
        onPanResponderTerminate: () => {
          scrubRef.current = null;
          setScrubTo(null);
        },
      }),
    [measureBar, player, seekToX],
  );

  const skip = useCallback(
    (delta: number) => {
      const target = Math.max(0, Math.min(duration || 0, (status.currentTime ?? 0) + delta));
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      void player.seekTo(target);
    },
    [duration, player, status.currentTime],
  );

  const toggle = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (status.playing) {
      player.pause();
      return;
    }
    // Replaying after the end starts from the end and looks like a dead button.
    if (duration > 0 && (status.currentTime ?? 0) >= duration - 0.25) {
      void player.seekTo(0);
    }
    player.play();
  }, [duration, player, status.currentTime, status.playing]);

  const cycleSpeed = useCallback(() => {
    const next = (speedIndex + 1) % SPEEDS.length;
    setSpeedIndex(next);
    // Pitch correction on: a 2x call without it is chipmunk audio nobody can
    // follow, which defeats the point of the control.
    player.setPlaybackRate(SPEEDS[next], 'high');
  }, [player, speedIndex]);

  // The probe above only proves the first byte exists. A connection that dies
  // mid-load leaves expo-audio unloaded and silent - there is no failure event
  // to listen for - so the spinner needs an end of its own or it spins forever.
  useEffect(() => {
    if (!source || status.isLoaded || duration > 0) return;
    const timer = setTimeout(
      () => setUnavailable('The recording could not be loaded.'),
      LOAD_TIMEOUT_MS,
    );
    return () => clearTimeout(timer);
  }, [duration, source, status.isLoaded]);

  const onScrubAction = useCallback(
    (e: AccessibilityActionEvent) => {
      // VoiceOver's swipe up / down on an adjustable element. The same ten
      // seconds as the skip buttons, so the two ways of moving agree.
      if (e.nativeEvent.actionName === 'increment') skip(SKIP_SECONDS);
      else if (e.nativeEvent.actionName === 'decrement') skip(-SKIP_SECONDS);
    },
    [skip],
  );

  if (unavailable) {
    return (
      <View style={styles.unavailableRow}>
        <Icon name="alert-circle-outline" size={16} color={colors.textSecondary} />
        <Text style={styles.unavailable}>{unavailable}</Text>
      </View>
    );
  }

  const loading = !source || (!status.isLoaded && !duration);

  return (
    <View style={styles.root}>
      <View
        ref={barRef}
        style={styles.barHit}
        onLayout={(e) => {
          setWidth(e.nativeEvent.layout.width);
          measureBar();
        }}
        // One adjustable element for VoiceOver: it reads the position as a
        // sentence and swipe up / down seeks, instead of an unlabelled strip
        // that a screen reader could neither read nor move.
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel="Playback position"
        accessibilityState={{ disabled: loading }}
        accessibilityValue={{
          min: 0,
          max: Math.max(0, Math.round(duration)),
          now: Math.round(position),
          text: duration > 0 ? `${clock(position)} of ${clock(duration)}` : clock(position),
        }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={onScrubAction}
        {...pan.panHandlers}
      >
        <View style={styles.barTrack}>
          <View style={[styles.barFill, { width: `${progress * 100}%` }]} />
        </View>
        <View style={[styles.thumb, { left: Math.max(0, progress * width - 6) }]} />
      </View>
      {/* The scrubber above already announces both times. */}
      <View
        style={styles.times}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Text style={styles.time} maxFontSizeMultiplier={MAX_FONT_SCALE}>
          {clock(position)}
        </Text>
        <Text style={styles.time} maxFontSizeMultiplier={MAX_FONT_SCALE}>
          {duration > 0 ? clock(duration) : '--:--'}
        </Text>
      </View>

      <View style={styles.controls}>
        <View style={styles.transport}>
          <SkipButton
            direction="back"
            disabled={loading}
            onPress={() => skip(-SKIP_SECONDS)}
          />
          <Pressable
            onPress={toggle}
            disabled={loading}
            accessibilityRole="button"
            accessibilityLabel={
              loading ? 'Loading recording' : status.playing ? 'Pause recording' : 'Play recording'
            }
            accessibilityState={{ disabled: loading, busy: loading }}
            style={({ pressed }) => [styles.play, pressed && styles.pressed]}
          >
            {loading ? (
              <ActivityIndicator color={colors.white} size="small" />
            ) : (
              <Icon
                name={status.playing ? 'pause' : 'play'}
                size={20}
                color={colors.white}
                // The play triangle is optically off-centre in a circle; pause is not.
                style={status.playing ? undefined : styles.playNudge}
              />
            )}
          </Pressable>
          <SkipButton
            direction="forward"
            disabled={loading}
            onPress={() => skip(SKIP_SECONDS)}
          />
        </View>

        <Pressable
          onPress={cycleSpeed}
          disabled={loading}
          accessibilityRole="button"
          accessibilityLabel={`Playback speed ${SPEEDS[speedIndex]}x`}
          accessibilityHint="Changes how fast the recording plays"
          accessibilityState={{ disabled: loading }}
          style={({ pressed }) => [styles.speed, pressed && styles.pressed, loading && styles.off]}
        >
          <Text style={styles.speedText} maxFontSizeMultiplier={MAX_FONT_SCALE}>
            {SPEEDS[speedIndex]}x
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Ten seconds either way: an arrow and the "10" it jumps, at the full 44pt. */
function SkipButton({
  direction,
  disabled,
  onPress,
}: {
  direction: 'back' | 'forward';
  disabled: boolean;
  onPress: () => void;
}) {
  const back = direction === 'back';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`${back ? 'Back' : 'Forward'} ${SKIP_SECONDS} seconds`}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.skip, pressed && styles.pressed, disabled && styles.off]}
    >
      {back ? <Icon name="play-back" size={14} color={colors.inkSoft} /> : null}
      <Text style={styles.skipText} maxFontSizeMultiplier={MAX_FONT_SCALE}>
        {SKIP_SECONDS}
      </Text>
      {back ? null : <Icon name="play-forward" size={14} color={colors.inkSoft} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.xs },
  // Taller than the visible track so the drag target is thumb-sized.
  barHit: { minHeight: control.md, justifyContent: 'center' },
  barTrack: {
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.border,
    overflow: 'hidden',
  },
  barFill: { height: 4, backgroundColor: colors.ink },
  thumb: {
    position: 'absolute',
    width: 12,
    height: 12,
    borderRadius: radius.pill,
    backgroundColor: colors.ink,
  },
  times: { flexDirection: 'row', justifyContent: 'space-between' },
  time: { ...type.caption, fontVariant: ['tabular-nums'] },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    marginTop: spacing.xs,
  },
  transport: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  play: {
    width: control.md,
    height: control.md,
    borderRadius: radius.pill,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playNudge: { marginLeft: 2 },
  skip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    minWidth: control.md,
    minHeight: control.md,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceSubtle,
  },
  // inkSoft, not textSecondary: grey on the grey fill is under 4.5:1.
  skipText: {
    ...type.caption,
    fontFamily: fonts.semibold,
    color: colors.inkSoft,
    fontVariant: ['tabular-nums'],
  },
  speed: {
    minWidth: control.md,
    minHeight: control.md,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  speedText: { ...type.label, fontFamily: fonts.semibold, color: colors.ink },
  pressed: { opacity: 0.6 },
  off: { opacity: 0.5 },
  unavailableRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  unavailable: { ...type.bodySm, flex: 1, color: colors.textSecondary },
});
