import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
  type DimensionValue,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { Avatar } from '@/components/avatar';
import { Icon, type IconName } from '@/components/Icon';
import {
  colors,
  control,
  fonts,
  MAX_FONT_SCALE,
  radius,
  shape,
  spacing,
  type,
} from '@/constants/theme';
import type { StatusBucket } from '@/lib/format';
import type { Mood } from '@/lib/personality';

/**
 * The shared visual layer. Screens compose these instead of hand-rolling a
 * card, a button or a chip, so the app speaks the web dashboard's language in
 * one place: flat asymmetric cards, Inter, contrast-safe text, and controls
 * that grow with Dynamic Type (`minHeight`, never `height`).
 *
 * Accessibility rule for everything here: an icon is decorative (`<Icon/>`
 * without a label), and every pressable sets its own `accessibilityLabel`.
 * iOS otherwise builds the label by joining the children's text, which is how
 * a private-use icon glyph ended up being read aloud.
 */

/** Icon sizes, one per job: a trailing chevron, a leading row icon, a header or button icon. */
export const ICON = { chevron: 16, row: 18, action: 20 } as const;

/** The pressed look every pressable shares, and its Android ripple. */
export const pressed = { opacity: 0.7 } as const;
export const ripple = { color: colors.hairline, foreground: true } as const;

/** The card surface on its own, for the few places that cannot be a `Card` (a Pressable row card). */
export const cardStyle = {
  backgroundColor: colors.surface,
  ...shape.card,
  borderWidth: 1,
  borderColor: colors.hairline,
} as const;

/** The dashboard's `.shape-card glass`: white, 20/20/20/4 corners, hairline outline, no shadow. */
export function Card({
  children,
  style,
  padded = true,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** False for a card whose rows run edge to edge and pad themselves. */
  padded?: boolean;
}) {
  return <View style={[styles.card, padded && styles.cardPadded, style]}>{children}</View>;
}

export function SectionCard({
  title,
  subtitle,
  action,
  children,
  style,
}: {
  title?: string;
  /** The line under the title, same role as the web SectionCard's. */
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Card style={style}>
      {(title || action) && (
        <View style={styles.sectionHead}>
          {title ? (
            <View style={styles.sectionHeadText}>
              <Text style={type.section} accessibilityRole="header">
                {title}
              </Text>
              {subtitle ? <Text style={styles.sectionSubtitle}>{subtitle}</Text> : null}
            </View>
          ) : (
            <View />
          )}
          {action}
        </View>
      )}
      {children}
    </Card>
  );
}

/**
 * A metric tile. `alert` turns the number amber when it is a count you would
 * rather were zero (missed calls) - matching the web overview's `Tile`. One
 * VoiceOver stop reads "Missed: 2" rather than two stops for the parts.
 */
export function StatTile({
  label,
  value,
  alert,
  onPress,
  style,
}: {
  label: string;
  value: number | string;
  alert?: boolean;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const warn = alert && typeof value === 'number' && value > 0;
  const a11yLabel = `${label}: ${value}`;
  const body = (
    <>
      <View style={styles.tileHead}>
        <Text style={[styles.tileLabel, styles.flex]} numberOfLines={1}>
          {label}
        </Text>
        {/* The one tile that goes somewhere says so. */}
        {onPress ? <Icon name="chevron-forward" size={14} color={colors.textMuted} /> : null}
      </View>
      <Text style={[styles.tileValue, warn && { color: colors.tileWarn }]}>{value}</Text>
    </>
  );
  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={a11yLabel}
        accessibilityHint="Opens these calls"
        android_ripple={ripple}
        style={({ pressed }) => [styles.card, styles.tile, pressed && styles.pressed, style]}
      >
        {body}
      </Pressable>
    );
  }
  return (
    <View style={[styles.card, styles.tile, style]} accessible accessibilityLabel={a11yLabel}>
      {body}
    </View>
  );
}

export function Dot({ color, size = 8 }: { color: string; size?: number }) {
  return (
    <View
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }}
    />
  );
}

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'error' | 'live';

