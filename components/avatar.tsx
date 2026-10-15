import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';
import Svg, {
  Circle,
  Defs,
  G,
  LinearGradient,
  Path,
  RadialGradient,
  Rect,
  Stop,
} from 'react-native-svg';

import { colors } from '@/constants/theme';
import type { Mood } from '@/lib/personality';

/**
 * The AI receptionist character, alive.
 *
 * A port of the web funnel's `AiAvatar` + `LiveAvatar`: the same monochrome head
 * and the same mouth-per-mood paths, so the face someone meets on the site is
 * the face they meet in the app. What changed is what drives it. The web version
 * tracks the cursor, which a phone does not have - here the eyes glance on their
 * own, look toward whatever was last tapped, and the mouth moves while a voice
 * preview plays, which is the interaction a phone actually affords.
 *
 * Two animation layers on purpose:
 *
 *   - The float, the nod and the success pop are transforms on a real RN `View`
 *     wrapping the whole SVG, so they run on the NATIVE driver and keep moving
 *     while JS is busy saving a step.
 *   - The blink, the gaze and the mouth are SVG element props (`scaleY`,
 *     `translateX`, `opacity`), which react-native-svg animates off the JS
 *     thread's values. They are cheap - four small nodes - and they are the only
 *     things that cannot be expressed as a view transform without splitting the
 *     face across several overlapping SVGs.
 */

/**
 * Mouth shape per mood. Filled shapes are open grins; the rest are stroked.
 * Copied verbatim from the web's `MOUTHS` - these are the character's identity.
 */
const MOUTHS: Record<Mood, { d: string; filled?: boolean }> = {
  greeting: { d: 'M42 64 Q50 71 58 64' },
  calm: { d: 'M43 65 Q50 69.5 57 65' },
  friendly: { d: 'M41 63.5 Q50 73 59 63.5' },
  confident: { d: 'M42 65.5 Q52 71 59 61.5' },
  bright: { d: 'M40 62 Q50 74 60 62 Q50 69 40 62 Z', filled: true },
  celebrate: { d: 'M39 61 Q50 77.5 61 61 Q50 71 39 61 Z', filled: true },
  // Small, focused mouth - concentrating while it reads.
  studying: { d: 'M45 65.5 Q50 67.5 55 65.5' },
};

/**
 * The talking frame. react-native-svg cannot tween a path `d`, so the preview
 * cross-fades this over the mood mouth rather than morphing between them.
 */
const TALKING = 'M41 62 Q50 76 59 62 Q50 70 41 62 Z';

const SPARKS = [
  { x: 19, y: 30, r: 2.6 },
  { x: 83, y: 36, r: 3 },
  { x: 79, y: 74, r: 2.4 },
  { x: 22, y: 72, r: 2.8 },
];

function sparkPath(x: number, y: number, r: number): string {
  return (
    `M${x} ${y - r} Q${x + r * 0.28} ${y - r * 0.28} ${x + r} ${y} ` +
    `Q${x + r * 0.28} ${y + r * 0.28} ${x} ${y + r} ` +
    `Q${x - r * 0.28} ${y + r * 0.28} ${x - r} ${y} ` +
    `Q${x - r * 0.28} ${y - r * 0.28} ${x} ${y - r} Z`
  );
}

const AnimatedG = Animated.createAnimatedComponent(G);
const AnimatedPath = Animated.createAnimatedComponent(Path);

export interface AvatarProps {
  mood: Mood;
  size?: number;
  /** Bump to make it nod - e.g. when a substep is answered. */
  nudge?: number;
  /** Bump to make it wobble backwards - e.g. when stepping back. */
  rewind?: number;
  /** Pops, sparkles, and holds the celebrate face. */
  celebrate?: boolean;
  /** Moves the mouth, for while a voice preview is playing. */
  talking?: boolean;
  /**
   * -1..1. Which way to look. The funnel feeds it the side of the last tap so
   * the character appears to follow what you are doing.
   */
  gaze?: number;
  label?: string;
  style?: ViewStyle;
}

