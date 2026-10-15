import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/Icon';
import {
  Button,
  CallRow,
  Card,
  EmptyState,
  ErrorState,
  ICON,
  LiveDot,
  pressed,
  ripple,
  SkeletonRows,
  StaleNotice,
  TextLink,
} from '@/components/ui';
import { colors, fonts, shape, spacing, type } from '@/constants/theme';
import { api } from '@/lib/api';
import { callerLabel, callHeadline, formatDuration, relTimeOf, statusBucket } from '@/lib/format';
import { useQuery } from '@/lib/use-query';

/**
 * When this screen was last opened. Home's bell reads the same key
 * (app/(tabs)/index.tsx) to decide whether to show its unread dot.
 */
const LAST_SEEN_KEY = 'activity.lastSeenAt';

/**
 * Recent activity: calls worth a look, plus the call that is live right now -
 * the phone's version of the web's notifications bell.
 *
 * Rows are built from the raw fields (`from`, `outcome`, `status`,
 * `durationSec`) with the same formatters as Home and Calls, not from the web
 * bell's English `title`/`subtitle`, which carry a raw number and database
 * words ('No-answer · 0m 00s'). They are drawn by the same `CallRow` as Home
 * and the Calls tab, so a call looks like itself on all three.
 */
export default function NotificationsScreen() {
  const router = useRouter();
  const { data, error, loading, refreshing, refresh } = useQuery(() => api.notifications(), []);
  // Read above the early returns: they are conditional, hooks are not.
  const insets = useSafeAreaInsets();
  const seenBefore = useMarkSeen();

  if (loading) {
    return (
      <View style={[styles.root, styles.content]}>
        <Card>
          <SkeletonRows count={6} />
        </Card>
      </View>
    );
  }
  // Only a missing payload is a dead end. A failed background refetch still has
  // the last good list to show, with the notice below saying so.
  if (!data) return <ErrorState message={error ?? 'Could not load your activity.'} onRetry={refresh} />;

  const openCalls = () => router.navigate('/calls');

  return (
    <ScrollView
      style={styles.root}
      // edgeToEdgeEnabled draws behind the Android nav bar and the iOS home
      // indicator, so without the inset the last row ends up underneath it.
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={refresh}
          tintColor={colors.textSecondary}
          colors={[colors.ink]}
        />
      }
    >
      {error ? <StaleNotice message={error} onRetry={refresh} /> : null}

      {data.activeCall &&
        (data.activeCallId ? (
          <Pressable
            onPress={() => router.push(`/call/${data.activeCallId}`)}
            accessibilityRole="button"
            accessibilityLabel="Follow live call"
            accessibilityHint="Opens the live call"
            android_ripple={ripple}
            style={({ pressed: down }) => [styles.live, down && pressed]}
          >
            <LiveDot />
            <View style={styles.flex}>
              <Text style={styles.liveTitle}>Follow live call</Text>
              <Text style={styles.liveBody}>A call is happening right now.</Text>
            </View>
            <Icon name="chevron-forward" size={ICON.chevron} color={colors.white} />
          </Pressable>
        ) : (
          // An older server says a call is live without saying which one.
          <View style={styles.live} accessible>
            <LiveDot />
            <Text style={[styles.liveTitle, styles.flex]}>A call is happening right now.</Text>
          </View>
        ))}

      {data.items.length === 0 ? (
        <View style={styles.emptyWrap}>
          <EmptyState
            icon="notifications-outline"
            title="Nothing new"
            body="Calls, bookings and anything needing your attention land here."
          >
            <Button
              label="View all calls"
              variant="secondary"
              size="pill"
              onPress={openCalls}
              style={styles.emptyAction}
            />
          </EmptyState>
        </View>
      ) : (
        <Card style={styles.list}>
          {data.items.map((item, i) => {
            // `callId` is the real reference; the dashboard href is only parsed
            // for an item from a server that predates it.
            const callId = item.callId ?? callIdFrom(item.href);
            const at = Date.parse(item.at);
            const unread = seenBefore !== null && Number.isFinite(at) && at > seenBefore;
            return (
              <CallRow
                key={item.id}
                headline={callHeadline({ outcome: item.outcome, status: item.status, date: item.at })}
                caller={callerLabel(item.from)}
                meta={formatDuration(item.durationSec)}
                when={relTimeOf(item.at)}
                bucket={statusBucket(item.status, item.at)}
                outcome={item.outcome}
                unread={unread}
                divided={i > 0}
                onPress={callId ? () => router.push(`/call/${callId}`) : undefined}
              />
            );
          })}
          <View style={styles.footer}>
            <TextLink label="View all calls" role="link" onPress={openCalls} style={styles.footerLink} />
          </View>
        </Card>
      )}
    </ScrollView>
  );
}

/**
 * Marks Activity as seen each time it comes forward, and returns the PREVIOUS
 * mark (ms) so the rows that arrived since the last visit can carry a dot on
 * this one. 0 when it was never opened (everything is new, like the web bell);
 * null until read, or when storage cannot be read (no dots at all).
 *
 * The previous mark is read once per visit (mount), not per focus: coming back
 * from a call would otherwise re-read the mark this visit just wrote and clear
 * every dot the user has not opened yet.
 */
function useMarkSeen(): number | null {
  const [seenBefore, setSeenBefore] = useState<number | null>(null);
  const read = useRef(false);
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void (async () => {
        if (!read.current) {
          let previous: number | null = null;
          try {
            const raw = await AsyncStorage.getItem(LAST_SEEN_KEY);
            const t = raw ? Date.parse(raw) : 0;
            previous = Number.isFinite(t) ? t : 0;
          } catch {
            previous = null;
          }
          if (!alive) return;
          read.current = true;
          setSeenBefore(previous);
        }
        try {
          await AsyncStorage.setItem(LAST_SEEN_KEY, new Date().toISOString());
        } catch {
          // The dots come back next visit. Harmless.
        }
      })();
      return () => {
        alive = false;
      };
    }, []),
  );
  return seenBefore;
}

function callIdFrom(href: string): string | null {
  const match = /^\/dashboard\/calls\/([^/?#]+)/.exec(href ?? '');
  return match ? match[1] : null;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { flexGrow: 1, padding: spacing.lg, gap: spacing.md },
  flex: { flex: 1 },
  live: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 56,
    backgroundColor: colors.ink,
    ...shape.card,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    overflow: 'hidden',
  },
  liveTitle: { ...type.body, fontFamily: fonts.semibold, color: colors.white },
  liveBody: { ...type.caption, color: colors.textOnInk, marginTop: 1 },
  list: { paddingVertical: spacing.xs },
  footer: {
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  footerLink: { alignSelf: 'center' },
  // A whole-screen empty sits in the middle of the page, like Calls and Appointments.
  emptyWrap: { flex: 1, justifyContent: 'center' },
  emptyAction: { marginTop: spacing.lg },
});