const BADGE_TONES: Record<BadgeTone, { bg: string; border: string; fg: string }> = {
  // inkSoft, not textSecondary: grey on the grey fill is 4.35:1 and fails.
  neutral: { bg: colors.surfaceSubtle, border: colors.borderStrong, fg: colors.inkSoft },
  success: { bg: colors.successSoft, border: colors.successBorder, fg: colors.successText },
  warning: { bg: colors.warningSoft, border: colors.warningBorder, fg: colors.warningText },
  error: { bg: colors.errorSoft, border: colors.errorBorder, fg: colors.errorText },
  live: { bg: colors.warningSoft, border: colors.live, fg: colors.warningText },
};

/** The web's `PILL_BASE`: `.shape-pill`, a 1px tinted border, the -700 text shade. */
export function Badge({ label, tone = 'neutral' }: { label: string; tone?: BadgeTone }) {
  const t = BADGE_TONES[tone];
  return (
    <View style={[styles.badge, { backgroundColor: t.bg, borderColor: t.border }]}>
      {tone === 'live' ? <Dot color={colors.live} size={6} /> : null}
      <Text style={[styles.badgeText, { color: t.fg }]} maxFontSizeMultiplier={MAX_FONT_SCALE}>
        {label}
      </Text>
    </View>
  );
}

export type ButtonSize = 'lg' | 'md' | 'pill';
export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

/**
 * The one button. `lg` is the funnel's `.onb-cta` (52pt, radius 14), `md` the
 * default in-screen action (44pt, radius 12), `pill` the compact inline action
 * (40pt, fully round, like the web status band's buttons).
 */
export function Button({
  label,
  onPress,
  size = 'md',
  variant = 'primary',
  icon,
  iconPosition = 'left',
  busy,
  disabled,
  style,
  accessibilityLabel,
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  size?: ButtonSize;
  variant?: ButtonVariant;
  icon?: IconName;
  iconPosition?: 'left' | 'right';
  busy?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  /** When the visible word is too short to stand alone ("Remove" -> "Remove iPhone 15"). */
  accessibilityLabel?: string;
  accessibilityHint?: string;
}) {
  const off = Boolean(disabled || busy);
  const fg =
    variant === 'primary' ? colors.white : variant === 'danger' ? colors.errorText : colors.ink;
  const iconEl = icon ? <Icon name={icon} size={size === 'pill' ? 15 : 16} color={fg} /> : null;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: off, busy: Boolean(busy) }}
      hitSlop={size === 'pill' ? { top: 4, bottom: 4 } : undefined}
      android_ripple={ripple}
      style={({ pressed }) => [
        styles.button,
        BUTTON_SIZES[size],
        BUTTON_VARIANTS[variant],
        pressed && !off && styles.pressed,
        disabled && !busy && styles.buttonOff,
        style,
      ]}
    >
      {/* The content keeps its width while busy (only hidden), so the button
          does not collapse to the spinner's width and jump the layout. */}
      <View style={[styles.buttonContent, busy && styles.hidden]}>
        {iconPosition === 'left' && iconEl}
        <Text
          style={[size === 'pill' ? styles.buttonTextPill : styles.buttonText, { color: fg }]}
        >
          {label}
        </Text>
        {iconPosition === 'right' && iconEl}
      </View>
      {busy ? (
        <View style={styles.buttonSpinner}>
          <ActivityIndicator size="small" color={fg} />
        </View>
      ) : null}
    </Pressable>
  );
}

/**
 * A single filter or choice chip - the calls filters, the funnel's options,
 * ChipGroup and StepPicker all render this one.
 */
