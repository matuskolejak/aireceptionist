import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
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
  SkeletonRows,
  StaleNotice,
  useLargeText,
  useLineLimit,
} from '@/components/ui';
import { colors, fonts, spacing, type } from '@/constants/theme';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/api';
import { relTimeOf } from '@/lib/format';
import type { AccountDevice } from '@/lib/types';
import { useQuery } from '@/lib/use-query';

/** The busy key of "Sign out everywhere else". Device ids are 8-64 characters, so it cannot clash. */
const OTHERS = 'others';

/**
 * Where this account is signed in.
 *
 * The account is shared with the website - the app authenticates against the
 * same Supabase project, so the same email is the same user on both - and this
 * is what makes that visible. Each install registers a keychain-held device id
 * on sign-in; this lists them.
 *
 * Removing a row stops call alerts to that device (the server drops its push
 * registration) but does NOT sign it out: it registers again the next time it
 * opens the app, and the copy says so. Ending other sessions is "Sign out
 * everywhere else": GoTrue revokes every session but this one, then the server
 * forgets those installs (signOutOthers in context/AuthContext.tsx). The phone
 * in your hand signs out of itself only.
 */
export default function DevicesScreen() {
  const oneLine = useLineLimit(1);
  // At the accessibility sizes the button goes under the device text: beside
  // it, the name broke inside a word ("Simul / ator").
  const stacked = useLargeText();
  const insets = useSafeAreaInsets();
  const { signOut, signOutOthers } = useAuth();
  const { data, error, loading, refresh } = useQuery<{ devices: AccountDevice[] }>(
    () => api.devices(),
    [],
  );
  const [busy, setBusy] = useState<string | null>(null);

  function confirmRemove(device: AccountDevice) {
    const name = device.model || 'this device';
    Alert.alert(
      `Remove ${name}?`,
      'It stops call alerts until that device opens the app again. To sign it out, use Sign out everywhere else.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove this device',
          style: 'destructive',
          onPress: async () => {
            setBusy(device.deviceId);
            try {
              await api.revokeDevice(device.deviceId);
              await refresh();
            } catch (e) {
              Alert.alert('Could not remove it', (e as Error).message);
            } finally {
              setBusy(null);
            }
          },
        },
      ],
    );
  }

  function confirmSignOut(device: AccountDevice) {
    Alert.alert('Sign out?', 'You will need to sign in again to see your calls.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: async () => {
          setBusy(device.deviceId);
          try {
            // Bounded inside AuthContext: never hangs, online or not.
            await signOut();
          } finally {
            setBusy(null);
          }
        },
      },
    ]);
  }

  function confirmSignOutOthers() {
    Alert.alert(
      'Sign out everywhere else?',
      'Your other phones and the website will need to sign in again. This phone stays signed in.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign out others',
          style: 'destructive',
          onPress: async () => {
            setBusy(OTHERS);
            try {
              // Bounded inside AuthContext: never hangs, online or not.
              const failed = await signOutOthers();
              if (failed) {
                Alert.alert('Could not sign out other devices', failed);
                return;
              }
              await refresh();
              Alert.alert(
                'Signed out everywhere else',
                'Your other phones and the website need to sign in again.',
              );
            } finally {
              setBusy(null);
            }
          },
        },
      ],
    );
  }

  if (loading) {
    return (
      <View style={[styles.root, styles.content]}>
        <Text style={styles.intro}>
          Your account is the same on the phone and on the website. These are the app installs
          signed into it.
        </Text>
        <Card style={styles.card} padded={false}>
          <SkeletonRows count={2} height={72} />
        </Card>
      </View>
    );
  }
  if (!data) return <ErrorState message={error ?? 'Could not load your devices.'} onRetry={refresh} />;

  const empty = data.devices.length === 0;

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[
        styles.content,
        empty && styles.emptyContent,
        { paddingBottom: insets.bottom + spacing.xl },
      ]}
    >
      {error ? <StaleNotice message={error} onRetry={refresh} /> : null}

      <Text style={styles.intro}>
        Your account is the same on the phone and on the website. These are the app installs signed
        into it.
      </Text>

      {empty ? (
        <View style={styles.emptyWrap}>
          <EmptyState
            icon="phone-portrait-outline"
            title="No devices yet"
            body="This install registers itself the next time it reaches the server."
          />
        </View>
      ) : (
        <Card style={styles.card} padded={false}>
          {data.devices.map((device, i) => {
            const name = device.model || 'Unknown device';
            const meta = [device.osVersion, device.appVersion && `App ${device.appVersion}`]
              .filter(Boolean)
              .join(' · ');
            const seen = `Last active ${relTimeOf(device.lastSeenAt) || 'recently'}`;
            const action = (
              <Button
                label={device.current ? 'Sign out' : 'Remove'}
                accessibilityLabel={device.current ? 'Sign out of this phone' : `Remove ${name}`}
                size="pill"
                variant="danger"
                busy={busy === device.deviceId}
                disabled={busy !== null}
                onPress={() => (device.current ? confirmSignOut(device) : confirmRemove(device))}
              />
            );
            return (
              <View key={device.deviceId} style={[styles.row, i > 0 && styles.divided]}>
                <Icon
                  name={device.platform === 'android' ? 'logo-android' : 'phone-portrait-outline'}
                  size={ICON.action}
                  color={colors.textSecondary}
                />
                <View style={styles.flex}>
                  <View
                    accessible
                    accessibilityLabel={[name, device.current ? 'This phone' : null, meta, seen]
                      .filter(Boolean)
                      .join(', ')}
                  >
                    <View style={styles.titleRow}>
                      <Text style={styles.model} numberOfLines={oneLine}>
                        {name}
                      </Text>
                      {device.current ? <Badge label="This phone" tone="success" /> : null}
                    </View>
                    {meta ? (
                      <Text style={styles.meta} numberOfLines={oneLine}>
                        {meta}
                      </Text>
                    ) : null}
                    <Text style={styles.meta}>{seen}</Text>
                  </View>
                  {stacked ? <View style={styles.stackedAction}>{action}</View> : null}
                </View>
                {stacked ? null : action}
              </View>
            );
          })}
        </Card>
      )}

      <Card style={[styles.card, styles.othersCard]} padded={false}>
        <ListRow
          icon="log-out-outline"
          label="Sign out everywhere else"
          destructive
          trailing="none"
          busy={busy === OTHERS}
          disabled={busy !== null}
          onPress={confirmSignOutOthers}
        />
      </Card>
      <Text style={styles.footnote}>
        Signs out your other phones and the website. This phone stays signed in.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg },
  emptyContent: { flexGrow: 1 },
  emptyWrap: { flex: 1, justifyContent: 'center' },
  flex: { flex: 1 },
  intro: {
    ...type.bodySm,
    marginBottom: spacing.lg,
    color: colors.textSecondary,
  },
  card: { paddingHorizontal: spacing.lg },
  othersCard: { marginTop: spacing.lg },
  footnote: { ...type.caption, marginTop: spacing.sm, paddingHorizontal: spacing.lg },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  divided: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  model: { ...type.body, fontFamily: fonts.semibold, flexShrink: 1 },
  meta: { ...type.caption, marginTop: 2 },
  stackedAction: { marginTop: spacing.sm, alignSelf: 'flex-start' },
});
