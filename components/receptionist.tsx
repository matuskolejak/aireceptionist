import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useState } from 'react';
import { AccessibilityInfo, Alert, Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import type { AvatarStatus } from '@/components/avatar';
import { Icon } from '@/components/Icon';
import { Card, ICON, IconButton, pressed, ripple, Skeleton, SkeletonRows } from '@/components/ui';
import { colors, fonts, spacing, type } from '@/constants/theme';
import { api } from '@/lib/api';
import { formatPhone } from '@/lib/format';
import { dial } from '@/lib/links';

/**
 * What the Receptionist tab's hub and the receptionist editor share: the
 * status words, the power switch and its optimistic override, the number it
 * answers on, the setup progress bar. One copy, so the two screens cannot
 * drift on how a receptionist is described.
 */

/**
 * The web's status copy - the same words Home uses. No number means it is not
 * in service whatever its switch says, so that wins over paused.
 */
export function statusOf(
  enabled: boolean,
  number: string,
): { text: string; ring: AvatarStatus; color: string; live: boolean } {
  if (!number) return { text: 'No phone number yet', ring: 'offline', color: colors.warningText, live: false };
  if (!enabled) return { text: 'Paused', ring: 'paused', color: colors.warningText, live: false };
  return { text: 'Answering calls', ring: 'answering', color: colors.successText, live: true };
}

/**
 * The power switch with its optimistic override. The hub never remounts (a
 * tab the navigator keeps alive), so seeding state from the prop would freeze
 * the switch at whatever it was on first render; local state is only the
 * in-flight value.
 */
export function usePower(
  assistant: { id: string; name: string; enabled: boolean },
  onChanged: () => Promise<void>,
) {
  const [pending, setPending] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  // Dropped only once the payload actually carries the value the server
  // accepted. `refresh()` swallows its own failures, so clearing the override
  // right after awaiting it would snap the switch back to the stale prop
  // whenever the follow-up refetch never landed - "Answering calls" for a
  // paused line.
  useEffect(() => {
    if (pending !== null && assistant.enabled === pending) setPending(null);
  }, [assistant.enabled, pending]);

  const toggle = useCallback(
    async (next: boolean) => {
      // Optimistic: the switch has to move under the thumb. On failure it snaps
      // back AND says why - a switch that silently springs back reads as a
      // broken switch, and the same failure on Home gets an explanation.
      setPending(next);
      setBusy(true);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      try {
        await api.setAssistantPower(assistant.id, next);
        await onChanged();
      } catch (err) {
        setPending(null);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        Alert.alert(
          next ? 'Could not resume' : 'Could not pause',
          `${assistant.name} is ${next ? 'still paused' : 'still answering'}. ${(err as Error).message}`,
        );
      } finally {
        setBusy(false);
      }
    },
    [assistant.id, assistant.name, onChanged],
  );

  return { enabled: pending ?? assistant.enabled, busy, toggle };
}

/** A Switch that is its own VoiceOver stop, never inside a Pressable. */
export function PowerSwitch({
  name,
  value,
  busy,
  onChange,
}: {
  name: string;
  value: boolean;
  busy: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <Switch
      value={value}
      onValueChange={onChange}
      disabled={busy}
      accessibilityLabel={`Answer calls for ${name}`}
      trackColor={{ true: colors.ink, false: colors.borderStrong }}
      thumbColor={colors.white}
      ios_backgroundColor={colors.borderStrong}
    />
  );
}

/** The web hero's progress: hidden once everything is done, "n/total" until then. */
export function SetupProgress({ done, total }: { done: number; total: number }) {
  return (
    <View
      style={styles.progress}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Setup progress"
      accessibilityValue={{ min: 0, max: total, now: done, text: `${done} of ${total}` }}
    >
      <View style={styles.progressHead}>
        <Text style={styles.progressLabel}>Setup progress</Text>
        <Text style={styles.progressCount}>
          {done}/{total}
        </Text>
      </View>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${Math.round((done / total) * 100)}%` }]} />
      </View>
    </View>
  );
}

/**
 * The number it answers on: tap to ring it, or copy it. Copying says so - the
 * button swaps to a tick for a moment, as the call detail's does - rather
 * than leaving a haptic to mean "done".
 */
export function NumberLine({ number }: { number: string }) {
  const pretty = formatPhone(number);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <View style={styles.numberRow}>
      <Pressable
        onPress={() => void dial(number)}
        accessibilityRole="button"
        accessibilityLabel={`Answers on ${pretty}`}
        accessibilityHint="Calls this number"
        android_ripple={ripple}
        style={({ pressed: down }) => [styles.numberMain, down && pressed]}
      >
        <View style={styles.flex}>
          <Text style={styles.numberLabel}>Answers on</Text>
          <Text style={styles.number}>{pretty}</Text>
        </View>
        <Icon name="call-outline" size={ICON.row} color={colors.ink} />
      </Pressable>
      <IconButton
        icon={copied ? 'checkmark' : 'copy-outline'}
        label={copied ? 'Copied' : 'Copy number'}
        tone={copied ? 'ink' : 'subtle'}
        onPress={async () => {
          await Clipboard.setStringAsync(number);
          setCopied(true);
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          AccessibilityInfo.announceForAccessibility('Number copied');
        }}
      />
    </View>
  );
}

/** The hero card while it loads: the avatar disc, the name and status lines, the number line. */
export function HeroSkeleton() {
  return (
    <Card>
      <View accessible accessibilityLabel="Loading">
        <View style={styles.skeletonHead}>
          <Skeleton width={56} height={56} radius={28} />
          <View style={styles.skeletonLines}>
            <Skeleton width="50%" height={16} />
            <Skeleton width="35%" height={12} />
          </View>
          <Skeleton width={51} height={31} radius={16} />
        </View>
        <View style={styles.skeletonNumber}>
          <View style={styles.skeletonLines}>
            <Skeleton width="25%" height={10} />
            <Skeleton width="55%" height={14} />
          </View>
          <Skeleton width={44} height={44} radius={22} />
        </View>
      </View>
    </Card>
  );
}

/** A rows card while it loads (the hub's links, the editor's topic lists). */
export function RowsSkeleton({ count }: { count: number }) {
  return (
    <Card style={styles.skeletonRows}>
      <SkeletonRows count={count} height={48} />
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  progress: {
    marginTop: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  progressHead: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  progressLabel: { ...type.label, color: colors.inkSoft },
  progressCount: { ...type.label, color: colors.textSecondary, fontVariant: ['tabular-nums'] },
  progressTrack: {
    marginTop: spacing.sm,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.surfaceSubtle,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', borderRadius: 3, backgroundColor: colors.ink },
  numberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  numberMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 44,
    paddingRight: spacing.sm,
  },
  numberLabel: { ...type.caption },
  number: {
    ...type.body,
    marginTop: 2,
    fontFamily: fonts.semibold,
    fontVariant: ['tabular-nums'],
  },
  skeletonHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  skeletonLines: { flex: 1, gap: spacing.sm },
  skeletonNumber: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  skeletonRows: { paddingVertical: spacing.xs },
});