export function Chip({
  label,
  selected,
  onPress,
  count,
  disabled,
  style,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  count?: number;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const fg = selected ? colors.white : colors.inkSoft;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={count != null ? `${label}, ${count}` : label}
      accessibilityState={{ selected, disabled: Boolean(disabled) }}
      hitSlop={{ top: 4, bottom: 4 }}
      android_ripple={ripple}
      style={({ pressed }) => [
        styles.chip,
        selected && styles.chipSelected,
        pressed && !disabled && styles.pressed,
        disabled && styles.buttonOff,
        style,
      ]}
    >
      <Text style={[styles.chipText, { color: fg }]} maxFontSizeMultiplier={MAX_FONT_SCALE}>
        {label}
      </Text>
      {count != null ? (
        <Text
          style={[styles.chipCount, { color: selected ? colors.white : colors.textSecondary }]}
          maxFontSizeMultiplier={MAX_FONT_SCALE}
        >
          {count}
        </Text>
      ) : null}
    </Pressable>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  /** A short count or tag after the label, e.g. "3". */
  badge?: string;
  accessibilityLabel?: string;
  /** Greyed out and not selectable, e.g. a billing cycle the store cannot sell. */
  disabled?: boolean;
}

/** A pill track with one active segment - the Home range switch, the billing cycle toggle. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  style,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.segmented, style]} accessibilityRole="radiogroup">
      {options.map((o) => {
        const checked = o.value === value;
        const fg = checked ? colors.white : colors.inkSoft;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            disabled={o.disabled}
            accessibilityRole="radio"
            accessibilityState={{ checked, disabled: Boolean(o.disabled) }}
            accessibilityLabel={o.accessibilityLabel ?? (o.badge ? `${o.label}, ${o.badge}` : o.label)}
            hitSlop={{ top: 4, bottom: 4 }}
            style={[styles.segment, checked && styles.segmentActive, o.disabled && styles.buttonOff]}
          >
            <Text
              style={[styles.segmentText, { color: fg }]}
              numberOfLines={1}
              maxFontSizeMultiplier={MAX_FONT_SCALE}
            >
              {o.label}
            </Text>
            {o.badge ? (
              <Text
                // An unchecked segment sits on the surfaceSubtle track, where
                // textSecondary is only 4.35:1; inkSoft clears AA.
                style={[styles.segmentBadge, { color: checked ? colors.white : colors.inkSoft }]}
                maxFontSizeMultiplier={MAX_FONT_SCALE}
              >
                {o.badge}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Nothing to show yet. With `mood`, the receptionist's own face stands in for
 * the grey icon circle - it is the same character the setup funnel introduced.
 */
export function EmptyState({
  icon,
  mood,
  title,
  body,
  children,
}: {
  icon?: IconName;
  mood?: Mood;
  title: string;
  body?: string;
  children?: ReactNode;
}) {
  return (
    <View style={styles.empty}>
      {mood ? (
        // Decorative here: the title says what the screen is about, and the
        // avatar's own "Your AI receptionist, image" would be a wasted stop.
        <View
          style={styles.emptyAvatar}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Avatar mood={mood} size={72} />
        </View>
      ) : icon ? (
        <View style={styles.emptyIcon}>
          <Icon name={icon} size={22} color={colors.textSecondary} />
        </View>
      ) : null}
      <Text style={styles.emptyTitle} accessibilityRole="header">
        {title}
      </Text>
      {body ? <Text style={styles.emptyBody}>{body}</Text> : null}
      {children}
    </View>
  );
}

/**
 * A refetch failed while the screen still holds a good payload.
 *
 * The alternative - the pattern this replaces - was `if (error || !data)
 * <ErrorState/>`, which throws the payload away. Every screen refetches when it
 * comes forward, when the app foregrounds, and (on a live call) every five
 * seconds, so one lost packet in a lift unmounted a transcript someone was
 * reading and stopped the audio playing under it. `ErrorState` is for a screen
 * that has nothing to show; this is for a screen that has something slightly
 * old, and it says so without taking it away.
 */
export function StaleNotice({
  message,
  onRetry,
  firstLoad,
}: {
  message: string;
  onRetry?: () => void;
  /** Nothing was ever shown (the funnel's first load), so "the last update" would be a lie. */
  firstLoad?: boolean;
}) {
  return (
    <View style={styles.stale} accessibilityLiveRegion="polite">
      <Icon name="cloud-offline-outline" size={14} color={colors.inkSoft} />
      <Text style={styles.staleText} numberOfLines={2}>
        {message}
        {firstLoad ? '' : ' Showing the last update.'}
      </Text>
      {onRetry ? (
        // A padded 44pt box rather than hitSlop, so the VoiceOver frame grows too.
        <Pressable
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel="Retry"
          android_ripple={ripple}
          style={({ pressed }) => [styles.staleRetryHit, pressed && styles.pressed]}
        >
          <Text style={styles.staleRetry}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Full-screen failure with a way out. Never a dead end. */
export function ErrorState({
  message,
  onRetry,
  title = 'Could not load',
  retryLabel = 'Try again',
}: {
  message: string;
  onRetry: () => void;
  title?: string;
  retryLabel?: string;
}) {
  return (
    <View style={styles.empty}>
      <View style={[styles.emptyIcon, { backgroundColor: colors.errorSoft }]}>
        <Icon name="cloud-offline-outline" size={22} color={colors.errorText} />
      </View>
      <Text style={styles.emptyTitle} accessibilityRole="header">
        {title}
      </Text>
      <Text style={styles.emptyBody}>{message}</Text>
      <Button label={retryLabel} onPress={onRetry} variant="secondary" style={styles.emptyAction} />
    </View>
  );
}

/**
 * The thing is gone (a 404), so retrying would only fail again - this offers a
 * way somewhere else instead of a Try again.
 */
export function NotFoundState({
  title,
  body,
  actionLabel,
  onAction,
}: {
  title: string;
  body?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Icon name="help-circle-outline" size={22} color={colors.textSecondary} />
      </View>
      <Text style={styles.emptyTitle} accessibilityRole="header">
        {title}
      </Text>
      {body ? <Text style={styles.emptyBody}>{body}</Text> : null}
      {actionLabel && onAction ? (
        <Button label={actionLabel} onPress={onAction} variant="secondary" style={styles.emptyAction} />
      ) : null}
    </View>
  );
}

export function Loading() {
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={colors.textSecondary} accessibilityLabel="Loading" />
    </View>
  );
}

/** True while iOS Reduce Motion / Android "remove animations" is on. */
export function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((on) => {
      if (alive) setReduce(on);
    });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return reduce;
}

/**
 * A placeholder block in the shape of what is loading. Pulses on the native
 * driver; holds still under Reduce Motion. Hidden from screen readers - the
 * groups below announce "Loading" once instead of every bar.
 */
export function Skeleton({
  width = '100%',
  height,
  radius: r = radius.sm,
  style,
}: {
  width?: DimensionValue;
  height: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const reduceMotion = useReduceMotion();
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (reduceMotion) {
      pulse.setValue(0.7);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.4, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, reduceMotion]);
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.skeleton, { width, height, borderRadius: r, opacity: pulse }, style]}
    />
  );
}

