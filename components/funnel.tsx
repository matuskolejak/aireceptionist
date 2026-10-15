import { useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { Avatar } from '@/components/avatar';
import { Icon } from '@/components/Icon';
import { pressed, ripple } from '@/components/ui';
import { colors, control, fonts, radius, shape, spacing, type } from '@/constants/theme';
import type { Mood } from '@/lib/personality';

/**
 * The funnel's chrome: the progress header, the question, and the action bar.
 *
 * Three problems in the first pass drove this, all of them only visible at real
 * phone size:
 *
 *   1. Two progress systems on one screen - three dots for the four steps AND a
 *      five-bar rail for step 1's substeps - so neither answered "how much is
 *      left". There is now one bar across all eight screens.
 *   2. The card floated in the middle with ~160pt of dead background under it,
 *      and the primary button floated with it, out of thumb reach.
 *   3. Back sat BELOW Next, which reads as "back is the next thing to do".
 *
 * Every step now has the same three zones: the question is pinned at the top and
 * never scrolls, the answer scrolls in the middle, and the actions are docked at
 * the bottom. Only the middle zone changes height, so the funnel never reflows
 * around the caller.
 */

/**
 * The chapters, in order, for the progress bar and the eyebrow: step 1's five
 * questions, then knowledge, appointments, the account (a guest's plan step,
 * where signing up happens) and the plan itself.
 */
export const CHAPTERS = ['The basics', 'What it knows', 'Appointments', 'Your account', 'Go live'] as const;

export function FunnelHeader({
  chapter,
  position,
  total,
  onSignIn,
  onAccount,
}: {
  chapter: string;
  /** 1-based position across the whole funnel. */
  position: number;
  total: number;
  /**
   * A guest's way into an existing account, on every screen: a returning
   * customer can realise they are in the wrong place on any of them.
   */
  onSignIn?: () => void;
  /** Signed in: who this is, and the way out (sign out, delete the account). */
  onAccount?: () => void;
}) {
  const width = useRef(new Animated.Value(position / total)).current;

  useEffect(() => {
    Animated.spring(width, {
      toValue: position / total,
      stiffness: 180,
      damping: 22,
      // A width percentage is a layout prop, so this one cannot go on the native
      // driver. It is a single 3pt bar animating for ~400ms.
      useNativeDriver: false,
    }).start();
  }, [position, total, width]);

  return (
    <View style={styles.header}>
      <View style={styles.track}>
        <Animated.View
          style={[
            styles.fill,
            {
              width: width.interpolate({
                inputRange: [0, 1],
                outputRange: ['0%', '100%'],
              }),
            },
          ]}
        />
      </View>

      <View style={styles.headerRow}>
        <Text style={styles.eyebrow} numberOfLines={1}>
          {chapter}
        </Text>
        {/* The count answers "how much longer is this", which is the question a
            funnel is always being asked silently - and it is asked loudest on
            the first screen, so it is never traded away for anything else. */}
        <Text style={styles.count} accessibilityLabel={`Step ${position} of ${total}`}>
          {position}/{total}
        </Text>
        {onSignIn ? (
          <Pressable
            onPress={onSignIn}
            accessibilityRole="button"
            accessibilityLabel="Sign in"
            style={({ pressed: down }) => [styles.headerAction, down && pressed]}
          >
            <Text style={styles.signInText}>Sign in</Text>
          </Pressable>
        ) : onAccount ? (
          <Pressable
            onPress={onAccount}
            accessibilityRole="button"
            accessibilityLabel="Account"
            style={({ pressed: down }) => [styles.headerAction, down && pressed]}
          >
            <Icon name="person-circle-outline" size={24} color={colors.ink} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/**
 * The question, as something the receptionist says.
 *
 * This is the funnel's one bold move and everything around it stays quiet. The
 * product is a thing that talks to your customers, so setting it up reads as a
 * conversation with it rather than as a settings form - and it gives the avatar
 * a job on every screen instead of decorating the top of step 1.
 *
 * The bubble is the web's own chat silhouette (`shape.bubbleLeft`): the one
 * tight corner points at the speaker, which is all a tail ever said.
 */
export function Ask({
  mood,
  name,
  question,
  sub,
  nudge,
  celebrate,
  talking,
  gaze,
}: {
  mood: Mood;
  /** The assistant's name once it has one; a role label before that. */
  name: string;
  question: string;
  sub?: string;
  nudge?: number;
  /**
   * Pops and sparkles. For the one screen in a flow that is a payoff rather
   * than a question: `mood` only changes the face, this is the beat, and
   * spending it on an ordinary question spends the ending.
   */
  celebrate?: boolean;
  talking?: boolean;
  gaze?: number;
}) {
  const label = name.trim() || 'Your receptionist';
  const enter = useRef(new Animated.Value(0)).current;

  // Re-runs on every question, so the words arrive rather than swap.
  useEffect(() => {
    enter.setValue(0);
    Animated.timing(enter, {
      toValue: 1,
      duration: 240,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [enter, question]);

  return (
    <View style={styles.ask}>
      <View style={styles.askHead}>
        {/* The name beside it says who this is; the face's own "image" stop
            would only repeat it. */}
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Avatar
            mood={mood}
            size={52}
            nudge={nudge}
            celebrate={celebrate}
            talking={talking}
            gaze={gaze}
            label={label}
          />
        </View>
        <Text style={styles.name} numberOfLines={1}>
          {label}
        </Text>
      </View>

      <Animated.View
        style={[
          styles.bubble,
          {
            opacity: enter,
            transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }],
          },
        ]}
      >
        <Text style={styles.question} accessibilityRole="header">
          {question}
        </Text>
        {sub ? <Text style={styles.sub}>{sub}</Text> : null}
      </Animated.View>
    </View>
  );
}

/**
 * A suggestion, sized to its word.
 *
 * The funnel's other selector, `Chip`, splits a row evenly between two fixed
 * options. This one wraps a variable set - names, topics - where the point is
 * that answering is one tap rather than one keyboard.
 */
export function Pill({
  label,
  active,
  onPress,
}: {
  label: string;
  active?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: Boolean(active) }}
      hitSlop={{ top: 4, bottom: 4 }}
      android_ripple={ripple}
      style={({ pressed: down }) => [styles.pill, active && styles.pillOn, down && pressed]}
    >
      <Text style={[styles.pillText, active && styles.pillTextOn]}>{label}</Text>
    </Pressable>
  );
}

export interface Action {
  label: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  /**
   * Quiet lead-in shown before `label`, for a secondary action whose question
   * and answer are one sentence: "No number to transfer to? **Skip this**". The
   * emphasis lands on the verb, which is the part that is tappable.
   */
  hint?: string;
}

/**
 * The docked action bar.
 *
 * Back is an icon on the left and Next is the wide target on the right, so the
 * reading order matches the meaning and the thumb lands on the primary action
 * one-handed. `tertiary` is the genuine third option a step sometimes has -
 * "Skip this" - under the bar; `note` is a line about the primary action
 * itself (what happens next, or why it is waiting), read out when it changes.
 */
export function Actions({
  primary,
  onBack,
  tertiary,
  note,
}: {
  primary: Action;
  onBack?: () => void;
  tertiary?: Action;
  note?: string | null;
}) {
  // Not-yet and working are different states and must not look alike: a
  // half-opacity dark slab reads as a broken button, so waiting for an answer
  // is drawn as an empty outline - the shape of the button, not yet filled -
  // and only a real press dims it.
  const waiting = Boolean(primary.disabled) && !primary.busy;

  return (
    <View style={styles.actions}>
      <View style={styles.actionRow}>
        {onBack && (
          <Pressable
            onPress={onBack}
            accessibilityRole="button"
            accessibilityLabel="Back"
            style={({ pressed: down }) => [styles.back, down && styles.backPressed]}
          >
            <Icon name="arrow-back" size={20} color={colors.ink} />
          </Pressable>
        )}
        <Pressable
          onPress={primary.onPress}
          disabled={primary.disabled || primary.busy}
          accessibilityRole="button"
          // Explicit, so iOS does not build the label from the children and
          // read the arrow glyph after the words.
          accessibilityLabel={primary.label}
          accessibilityState={{
            disabled: Boolean(primary.disabled),
            busy: Boolean(primary.busy),
          }}
          android_ripple={ripple}
          style={({ pressed: down }) => [
            styles.next,
            waiting && styles.nextWaiting,
            down && !waiting && !primary.busy && pressed,
          ]}
        >
          {/* The label never changes and the spinner takes the arrow's place,
              so the button does not resize or re-word under the thumb that is
              still resting on it. */}
          <Text style={[styles.nextText, waiting && styles.nextTextWaiting]}>
            {primary.label}
          </Text>
          <View style={styles.trail}>
            {primary.busy ? (
              <ActivityIndicator size="small" color={colors.white} />
            ) : (
              <Icon
                name="arrow-forward"
                size={17}
                color={waiting ? colors.textMuted : colors.white}
              />
            )}
          </View>
        </Pressable>
      </View>

      {note ? (
        <Text style={styles.note} accessibilityLiveRegion="polite">
          {note}
        </Text>
      ) : null}

      {tertiary && (
        <Pressable
          onPress={tertiary.onPress}
          disabled={tertiary.disabled}
          accessibilityRole="button"
          accessibilityLabel={
            tertiary.hint ? `${tertiary.hint} ${tertiary.label}` : tertiary.label
          }
          accessibilityState={{ disabled: Boolean(tertiary.disabled), busy: Boolean(tertiary.busy) }}
          style={({ pressed: down }) => [
            styles.tertiary,
            down && pressed,
            tertiary.disabled && styles.tertiaryOff,
          ]}
        >
          <Text style={styles.tertiaryText}>
            {tertiary.hint ? `${tertiary.hint} ` : ''}
            <Text style={styles.tertiaryStrong}>{tertiary.label}</Text>
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: spacing.lg },
  track: {
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.border,
    overflow: 'hidden',
  },
  fill: { height: 3, borderRadius: 2, backgroundColor: colors.ink },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    // Tall enough for the Sign in / Account target on every screen, so the
    // question does not shift when a guest signs in.
    minHeight: control.md,
  },
  eyebrow: { ...type.micro, flex: 1 },
  count: {
    ...type.micro,
    fontVariant: ['tabular-nums'],
  },
  headerAction: {
    // A real 44pt target, padded rather than hit-slopped so the VoiceOver
    // activation frame grows with it.
    minHeight: control.md,
    minWidth: control.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
    marginRight: -spacing.xs,
  },
  signInText: { ...type.label, fontFamily: fonts.semibold, textDecorationLine: 'underline' },

  ask: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  askHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  name: { ...type.label, color: colors.textSecondary },
  bubble: {
    marginTop: spacing.sm,
    backgroundColor: colors.surface,
    ...shape.bubbleLeft,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  question: { ...type.display },
  sub: { ...type.bodySm, marginTop: spacing.sm, color: colors.textSecondary },

  pill: {
    // 40pt tall, which with the row gap clears a 44pt target vertically.
    minHeight: control.sm,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  pillOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  pillText: { ...type.button, color: colors.text },
  pillTextOn: { color: colors.white },

  actions: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  back: {
    width: control.lg,
    minHeight: control.lg,
    borderRadius: radius.control,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  backPressed: { backgroundColor: colors.surfaceSubtle },
  next: {
    flex: 1,
    // A minimum, like the ui Button's lg: the label wraps rather than clips at
    // the largest text sizes.
    minHeight: control.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.control,
    backgroundColor: colors.ink,
    overflow: 'hidden',
  },
  nextWaiting: {
    // Subtle rather than white: on `surface` this button had the same fill,
    // border, radius and height as the text inputs above it and read as a
    // third empty field. The greyer ground says "control, not filled in yet".
    backgroundColor: colors.surfaceSubtle,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  nextText: { ...type.button, flexShrink: 1, textAlign: 'center', color: colors.white },
  nextTextWaiting: { color: colors.textSecondary },
  // Fixed slot for the arrow or the spinner, so swapping one for the other
  // cannot shift the label.
  trail: { width: 18, alignItems: 'center' },
  note: {
    ...type.caption,
    marginTop: spacing.sm,
    textAlign: 'center',
  },
  tertiary: {
    alignSelf: 'center',
    // 44pt of target around a 14pt line, and padding rather than hitSlop so the
    // VoiceOver activation frame grows with it.
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  tertiaryOff: { opacity: 0.5 },
  tertiaryText: { ...type.bodySm, color: colors.textSecondary },
  tertiaryStrong: {
    fontFamily: fonts.semibold,
    color: colors.text,
    textDecorationLine: 'underline',
  },
});
