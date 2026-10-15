import * as Haptics from 'expo-haptics';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useState } from 'react';
import { Alert, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/Icon';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  ICON,
  ListRow,
  Notice,
  SkeletonCard,
  StaleNotice,
} from '@/components/ui';
import { colors, fonts, spacing, type } from '@/constants/theme';
import { api } from '@/lib/api';
import type { CalendarConnection } from '@/lib/types';
import { useQuery } from '@/lib/use-query';

/**
 * Connecting and managing calendars.
 *
 * Connecting opens a browser rather than an in-app screen: the provider's OAuth
 * consent page is theirs, and the tokens it mints have to land in a cookie
 * session on our site. At tap time the API mints ONE signed link for that
 * provider (`api.webLink({ target: 'calendar', ... })`); the consent flow ends
 * on the site's /mobile/done, which bounces back to `returnUrl` with
 * `connected=1` or `error=<slug>`, and that closes the auth session by itself.
 *
 * One connect at a time: the others are disabled while a browser session is
 * up, since only one can be presented and each link is single-use.
 */
export default function CalendarConnectionsScreen() {
  const { data, error, loading, refreshing, refresh } = useQuery(
    () => api.calendarConnections(),
    [],
  );
  /** The provider id whose connect is in flight. */
  const [connecting, setConnecting] = useState<string | null>(null);
  // Read above the early returns: they are conditional, hooks are not.
  const insets = useSafeAreaInsets();

  const connect = useCallback(
    async (provider: string, name: string) => {
      if (connecting) return;
      setConnecting(provider);
      try {
        // exp://.../--/handoff in Expo Go, aireceptionistnow://handoff in a
        // build. The server accepts only the app's own schemes here.
        const returnUrl = Linking.createURL('handoff');
        const { url } = await api.webLink({ target: 'calendar', provider, returnUrl });
        const res = await WebBrowser.openAuthSessionAsync(url, returnUrl);
        if (res.type === 'success') {
          const params = Linking.parse(res.url).queryParams ?? {};
          const failed = typeof params.error === 'string' ? params.error : '';
          if (failed) {
            Alert.alert(`Could not connect ${name}`, connectError(failed, name));
          } else if (params.connected === '1') {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }
        }
        // 'cancel' / 'dismiss': the user closed the browser. Nothing to say -
        // the refetch below shows whatever state the calendar is in now.
      } catch (err) {
        // A failed mint, or openAuthSessionAsync rejecting because a session is
        // already presented. Unhandled, the button would simply do nothing.
        Alert.alert(`Could not connect ${name}`, (err as Error).message || 'Try again in a moment.');
      } finally {
        setConnecting(null);
        await refresh();
      }
    },
    [connecting, refresh],
  );

  if (loading) {
    return (
      <View style={[styles.root, styles.content]}>
        <SkeletonCard lines={1} style={styles.card} />
        <SkeletonCard lines={1} style={styles.card} />
      </View>
    );
  }
  // Only an empty screen is a dead end. `error` is set by the focus refetch and
  // by pull to refresh as well, so failing on it would tear down a list of
  // working connections over one lost packet.
  if (!data) {
    return (
      <View style={styles.root}>
        <ErrorState message={error ?? 'Could not load your calendars.'} onRetry={refresh} />
      </View>
    );
  }

  const showPrimary = data.connected.length > 1;

  return (
    <ScrollView
      style={styles.root}
      // edgeToEdgeEnabled draws behind the Android nav bar and the iOS home
      // indicator, so without the inset the footnote ends up underneath it.
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

      {data.connected.length === 0 && data.connectable.length === 0 && (
        <View style={styles.emptyWrap}>
          <EmptyState
            icon="calendar-outline"
            title="No calendar providers available"
            body="None are configured for this account yet."
          />
        </View>
      )}

      {data.connected.length > 0 && (
        <Text style={styles.groupTitle} accessibilityRole="header">
          Connected
        </Text>
      )}
      {data.connected.map((row) => (
        <ConnectedCard
          key={row.id}
          row={row}
          showPrimary={showPrimary}
          onChanged={refresh}
          onReconnect={() => void connect(row.provider, row.name)}
          reconnecting={connecting === row.provider}
          locked={connecting !== null}
        />
      ))}

      {data.connectable.length > 0 && (
        <>
          <Text style={styles.groupTitle} accessibilityRole="header">
            Add a calendar
          </Text>
          <Card style={[styles.card, styles.listCard]}>
            {data.connectable.map((p, i) => (
              <ListRow
                key={p.id}
                icon="calendar-outline"
                label={`Connect ${p.name}`}
                trailing="external"
                onPress={() => void connect(p.id, p.name)}
                busy={connecting === p.id}
                disabled={connecting !== null && connecting !== p.id}
                accessibilityHint="Opens the sign-in page in a browser"
                divided={i > 0}
              />
            ))}
          </Card>
        </>
      )}

      <Text style={styles.footnote}>
        A connected calendar lets your receptionist see when you are free and book into it. Which
        calendar it may use is set on each receptionist, under Booking.
      </Text>
    </ScrollView>
  );
}