/** List rows while a list loads: a leading disc and two lines, like a call row. */
export function SkeletonRows({ count, height = 56 }: { count: number; height?: number }) {
  return (
    <View accessible accessibilityLabel="Loading">
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={[styles.skeletonRow, { minHeight: height }, i > 0 && styles.divided]}>
          <Skeleton width={36} height={36} radius={18} />
          <View style={styles.skeletonLines}>
            <Skeleton width="60%" height={12} />
            <Skeleton width="35%" height={10} />
          </View>
        </View>
      ))}
    </View>
  );
}

const SKELETON_LINE_WIDTHS: DimensionValue[] = ['92%', '78%', '85%', '64%'];

/** A card-shaped placeholder: a title bar and `lines` of text. */
export function SkeletonCard({ lines = 3, style }: { lines?: number; style?: StyleProp<ViewStyle> }) {
  return (
    <Card style={style}>
      <View accessible accessibilityLabel="Loading" style={styles.skeletonLines}>
        <Skeleton width="40%" height={14} style={styles.skeletonTitle} />
        {Array.from({ length: lines }, (_, i) => (
          <Skeleton key={i} width={SKELETON_LINE_WIDTHS[i % SKELETON_LINE_WIDTHS.length]} height={10} />
        ))}
      </View>
    </Card>
  );
}

/** A form while it loads: `fields` label-plus-input blocks, the height of a TextField. */
export function SkeletonForm({ fields = 4 }: { fields?: number }) {
  return (
    <View accessible accessibilityLabel="Loading">
      {Array.from({ length: fields }, (_, i) => (
        <View key={i} style={styles.skeletonField}>
          <Skeleton width={SKELETON_LINE_WIDTHS[(i + 3) % SKELETON_LINE_WIDTHS.length]} height={12} />
          <Skeleton height={48} radius={radius.md} />
        </View>
      ))}
    </View>
  );
}

