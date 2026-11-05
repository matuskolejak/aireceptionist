import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, ScrollView, StyleSheet, Text, View } from 'react-native';

import { SwitchRow } from '@/components/form';
import { Button, Notice } from '@/components/ui';
import { colors, spacing, type } from '@/constants/theme';
import { isPushMuted, setPushEnabled, type PushState } from '@/lib/push';

/**
 * This phone's push alerts. Texts and recap emails are set for each
 * receptionist (Alerts and recaps on its screen), which is what the call
 * engine reads. The account-level email and text switches that were here
 * wrote account_settings.notify_email / notify_sms, which no alert reads, so
 * they were removed. The screen loads nothing from the server: push lives in
 * the OS, and its switch saves the moment it is flipped.
 */
export default function AlertsScreen() {
  const router = useRouter();

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
    const permission = await Notifications.getPermissionsAsync();
    if (!permission.granted) {
      // Not asked yet. iOS lists no Notifications row in Settings until the app
      // has asked once, so the denied note would send the user nowhere. The
      // switch shows the OS prompt instead (requestAndRegister).
      if (permission.canAskAgain) {
        // A later read keeps what is on screen (unsupported, an error) unless
        // it was a denial that can now be asked again.
        if (initial || osDenied.current) {
          osDenied.current = false;
          setPush({ status: 'undetermined' });
        }
        return;
      }
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- readPermission is async; every setState in it runs after its first await.
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

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <SwitchRow
          title="Push alerts"
          body={pushBody(push)}
          value={push?.status === 'ready' || push?.status === 'granted'}
          onValueChange={(v) => void togglePush(v)}
          disabled={pushBusy || !push || push.status === 'unsupported'}
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
        <Text style={styles.note}>
          Texts and emails are set for each receptionist. Open a receptionist in the Receptionist
          tab and tap Alerts and recaps.
        </Text>
        <Button
          label="Open receptionists"
          variant="secondary"
          icon="headset-outline"
          // dismissTo, not navigate: in Expo Router 58 navigate pushes a second
          // tab bar on top of this stack. dismissTo pops back to the tabs and
          // switches to the Receptionist tab.
          onPress={() => router.dismissTo('/assistant')}
          accessibilityHint="Opens the Receptionist tab"
          style={styles.open}
        />
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
    case 'undetermined':
      return 'Turn this on to get an alert for every call.';
    default:
      return 'Checking...';
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  note: { ...type.footnote, marginTop: spacing.lg },
  open: { marginTop: spacing.md, alignSelf: 'flex-start' },
  denied: { marginTop: spacing.md, marginBottom: spacing.xs },
  deniedButton: { alignSelf: 'flex-start' },
});