/**
 * The /mobile/done error is a slug of the provider's message - diagnostics,
 * not copy. Name the cases a person can do something about.
 */
function connectError(slug: string, name: string): string {
  if (slug === 'access-denied' || slug.includes('denied') || slug.includes('declined')) {
    return `Access was not allowed, so ${name} was not connected.`;
  }
  if (slug.includes('expired') || slug.includes('invalid')) {
    return 'The sign-in took too long. Try again.';
  }
  if (slug.includes('not-configured')) {
    return `${name} cannot be connected right now.`;
  }
  if (slug.includes('sign-in')) {
    return 'Your session on the website ended. Try again.';
  }
  return 'Something went wrong while connecting. Try again.';
}

function ConnectedCard({
  row,
  showPrimary,
  onChanged,
  onReconnect,
  reconnecting,
  locked,
}: {
  row: CalendarConnection;
  showPrimary: boolean;
  onChanged: () => Promise<void>;
  onReconnect: () => void;
  reconnecting: boolean;
  /** Another connect is in flight. */
  locked: boolean;
}) {
  const [busy, setBusy] = useState<'primary' | 'disconnect' | null>(null);

  async function makePrimary() {
    setBusy('primary');
    try {
      await api.setPrimaryCalendar(row.id);
      await onChanged();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      Alert.alert('Could not update', (err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function confirmDisconnect() {
    Alert.alert(
      `Disconnect ${row.name}?`,
      'Your receptionist stops checking it and stops booking into it. Existing appointments stay where they are.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: async () => {
            setBusy('disconnect');
            try {
              await api.disconnectCalendar(row.id);
              await onChanged();
            } catch (err) {
              Alert.alert('Could not disconnect', (err as Error).message);
            } finally {
              setBusy(null);
            }
          },
        },
      ],
    );
  }

  return (
    <Card style={styles.card}>
      <View style={styles.row}>
        <Icon name="calendar" size={ICON.action} color={colors.ink} />
        <View
          style={styles.flex}
          accessible
          accessibilityLabel={[row.name, row.account, row.isPrimary && showPrimary ? 'Primary' : null]
            .filter(Boolean)
            .join(', ')}
        >
          <Text style={styles.name} numberOfLines={1}>
            {row.name}
          </Text>
          {Boolean(row.account) && (
            <Text style={styles.account} numberOfLines={1}>
              {row.account}
            </Text>
          )}
        </View>
        {row.isPrimary && showPrimary && <Badge label="Primary" />}
      </View>

      {row.needsReconnect && (
        <Notice
          tone="warning"
          title="Reconnect needed"
          live
          action={
            <Button
              label="Reconnect"
              icon="refresh-outline"
              size="pill"
              onPress={onReconnect}
              busy={reconnecting}
              disabled={locked && !reconnecting}
              accessibilityHint={`Signs in to ${row.name} again`}
              style={styles.reconnectButton}
            />
          }
        >
          Your receptionist cannot read this calendar right now, so nothing is being booked into
          it.
        </Notice>
      )}

      <View style={styles.actions}>
        {showPrimary && !row.isPrimary && (
          <Button
            label="Make primary"
            variant="secondary"
            size="pill"
            onPress={() => void makePrimary()}
            busy={busy === 'primary'}
            disabled={busy !== null}
          />
        )}
        <Button
          label="Disconnect"
          variant="danger"
          size="pill"
          onPress={confirmDisconnect}
          busy={busy === 'disconnect'}
          disabled={busy !== null}
          accessibilityHint={`Removes ${row.name}`}
          style={styles.disconnect}
        />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  // The inset lives on the rows, not on the container, so that a StaleNotice at
  // the top (which brings its own margin) lines up with the cards below it.
  content: { flexGrow: 1, paddingVertical: spacing.lg, gap: spacing.md },
  flex: { flex: 1 },
  emptyWrap: { flex: 1, justifyContent: 'center' },
  card: { marginHorizontal: spacing.lg, gap: spacing.md },
  listCard: { gap: 0, paddingVertical: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  name: { ...type.body, fontFamily: fonts.semibold, flex: 1 },
  account: { ...type.caption, marginTop: 2 },
  reconnectButton: { alignSelf: 'flex-start' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  disconnect: { marginLeft: 'auto' },
  groupTitle: {
    ...type.eyebrow,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
  },
  footnote: {
    ...type.footnote,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
  },
});