/**
 * The amber live dot, breathing. One copy for the Home banner, the Calls list,
 * the call detail and Activity; still under Reduce Motion, like the skeletons.
 */
export function LiveDot({ size = 10 }: { size?: number }) {
  const reduceMotion = useReduceMotion();
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (reduceMotion) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.35, duration: 800, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 800, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, reduceMotion]);
  return (
    <Animated.View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: colors.live,
        opacity: pulse,
      }}
    />
  );
}

export type NoticeTone = 'neutral' | 'success' | 'warning' | 'error';

const NOTICE_TONES: Record<NoticeTone, { bg: string; border: string; fg: string; icon: IconName }> = {
  // inkSoft on the grey fill: textSecondary there is 4.35:1 and fails.
  neutral: { bg: colors.surfaceSubtle, border: colors.border, fg: colors.inkSoft, icon: 'information-circle-outline' },
  success: { bg: colors.successSoft, border: colors.successBorder, fg: colors.successText, icon: 'checkmark-circle' },
  warning: { bg: colors.warningSoft, border: colors.warningBorder, fg: colors.warningText, icon: 'warning-outline' },
  error: { bg: colors.errorSoft, border: colors.errorBorder, fg: colors.errorText, icon: 'alert-circle-outline' },
};

/**
 * The one tinted callout: a soft fill, a 1px tinted border, the readable
 * shade of the tone for the words. A string child becomes the body text; any
 * other child is rendered as given. `action` sits under the text.
 */
export function Notice({
  tone = 'neutral',
  title,
  children,
  icon,
  action,
  live,
  style,
}: {
  tone?: NoticeTone;
  title?: string;
  children?: ReactNode;
  /** A different leading icon, or `null` for none. */
  icon?: IconName | null;
  action?: ReactNode;
  /** Announce changes to the text (a result that arrives after a tap). */
  live?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const t = NOTICE_TONES[tone];
  return (
    <View
      style={[styles.notice, { backgroundColor: t.bg, borderColor: t.border }, style]}
      accessibilityLiveRegion={live ? 'polite' : undefined}
    >
      <View style={styles.noticeRow}>
        {icon === null ? null : (
          <Icon name={icon ?? t.icon} size={16} color={t.fg} style={styles.noticeIcon} />
        )}
        <View style={styles.flex}>
          {title ? <Text style={[styles.noticeTitle, { color: t.fg }]}>{title}</Text> : null}
          {typeof children === 'string' ? (
            <Text style={[styles.noticeText, { color: t.fg }]}>{children}</Text>
          ) : (
            children
          )}
        </View>
      </View>
      {action ? <View style={styles.noticeAction}>{action}</View> : null}
    </View>
  );
}

/**
 * A round icon-only button with its own spoken label. `subtle` is the grey
 * disc (the Home bell, copy, play); `plain` has no fill (a sheet's close);
 * `ink` is filled, for a state that is on (a sample playing).
 */
export function IconButton({
  icon,
  label,
  onPress,
  tone = 'subtle',
  size = control.md,
  disabled,
  accessibilityHint,
  style,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  tone?: 'subtle' | 'plain' | 'ink';
  size?: number;
  disabled?: boolean;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: Boolean(disabled) }}
      android_ripple={{ ...ripple, borderless: true }}
      style={({ pressed }) => [
        styles.iconButton,
        { width: size, height: size, borderRadius: size / 2 },
        tone === 'subtle' && styles.iconButtonSubtle,
        tone === 'ink' && styles.iconButtonInk,
        pressed && !disabled && styles.pressed,
        disabled && styles.buttonOff,
        style,
      ]}
    >
      <Icon name={icon} size={ICON.action} color={tone === 'ink' ? colors.white : colors.ink} />
    </Pressable>
  );
}

/**
 * A text-only action: "View all", "Show original", "Use a different email".
 * One type spec, a 44pt target. `compact` folds the target into a 20pt line
 * (a card heading's trailing action) so the row does not grow around it.
 */
