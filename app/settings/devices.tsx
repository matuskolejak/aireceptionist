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
  SkeletonRows,
  StaleNotice,
} from '@/components/ui';
import { colors, fonts, spacing, type } from '@/constants/theme';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/api';
import { relTimeOf } from '@/lib/format';
import type { AccountDevice } from '@/lib/types';
import { useQuery } from '@/lib/use-query';

/**
 * Where this account is signed in.
 *
 * The account is shared with the website - the app authenticates against the
 * same Supabase project, so the same email is the same user on both - and this
 * is what makes that visible. Each install registers a keychain-held device id
 * on sign-in; this lists them.
 *
 * Removing a row stops call alerts to that device (the server drops its push
 * registration) but does NOT sign it out: the refresh token lives in that
 * device's keychain and only GoTrue can invalidate it. The copy says exactly
 * that - promising a remote sign-out this cannot deliver would be worse than
 * not offering it. The phone in your hand offers a real Sign out instead.
 */
export default function DevicesScreen() {
  const insets = useSafeAreaInsets();
  const { signOut } = useAuth();
  const { data, error, loading, refresh } = useQuery<{ devices: AccountDevice[] }>(
    () => api.devices(),
    [],
  );
  const [busy, setBusy] = useState<string | null>(null);

  function confirmRemove(device: AccountDevice) {
    const name = device.model || 'this device';
    Alert.alert(
      `Remove ${name}?`,
      'It stops call alerts to that phone. It stays signed in until someone signs out on it.',
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
            return (
              <View key={device.deviceId} style={[styles.row, i > 0 && styles.divided]}>
                <Icon
                  name={device.platform === 'android' ? 'logo-android' : 'phone-portrait-outline'}
                  size={ICON.action}
                  color={colors.textSecondary}
                />
                <View
                  style={styles.flex}
                  accessible
                  accessibilityLabel={[name, device.current ? 'This phone' : null, meta, seen]
                    .filter(Boolean)
                    .join(', ')}
                >
                  <View style={styles.titleRow}>
                    <Text style={styles.model} numberOfLines={1}>
                      {name}
                    </Text>
                    {device.current ? <Badge label="This phone" tone="success" /> : null}
                  </View>
                  {meta ? (
                    <Text style={styles.meta} numberOfLines={1}>
                      {meta}
                    </Text>
                  ) : null}
                  <Text style={styles.meta}>{seen}</Text>
                </View>

                <Button
                  label={device.current ? 'Sign out' : 'Remove'}
                  accessibilityLabel={device.current ? 'Sign out of this phone' : `Remove ${name}`}
                  size="pill"
                  variant="danger"
                  busy={busy === device.deviceId}
                  disabled={busy !== null}
                  onPress={() => (device.current ? confirmSignOut(device) : confirmRemove(device))}
                />
              </View>
            );
          })}
        </Card>
      )}
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
});