export function Avatar({
  mood,
  size = 112,
  nudge = 0,
  rewind = 0,
  celebrate = false,
  talking = false,
  gaze = 0,
  label = 'Your AI receptionist',
  style,
}: AvatarProps) {
  /**
   * Reduce Motion.
   *
   * This face floats, blinks, glances and nods without being asked to, which is
   * exactly the kind of unprompted movement the setting exists to stop. When it
   * is on, the ambient loops (float, blink, glance) do not start - the character
   * still changes expression, still nods when you answer, and still moves its
   * mouth while a voice plays, because those are responses to something the
   * caller did and are the reason the avatar is here at all.
   */
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((on) => {
      if (alive) setReduceMotion(on);
    });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  // Native-driver layer (the wrapping View).
  const float = useRef(new Animated.Value(0)).current;
  const pop = useRef(new Animated.Value(1)).current;
  const tilt = useRef(new Animated.Value(0)).current;

  // SVG-prop layer.
  const blink = useRef(new Animated.Value(1)).current;
  const eyeX = useRef(new Animated.Value(0)).current;
  const glanceX = useRef(new Animated.Value(0)).current;
  const mouthOpen = useRef(new Animated.Value(0)).current;
  const sparkle = useRef(new Animated.Value(0)).current;

  // Idle float, for the life of the component.
  useEffect(() => {
    if (reduceMotion) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(float, {
          toValue: 1,
          duration: 2600,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(float, {
          toValue: 0,
          duration: 2600,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [float, reduceMotion]);

  // Blinking on an irregular beat - a metronome blink reads as a machine.
  useEffect(() => {
    if (reduceMotion) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(
        () => {
          if (!alive) return;
          Animated.sequence([
            Animated.timing(blink, { toValue: 0.1, duration: 70, useNativeDriver: false }),
            Animated.timing(blink, { toValue: 1, duration: 90, useNativeDriver: false }),
          ]).start(() => {
            if (alive) schedule();
          });
        },
        2200 + Math.random() * 2600,
      );
    };
    schedule();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [blink, reduceMotion]);

  // Idle glances, suspended while it is reading.
  useEffect(() => {
    if (mood === 'studying' || reduceMotion) return;
    const id = setInterval(() => {
      Animated.spring(glanceX, {
        toValue: (Math.random() - 0.5) * 2,
        stiffness: 250,
        damping: 22,
        useNativeDriver: false,
      }).start();
    }, 2800);
    return () => clearInterval(id);
  }, [glanceX, mood, reduceMotion]);

  // Look toward the last tap.
  useEffect(() => {
    Animated.spring(eyeX, {
      toValue: Math.max(-1, Math.min(1, gaze)),
      stiffness: 250,
      damping: 22,
      useNativeDriver: false,
    }).start();
  }, [eyeX, gaze]);

  // Nod when a substep is answered, wobble back when one is undone. Both are
  // skipped on the first render so the avatar does not react to nothing on
  // mount.
  const firstNudge = useRef(true);
  useEffect(() => {
    if (firstNudge.current) {
      firstNudge.current = false;
      return;
    }
    Animated.sequence([
      Animated.timing(tilt, { toValue: 1, duration: 140, useNativeDriver: true }),
      Animated.spring(tilt, { toValue: 0, stiffness: 220, damping: 12, useNativeDriver: true }),
    ]).start();
  }, [nudge, tilt]);

  const firstRewind = useRef(true);
  useEffect(() => {
    if (firstRewind.current) {
      firstRewind.current = false;
      return;
    }
    Animated.sequence([
      Animated.timing(tilt, { toValue: -1, duration: 140, useNativeDriver: true }),
      Animated.spring(tilt, { toValue: 0, stiffness: 220, damping: 12, useNativeDriver: true }),
    ]).start();
  }, [rewind, tilt]);

  // The success beat: one pop, then the sparkles twinkle.
  useEffect(() => {
    if (!celebrate) {
      sparkle.setValue(0);
      return;
    }
    Animated.sequence([
      Animated.spring(pop, { toValue: 1.12, stiffness: 260, damping: 10, useNativeDriver: true }),
      Animated.spring(pop, { toValue: 1, stiffness: 260, damping: 14, useNativeDriver: true }),
    ]).start();
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(sparkle, { toValue: 1, duration: 700, useNativeDriver: false }),
        Animated.timing(sparkle, { toValue: 0.25, duration: 700, useNativeDriver: false }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [celebrate, pop, sparkle]);

  // Mouth movement while a preview plays.
  useEffect(() => {
    if (!talking) {
      Animated.timing(mouthOpen, { toValue: 0, duration: 120, useNativeDriver: false }).start();
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(mouthOpen, { toValue: 1, duration: 170, useNativeDriver: false }),
        Animated.timing(mouthOpen, { toValue: 0, duration: 170, useNativeDriver: false }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [mouthOpen, talking]);

  const mouth = MOUTHS[mood] ?? MOUTHS.friendly;

  const floatY = float.interpolate({ inputRange: [0, 1], outputRange: [0, -3.5] });
  const rotate = tilt.interpolate({
    inputRange: [-1, 0, 1],
    outputRange: ['-6deg', '0deg', '6deg'],
  });
  // Tap-following and idle glance add up, so a glance during a tap reads as one
  // continuous look rather than two competing ones.
  const pupilX = Animated.add(
    eyeX.interpolate({ inputRange: [-1, 1], outputRange: [-2.6, 2.6] }),
    glanceX.interpolate({ inputRange: [-1, 1], outputRange: [-1.6, 1.6] }),
  );
  const mouthFade = mouthOpen.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });

  return (
    <View
      style={[{ width: size, height: size }, style]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
    >
      <Animated.View
        style={[styles.fill, { transform: [{ scale: pop }, { translateY: floatY }, { rotate }] }]}
      >
        <Svg viewBox="0 0 100 100" width="100%" height="100%">
          <Defs>
            <LinearGradient id="head" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#3c3c3c" />
              <Stop offset="1" stopColor="#141414" />
            </LinearGradient>
            <RadialGradient id="sheen" cx="0.36" cy="0.28" r="0.75">
              <Stop offset="0" stopColor="#ffffff" stopOpacity="0.22" />
              <Stop offset="1" stopColor="#ffffff" stopOpacity="0" />
            </RadialGradient>
          </Defs>

          {/* Nudged up so the face sits optically centred in the viewBox. */}
          <G translateY={-4.5}>
            <Rect x="22" y="27" width="56" height="55" rx="23" fill="url(#head)" />
            <Rect x="22" y="27" width="56" height="55" rx="23" fill="url(#sheen)" />

            {/* Eyes. Scaled on Y only, so a blink squashes rather than shrinks -
                a uniform scale reads as the eyes retreating into the head.
                The squash is written as translate + scale rather than `originY`
                because react-native-svg rebuilds this group's matrix on every
                frame from ONLY the props that are Animated nodes: a plain-number
                `originY` never reaches that path, so the scale fell back to the
                user-space origin and the eyes slid up off the face for the whole
                blink. `52.5 * (1 - blink)` is exactly the offset an origin on the
                eye line would have contributed, and it is the same matrix on the
                render path and the per-frame path, so there is nothing to fight. */}
            <AnimatedG
              translateX={pupilX}
              translateY={blink.interpolate({ inputRange: [0, 1], outputRange: [52.5, 0] })}
              scaleY={blink}
            >
              <Rect x="37" y="48" width="6" height="9" rx="3" fill={colors.white} />
              <Rect x="57" y="48" width="6" height="9" rx="3" fill={colors.white} />
            </AnimatedG>

            <AnimatedPath
              d={mouth.d}
              opacity={mouthFade}
              fill={mouth.filled ? colors.white : 'none'}
              stroke={mouth.filled ? 'none' : colors.white}
              strokeWidth={4.2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <AnimatedPath d={TALKING} opacity={mouthOpen} fill={colors.white} />

            {celebrate &&
              SPARKS.map((s) => (
                <AnimatedPath
                  key={`${s.x}-${s.y}`}
                  d={sparkPath(s.x, s.y, s.r)}
                  opacity={sparkle}
                  fill={colors.ink}
                />
              ))}
          </G>
        </Svg>
      </Animated.View>
    </View>
  );
}

export type AvatarStatus = 'answering' | 'paused' | 'offline' | 'live';

/** The web sidebar's status dot: green answering, amber paused, red not set up, yellow on a call. */
const RING_STATUS: Record<AvatarStatus, { color: string; text: string }> = {
  answering: { color: colors.success, text: 'Answering calls' },
  paused: { color: colors.warning, text: 'Paused' },
  offline: { color: colors.error, text: 'Offline' },
  live: { color: colors.live, text: 'On a call now' },
};

const RING_WIDTH = 3;
const STATUS_DOT = 14;

/**
 * The avatar in the web's `.ava-ring`: a #1D1D1D -> #525252 gradient ring
 * (135deg), a white inner disc, the face at 82% of the disc, and an optional
 * status dot at the ring's bottom-right.
 *
 * With `label` it is one VoiceOver stop ("Front desk, Answering calls");
 * without one it is decoration and hidden, because the screen around it
 * already names the receptionist.
 */
export function AvatarRing({
  size = 48,
  mood,
  status,
  label,
}: {
  size?: number;
  mood: Mood;
  status?: AvatarStatus;
  label?: string;
}) {
  const c = size / 2;
  const face = (size - RING_WIDTH * 2) * 0.82;
  // Centre the dot on the circle's edge at 45 degrees rather than in the
  // bounding box's corner, which on a large ring floats off the face.
  const dotInset = Math.max(0, size / 2 - (size / 2) * Math.SQRT1_2 - STATUS_DOT / 2);
  const s = status ? RING_STATUS[status] : null;
  const a11y = label
    ? {
        accessible: true,
        accessibilityRole: 'image' as const,
        accessibilityLabel: s ? `${label}, ${s.text}` : label,
      }
    : {
        accessibilityElementsHidden: true,
        importantForAccessibility: 'no-hide-descendants' as const,
      };
  return (
    <View style={{ width: size, height: size }} {...a11y}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Defs>
          <LinearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor="#1D1D1D" />
            <Stop offset="1" stopColor="#525252" />
          </LinearGradient>
        </Defs>
        <Circle cx={c} cy={c} r={c} fill="url(#ring)" />
        <Circle cx={c} cy={c} r={c - RING_WIDTH} fill={colors.white} />
      </Svg>
      <View style={styles.ringFace}>
        <Avatar mood={mood} size={face} label={label} />
      </View>
      {s ? (
        <View
          style={[
            styles.statusDot,
            { right: dotInset, bottom: dotInset, backgroundColor: s.color },
          ]}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { width: '100%', height: '100%' },
  ringFace: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusDot: {
    position: 'absolute',
    width: STATUS_DOT,
    height: STATUS_DOT,
    borderRadius: STATUS_DOT / 2,
    borderWidth: 2,
    borderColor: colors.white,
  },
});