export function TextLink({
  label,
  onPress,
  tone = 'ink',
  role = 'button',
  compact,
  disabled,
  accessibilityLabel,
  accessibilityHint,
  style,
}: {
  label: string;
  onPress: () => void;
  tone?: 'ink' | 'secondary';
  role?: 'button' | 'link';
  compact?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole={role}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: Boolean(disabled) }}
      hitSlop={{ left: 8, right: 8 }}
      android_ripple={{ ...ripple, borderless: true }}
      style={({ pressed }) => [
        styles.textLink,
        compact && styles.textLinkCompact,
        pressed && !disabled && styles.pressed,
        disabled && styles.buttonOff,
        style,
      ]}
    >
      <Text
        style={[styles.textLinkLabel, tone === 'secondary' && styles.textLinkSecondary]}
        maxFontSizeMultiplier={MAX_FONT_SCALE}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * What each outcome looks like in a call list.
 *
 * The icon says what the call produced - `outcome` is the one field somebody
 * scans a call log FOR. Colour stays on the three semantic ones the palette
 * allows, in their readable shades; the rest are ink, because "a message was
 * taken" is information, not news.
 */
const OUTCOME_LOOK: Record<string, { icon: IconName; tint: string }> = {
  booked: { icon: 'calendar', tint: colors.successText },
  message: { icon: 'chatbox-ellipses-outline', tint: colors.inkSoft },
  transferred: { icon: 'swap-horizontal', tint: colors.warningText },
  resolved: { icon: 'checkmark-circle-outline', tint: colors.inkSoft },
  abandoned: { icon: 'close-circle-outline', tint: colors.errorText },
};

const MISSED_LOOK = { icon: 'call-outline' as IconName, tint: colors.errorText };

/**
 * One call in a list - Home's recent calls, the Calls tab and Activity all
 * draw this. The outcome leads (icon and headline); the caller is the second
 * line. `unread` marks a row newer than the last visit; `divided` draws the
 * hairline above it.
 */
export function CallRow({
  headline,
  caller,
  meta,
  when,
  bucket,
  outcome,
  flagged,
  unread,
  divided,
  onPress,
  accessibilityLabel,
  accessibilityHint = 'Opens the call',
}: {
  headline: string;
  caller: string;
  /** After the caller, e.g. the duration. */
  meta?: string;
  when: string;
  bucket: StatusBucket;
  outcome: string | null;
  flagged?: boolean;
  unread?: boolean;
  divided?: boolean;
  /** Absent for a row with no detail behind it. */
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}) {
  const look =
    bucket === 'unanswered' ? MISSED_LOOK : (OUTCOME_LOOK[outcome ?? ''] ?? OUTCOME_LOOK.resolved);
  const label =
    accessibilityLabel ??
    `${unread ? 'New. ' : ''}${headline}. ${caller}${meta ? `, ${meta}` : ''}, ${when}${
      flagged ? ', flagged for review' : ''
    }`;
  const body = (
    <>
      <View style={[styles.callIcon, bucket === 'active' && styles.callIconLive]}>
        {bucket === 'active' ? <LiveDot /> : <Icon name={look.icon} size={ICON.chevron} color={look.tint} />}
      </View>
      <View style={styles.flex}>
        <View style={styles.callTitleRow}>
          <Text style={styles.callTitle} numberOfLines={1}>
            {headline}
          </Text>
          {unread ? <Dot color={colors.ink} size={6} /> : null}
        </View>
        <View style={styles.callMetaRow}>
          <Text style={styles.callMeta} numberOfLines={1}>
            {meta ? `${caller} · ${meta}` : caller}
          </Text>
          {flagged ? <Badge label="Review" tone="warning" /> : null}
        </View>
      </View>
      <View style={styles.callRight}>
        <Text style={styles.callWhen}>{when}</Text>
        {onPress ? <Icon name="chevron-forward" size={ICON.chevron} color={colors.textMuted} /> : null}
      </View>
    </>
  );
  if (!onPress) {
    return (
      <View style={[styles.callRow, divided && styles.divided]} accessible accessibilityLabel={label}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      android_ripple={ripple}
      style={({ pressed }) => [styles.callRow, divided && styles.divided, pressed && styles.pressed]}
    >
      {body}
    </Pressable>
  );
}

/**
 * A label/value row, as used across Settings and the call detail. One
 * VoiceOver stop reads "Duration, 2m 10s".
 */
export function Row({
  label,
  value,
  valueStyle,
  onPress,
}: {
  label: string;
  value: string;
  valueStyle?: StyleProp<TextStyle>;
  onPress?: () => void;
}) {
  const a11yLabel = `${label}, ${value}`;
  const body = (
    <>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, valueStyle]} numberOfLines={1}>
        {value}
      </Text>
    </>
  );
  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={a11yLabel}
        android_ripple={ripple}
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      >
        {body}
      </Pressable>
    );
  }
  return (
    <View style={styles.row} accessible accessibilityLabel={a11yLabel}>
      {body}
    </View>
  );
}

