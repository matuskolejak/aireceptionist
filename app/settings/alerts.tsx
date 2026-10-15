import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, ScrollView, StyleSheet, Text, View } from 'react-native';

import { SwitchRow } from '@/components/form';
import { Button, ErrorState, Notice, Skeleton, StaleNotice } from '@/components/ui';
import { colors, spacing, type } from '@/constants/theme';
import { api } from '@/lib/api';
import { formatPhone } from '@/lib/format';
import { isPushMuted, setPushEnabled, type PushState } from '@/lib/push';
import { useQuery } from '@/lib/use-query';

/**
 * Account-level alerts. These are the two switches the web's Alerts tab owns,
 * plus push, which is the phone's own.
 *
 * Every switch saves the moment it is flipped - one model for the screen,
 * where the push switch already had to (its state lives in the OS) and a Save
 * bar for the other two made the same control mean two things. A save that
 * fails snaps the switch back and says so under the list.
 *
 * The addresses themselves are not editable here on purpose: the email is the
 * account's sign-in address and the text number falls back to the profile
 * phone, so an editable copy on this screen would be a second source of truth
 * for both. The labels are the web's.
 */
export default function AlertsScreen() {
  const { data, error, loading, refresh } = useQuery(() => api.settings(), []);

  const [email, setEmail] = useState(true);
  const [sms, setSms] = useState(false);
  /** Which account switch is saving, so it cannot be flipped twice mid-flight. */
  const [saving, setSaving] = useState<'email' | 'sms' | null>(null);
  const [state, setState] = useState<{ ok: boolean; message: string } | null>(null);

  // Push is not part of the settings payload: its real state lives in the OS,
  // and a server flag that says "on" while iOS says "denied" is worse than no
  // switch at all. Read the permission itself, save immediately on toggle.
  const [push, setPush] = useState<PushState | null>(null);
  const [pushBusy, setPushBusy] = useState(false);

  // Separates "the OS said no" from "the user muted the switch". Only the first
  // may be upgraded on the way back from system Settings; auto-upgrading the
  // second would re-register the token and undo a deliberate opt-out.
  const osDenied = useRef(false);

  const readPermission = useCallback(async (initial: boolean) => {
    const granted = (await Notifications.getPermissionsAsync()).granted;
    if (!granted) {
      osDenied.current = true;
      setPush({ status: 'denied' });
      return;
    }
    if (initial) {
      osDenied.current = false;
      // A mute is server-side only and there is no endpoint to read it back, so
      // the flag this install wrote when it muted is the local source of truth.
      // 'granted' rather than 'ready': the permission read alone mints no token,
      // and 'ready' promises one.
      setPush((await isPushMuted()) ? { status: 'muted' } : { status: 'granted' });
      return;
    }
    // Muted, unsupported or errored: whatever is on screen is still right.
    if (!osDenied.current) return;
    osDenied.current = false;
    // A mute made before the grant was revoked is still the user's choice, and
    // `osDenied` alone cannot tell the two apart once a denial has overwritten
    // it. Registering here would unmute an install nobody asked to unmute.
    if (await isPushMuted()) {
      setPush({ status: 'muted' });
      return;
    }
    setPushBusy(true);
    // Mints and registers a real token, which the permission read alone cannot.
    setPush(await setPushEnabled(true));
    setPushBusy(false);
  }, []);

  useEffect(() => {
    void readPermission(true);
  }, [readPermission]);

  // The denied note sends the user to system Settings, and granting there does
  // not restart the app. Without this re-read they come back to a screen still
  // insisting notifications are off.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void readPermission(false);
    });
    return () => sub.remove();
  }, [readPermission]);

  const togglePush = useCallback(async (next: boolean) => {
    setPushBusy(true);
    const result = await setPushEnabled(next);
    osDenied.current = next && result.status === 'denied';
    setPush(result);
    if (result.status === 'ready') {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    setPushBusy(false);
  }, []);

  // Seeded once, from the first payload. Re-seeding on every `data` identity -
  // and useQuery hands back a new object on each focus and foreground refetch -
  // would overwrite a switch mid-save.
  const seeded = useRef(false);
  useEffect(() => {
    if (!data || seeded.current) return;
    seeded.current = true;
    setEmail(data.notifications.email);
    setSms(data.notifications.sms);
  }, [data]);

  // "Saved" is transient; a failure stays until the next attempt.
  useEffect(() => {
    if (!state?.ok) return;
    const timer = setTimeout(() => setState(null), 2000);
    return () => clearTimeout(timer);
  }, [state]);

  // Optimistic: the switch moves under the thumb and the save follows. On
  // failure it snaps back, because a switch showing "on" for an alert that
  // will never be sent is the one lie this screen must not tell.
  async function toggle(which: 'email' | 'sms', next: boolean) {
    const previous = which === 'email' ? email : sms;
    const set = which === 'email' ? setEmail : setSms;
    set(next);
    setSaving(which);
    setState(null);
    void Haptics.selectionAsync();
    try {
      await api.saveSettings(which === 'email' ? { notifyEmail: next } : { notifySms: next });
      await refresh();
      setState({ ok: true, message: 'Saved' });
    } catch (err) {
      set(previous);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setState({ ok: false, message: `That did not save. ${(err as Error).message}` });
    } finally {
      setSaving(null);
    }
  }

  if (loading) {
    return (
      <View style={[styles.root, styles.content]} accessible accessibilityLabel="Loading">
        {[0, 1, 2].map((i) => (
          <View key={i} style={styles.skeletonRow}>
            <View style={styles.skeletonLines}>
              <Skeleton width="45%" height={14} />
              <Skeleton width="80%" height={10} />
            </View>
            <Skeleton width={51} height={31} radius={16} />
          </View>
        ))}
      </View>
    );
  }
  // Only a missing payload is a dead end. A failed background refetch still has
  // the last good settings to show, with the notice below saying so.
  if (!data) return <ErrorState message={error ?? 'Could not load your alerts.'} onRetry={refresh} />;

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        {error ? <StaleNotice message={error} onRetry={refresh} /> : null}
        <SwitchRow
          title="Push alerts"
          body={pushBody(push)}
          value={push?.status === 'ready' || push?.status === 'granted'}
          onValueChange={(v) => void togglePush(v)}
          disabled={pushBusy || push?.status === 'unsupported'}
        />
        {push?.status === 'denied' && (
          <Notice
            tone="warning"
            style={styles.denied}
            action={
              <Button
                label="Open Settings"
                variant="secondary"
                size="pill"
                icon="open-outline"
                iconPosition="right"
                onPress={() => void Linking.openSettings()}
                accessibilityHint="Opens this app's settings to allow notifications"
                style={styles.deniedButton}
              />
            }
          >
            Notifications are turned off for this app in your phone settings.
          </Notice>
        )}
        <SwitchRow
          title="Email me call summaries"
          body={
            data.notifications.emailAddress
              ? `A recap of each call, sent to ${data.notifications.emailAddress}.`
              : 'A recap of each call, sent to your account email.'
          }
          value={email}
          onValueChange={(v) => void toggle('email', v)}
          disabled={saving !== null}
        />
        <SwitchRow
          title="Text me urgent messages"
          body={
            data.notifications.smsNumber
              ? `Sent to ${formatPhone(data.notifications.smsNumber)}.`
              : 'Add your phone under Business profile to get these.'
          }
          value={sms}
          onValueChange={(v) => void toggle('sms', v)}
          // The server falls back to the profile phone, so this is only off
          // for an account with no phone number at all.
          disabled={saving !== null || !data.notifications.smsNumber}
        />
        {state ? (
          <Text
            style={[styles.state, { color: state.ok ? colors.successText : colors.errorText }]}
            accessibilityLiveRegion="polite"
          >
            {state.message}
          </Text>
        ) : null}
        <Text style={styles.note}>
          Texts are sent when your receptionist takes a message. Each receptionist also has its own
          alerts, like the transcript email, under Alerts and recaps.
        </Text>
      </ScrollView>
    </View>
  );
}

/** One line explaining whatever the OS actually said. */
function pushBody(push: PushState | null): string {
  switch (push?.status) {
    case 'ready':
    case 'granted':
      return 'Sent the moment a call ends, with what the receptionist did.';
    case 'muted':
      return 'Off for this phone. Turn it back on to hear about calls the moment they end.';
    case 'unsupported':
      return push.reason;
    case 'error':
      return push.reason;
    case 'denied':
      return 'Turned off. The fastest way to hear about a call you missed.';
    default:
      return 'Checking...';
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  state: { ...type.footnote, marginTop: spacing.md },
  note: { ...type.footnote, marginTop: spacing.lg },
  denied: { marginTop: spacing.md, marginBottom: spacing.xs },
  deniedButton: { alignSelf: 'flex-start' },
  // A SwitchRow: two lines beside a 51x31 switch, the divider under it.
  skeletonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  skeletonLines: { flex: 1, gap: spacing.sm },
});