/**
 * The settings / navigation row: an icon, a label with an optional value under
 * it, and a trailing chevron (opens a screen) or external mark (leaves the app).
 */
export function ListRow({
  icon,
  label,
  value,
  onPress,
  divided,
  destructive,
  trailing = 'chevron',
  busy,
  disabled,
  accessibilityHint,
}: {
  icon?: IconName;
  label: string;
  value?: string;
  onPress: () => void;
  divided?: boolean;
  destructive?: boolean;
  trailing?: 'chevron' | 'external' | 'none';
  busy?: boolean;
  disabled?: boolean;
  accessibilityHint?: string;
}) {
  const off = Boolean(disabled || busy);
  const labelColor = destructive ? colors.errorText : colors.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole={trailing === 'external' ? 'link' : 'button'}
      accessibilityLabel={value ? `${label}, ${value}` : label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: off, busy: Boolean(busy) }}
      android_ripple={ripple}
      // A disabled Pressable never enters `pressed`, so a row that is waiting
      // would otherwise look idle while swallowing taps.
      style={({ pressed }) => [
        styles.listRow,
        divided && styles.divided,
        pressed && styles.pressed,
        disabled && !busy && styles.buttonOff,
      ]}
    >
      {icon ? (
        <Icon name={icon} size={ICON.row} color={destructive ? colors.errorText : colors.textSecondary} />
      ) : null}
      <View style={styles.flex}>
        <Text style={[styles.listLabel, { color: labelColor }]}>{label}</Text>
        {value ? (
          <Text style={styles.listValue} numberOfLines={1}>
            {value}
          </Text>
        ) : null}
      </View>
      {busy ? (
        <ActivityIndicator size="small" color={colors.textSecondary} />
      ) : trailing === 'chevron' ? (
        <Icon name="chevron-forward" size={ICON.chevron} color={colors.textMuted} />
      ) : trailing === 'external' ? (
        <Icon name="open-outline" size={ICON.chevron} color={colors.textMuted} />
      ) : null}
    </Pressable>
  );
}

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.divider, style]} />;
}

const BUTTON_SIZES = StyleSheet.create({
  lg: { minHeight: control.lg, borderRadius: radius.control, paddingHorizontal: spacing.xl },
  md: { minHeight: control.md, borderRadius: radius.md, paddingHorizontal: spacing.lg },
  pill: { minHeight: control.sm, borderRadius: radius.pill, paddingHorizontal: 14 },
});

const BUTTON_VARIANTS = StyleSheet.create({
  primary: { backgroundColor: colors.ink },
  secondary: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
  },
  danger: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.errorBorder },
  ghost: { backgroundColor: 'transparent' },
});

export const styles = StyleSheet.create({
  flex: { flex: 1 },
  card: cardStyle,
  cardPadded: {
    padding: 20,
  },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  sectionHeadText: { flexShrink: 1 },
  sectionSubtitle: { ...type.caption, marginTop: 2 },
  tile: {
    flex: 1,
    padding: spacing.lg,
  },
  tileHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  tileLabel: {
    ...type.caption,
    fontFamily: fonts.medium,
  },
  tileValue: {
    ...type.stat,
    marginTop: 4,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderWidth: 1,
    ...shape.pill,
  },
  badgeText: {
    ...type.caption,
    fontFamily: fonts.medium,
  },
  button: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.sm,
    // Clips the Android ripple to the rounded shape.
    overflow: 'hidden',
  },
  buttonContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  buttonSpinner: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: {
    ...type.button,
    flexShrink: 1,
    textAlign: 'center',
  },
  buttonTextPill: {
    ...type.labelLg,
    flexShrink: 1,
    textAlign: 'center',
  },
  buttonOff: {
    opacity: 0.5,
  },
  hidden: {
    opacity: 0,
  },
  pressed,
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: control.sm,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    overflow: 'hidden',
  },
  chipSelected: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { ...type.labelLg },
  chipCount: {
    ...type.caption,
    fontFamily: fonts.semibold,
    fontVariant: ['tabular-nums'],
  },
  segmented: {
    flexDirection: 'row',
    // A 44pt track so each segment clears the platform minimum on its own.
    minHeight: control.md,
    padding: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceSubtle,
  },
  segment: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  segmentActive: { backgroundColor: colors.ink },
  segmentText: { ...type.labelLg, flexShrink: 1 },
  segmentBadge: {
    ...type.caption,
    fontFamily: fonts.semibold,
    fontVariant: ['tabular-nums'],
  },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.xl,
  },
  emptyAvatar: {
    marginBottom: spacing.md,
  },
  emptyIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceSubtle,
    marginBottom: spacing.md,
  },
  emptyTitle: {
    ...type.title,
    textAlign: 'center',
  },
  emptyBody: {
    ...type.bodySm,
    marginTop: 6,
    color: colors.textSecondary,
    textAlign: 'center',
    maxWidth: 300,
  },
  emptyAction: {
    marginTop: spacing.lg,
  },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xxl,
  },
  skeleton: {
    backgroundColor: colors.border,
  },
  skeletonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  skeletonLines: {
    flex: 1,
    gap: spacing.sm,
  },
  skeletonTitle: {
    marginBottom: spacing.xs,
  },
  // A TextField: a 12pt label, 6 below it a 48pt box, 16 to the next field.
  skeletonField: { gap: 6, marginBottom: spacing.lg },
  stale: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSubtle,
  },
  staleText: {
    ...type.caption,
    flex: 1,
    color: colors.inkSoft,
  },
  // 44pt of target inside a notice that is only ~32 tall: the negative margin
  // keeps the box from growing the notice.
  staleRetryHit: {
    minHeight: control.md,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    marginVertical: -spacing.sm,
    marginRight: -spacing.sm,
  },
  staleRetry: {
    ...type.caption,
    fontFamily: fonts.semibold,
    color: colors.ink,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    // 12 above and below a 20pt line: a 44pt target when the row is pressable.
    paddingVertical: spacing.md,
    gap: spacing.lg,
  },
  rowLabel: {
    ...type.bodySm,
    color: colors.textSecondary,
  },
  rowValue: {
    ...type.bodySm,
    flexShrink: 1,
    fontFamily: fonts.medium,
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 48,
    paddingVertical: spacing.md,
  },
  listLabel: { ...type.body },
  listValue: { ...type.caption, marginTop: 2 },
  divided: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
  },
  notice: {
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  noticeRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  // Sits on the first line's centre (a 20pt line, a 16pt glyph).
  noticeIcon: { marginTop: 2 },
  noticeTitle: { ...type.bodySm, fontFamily: fonts.medium },
  noticeText: { ...type.bodySm },
  noticeAction: { marginTop: spacing.md },
  iconButton: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  iconButtonSubtle: { backgroundColor: colors.surfaceSubtle },
  iconButtonInk: { backgroundColor: colors.ink },
  textLink: {
    minHeight: control.md,
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  // A 44pt box folded into a 20pt heading line.
  textLinkCompact: { marginVertical: -spacing.md },
  textLinkLabel: { ...type.labelLg, color: colors.ink },
  textLinkSecondary: { color: colors.textSecondary },
  callRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 56,
    paddingVertical: spacing.md,
  },
  callIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceSubtle,
  },
  callIconLive: { backgroundColor: colors.warningSoft },
  callTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  callTitle: { ...type.body, fontFamily: fonts.semibold, flexShrink: 1 },
  callMetaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: 2 },
  callMeta: { ...type.caption, flexShrink: 1 },
  callRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  callWhen: { ...type.caption, fontVariant: ['tabular-nums'] },
});
