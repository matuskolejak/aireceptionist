import {
  Inter_300Light,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  useFonts,
} from '@expo-google-fonts/inter';
import { DefaultTheme, ThemeProvider } from '@react-navigation/native';
import * as Notifications from 'expo-notifications';
import { Stack, useRouter } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider, useAuth } from '@/context/AuthContext';
import { PurchaseProvider } from '@/context/PurchaseContext';
import { SetupGateContext } from '@/context/SetupGate';
import { colors, fonts, type } from '@/constants/theme';
import { api } from '@/lib/api';
import { payloadOf, registerIfGranted } from '@/lib/push';
import { clearSessionEnded, sessionEnded } from '@/lib/session-ended';

export { ErrorBoundary } from 'expo-router';

void SplashScreen.preventAutoHideAsync();

// The dashboard is light-only on the web; keeping one theme here means a phone
// in dark mode gets the same surfaces rather than a half-inverted set.
const AppTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    primary: colors.ink,
    background: colors.background,
    card: colors.surface,
    text: colors.text,
    border: colors.border,
  },
};

/**
 * Every native header in the app: the web PageHeader's Inter 600 on the page
 * colour, no hairline under it, and a bare chevron for back (the previous
 * screen's title beside it read as a second, competing title).
 */
const screenOptions = {
  contentStyle: { backgroundColor: colors.background },
  headerTitleStyle: { fontFamily: fonts.semibold, fontSize: type.title.fontSize, color: colors.text },
  headerShadowVisible: false,
  headerBackButtonDisplayMode: 'minimal',
  headerStyle: { backgroundColor: colors.background },
  headerTintColor: colors.ink,
} as const;

/** The native splash's artwork and size (app.json, expo-splash-screen plugin). */
const SPLASH_ICON = require('@/assets/images/splash-icon.png');
const SPLASH_ICON_SIZE = 180;

export default function RootLayout() {
  // Inter is the one family the whole type scale is built on (constants/theme.ts),
  // so nothing renders until it is in. The native splash stays up meanwhile
  // (`preventAutoHideAsync` above); on a load error the system font stands in
  // rather than the app never starting.
  const [fontsLoaded, fontError] = useFonts({
    Inter_300Light,
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
  });
  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <AuthProvider>
        <PurchaseProvider>
          <RootNav />
        </PurchaseProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}

function RootNav() {
  const { session, userId, loading } = useAuth();
  const router = useRouter();

  // Whether setup is finished. `null` means "not checked yet", which is NOT the
  // same as "not finished" - routing on null would flash the funnel at every
  // returning user for a frame.
  const [setupDone, setSetupDone] = useState<boolean | null>(null);

  // The probe below runs once per account, and finishing the funnel does not
  // change the account - so without this the flag would stay `false` for the
  // rest of the app run and the funnel would stay the only reachable screen.
  // The funnel flips it itself.
  const gate = useMemo(() => ({ markSetupDone: () => setSetupDone(true) }), []);

  // The setup probe. Keyed on the user id, not the session object: auth-js
  // mints a new session on every token refresh (about hourly, and on
  // foreground), and re-probing on each one used to re-run this request - and,
  // when it failed mid-funnel, throw the user out of setup.
  const probedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!userId) {
      probedFor.current = null;
      setSetupDone(null);
      return;
    }
    // A different account must never inherit the last one's answer.
    if (probedFor.current !== userId) {
      probedFor.current = userId;
      setSetupDone(null);
    }
    let alive = true;
    api
      .onboarding()
      .then((state) => {
        if (alive) setSetupDone(state.done);
      })
      .catch(() => {
        if (!alive) return;
        // Only an UNKNOWN answer is filled in: a failed first check must not
        // lock anyone out of an app they have already set up, so it assumes
        // finished and lets the tabs report their own errors. A later failure
        // keeps what is known - above all a `false` for someone mid-funnel.
        setSetupDone((current) => current ?? true);
      });
    return () => {
      alive = false;
    };
  }, [userId]);

  // Hide the native splash the moment auth resolves, not once the setup probe
  // settles: that request is bounded only by the 20s API timeout, so a device
  // that cannot reach the API - a reviewer's, or anyone on a dead network -
  // would stare at a frozen splash for the full 20s, which reads as a launch
  // hang. The overlay below takes over with the same artwork and a spinner.
  useEffect(() => {
    if (!loading) void SplashScreen.hideAsync();
  }, [loading]);

  // Refresh the push token of a phone that has ALREADY allowed notifications.
  // Never prompts: the OS permission prompt is one-shot on iOS, so it is only
  // asked for from an explicit primer (lib/push.ts requestAndRegister), never
  // on top of the funnel's plan step right after sign-up. Fire and forget - a
  // phone without push still gets a working app.
  useEffect(() => {
    if (!userId || setupDone !== true) return;
    void registerIfGranted().catch(() => {});
  }, [userId, setupDone]);

  // Tapping a notification.
  //
  // Two paths, and missing either one is a bug you only see on a real device:
  // `getLastNotificationResponseAsync` covers a COLD start (the app was killed,
  // the tap launched it), the listener covers a warm one. Handled here rather
  // than per-screen because the router is only mounted at this level.
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!userId || setupDone !== true) return;

    const open = (response: Notifications.NotificationResponse | null) => {
      if (!response) return;
      // The same cold-start response is replayed on every remount; without this
      // guard, navigating away and back re-opens the call you just left.
      const id = response.notification.request.identifier;
      if (handled.current === id) return;
      handled.current = id;

      const payload = payloadOf(response);
      if (payload) router.push(payload.path as never);
    };

    void Notifications.getLastNotificationResponseAsync().then(open);
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    return () => sub.remove();
  }, [userId, setupDone, router]);

  const checking = loading || (session !== null && setupDone === null);

  // The Stack mounts once the first answer is in (auth read + first setup
  // probe) and then stays mounted for the rest of the app run: signing in,
  // finishing setup and signing out only flip the guards below. Mounting it
  // earlier would build the first screen from a guess - the funnel for every
  // returning user on every cold start, which then fires its own requests and
  // replays its draft under the overlay - and would drop a cold-start deep
  // link, which is resolved against the guards in force when the Stack mounts.
  //
  // The overlay covers only THAT first wait. A later check - the probe right
  // after signing in from the funnel - runs behind the screen that is already
  // up: the funnel shows its own "Saving your setup" while the account is
  // read, and putting the ink splash over it made the app look as if it had
  // relaunched half way through setup.
  const [mounted, setMounted] = useState(!checking);
  if (!checking && !mounted) setMounted(true);

  const signedIn = session !== null;

  // A session the API refused (lib/use-query.ts) lands the user on the first
  // signed-out screen, the funnel, with no word about why. Open sign-in over
  // it, where the subtitle says the session ended; the note is spent the
  // moment a session exists again.
  useEffect(() => {
    if (signedIn) {
      clearSessionEnded();
      return;
    }
    if (!mounted || !sessionEnded()) return;
    // Next tick: the guards above have to apply before the push can resolve.
    const timer = setTimeout(() => router.push('/(auth)/sign-in'), 0);
    return () => clearTimeout(timer);
  }, [signedIn, mounted, router]);

  return (
    <ThemeProvider value={AppTheme}>
      <StatusBar style="dark" />
      <SetupGateContext.Provider value={gate}>
        {mounted ? (
          <View style={styles.flex}>
            {/* The routing gate. A guard that turns false removes its screens
                from the Stack; when no screen is left, the Stack lands on the
                FIRST screen still allowed. Hence the order: onboarding first
                (where guests and anyone mid-setup belong), then sign-in, then
                the tabs (the first thing left once setup is done). */}
            <Stack screenOptions={screenOptions}>
              <Stack.Protected guard={!signedIn || setupDone !== true}>
                <Stack.Screen
                  name="onboarding"
                  options={{ headerShown: false, gestureEnabled: false, animation: 'fade' }}
                />
              </Stack.Protected>

              {/* Signed out only. Signing in removes it, which pops back to
                  the funnel underneath without remounting it. */}
              <Stack.Protected guard={!signedIn}>
                <Stack.Screen name="(auth)" options={{ headerShown: false }} />
              </Stack.Protected>

              <Stack.Protected guard={signedIn && setupDone === true}>
                <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                <Stack.Screen name="call/[id]" options={{ title: 'Call' }} />
                <Stack.Screen name="assistant/[id]" options={{ title: 'Receptionist' }} />
                <Stack.Screen name="knowledge" options={{ title: 'Knowledge' }} />
                <Stack.Screen name="notifications" options={{ title: 'Recent activity' }} />
                <Stack.Screen
                  name="calendar/connections"
                  options={{ title: 'Connected calendars' }}
                />
                <Stack.Screen name="settings/profile" options={{ title: 'Business profile' }} />
                <Stack.Screen name="settings/alerts" options={{ title: 'Alerts' }} />
                <Stack.Screen name="settings/devices" options={{ title: 'Signed-in devices' }} />
              </Stack.Protected>

              {/* Any signed-in user, setup finished or not: the paywall is
                  where a subscription is bought or restored, and deleting the
                  account must be possible before setup is done (5.1.1(v)). */}
              <Stack.Protected guard={signedIn}>
                <Stack.Screen
                  name="paywall"
                  options={{ presentation: 'modal', headerShown: false }}
                />
                {/* Compatibility stub that redirects to the paywall. */}
                <Stack.Screen name="pricing" options={{ headerShown: false, animation: 'none' }} />
                <Stack.Screen name="settings/delete-account" options={{ title: 'Delete account' }} />
              </Stack.Protected>

              {/* Not listed, so never guarded: +not-found (a stray link can
                  arrive in any state) sets its own options. */}
            </Stack>
          </View>
        ) : null}

        {!mounted ? <LaunchOverlay /> : null}
      </SetupGateContext.Provider>
    </ThemeProvider>
  );
}

/**
 * Covers the gap between the native splash and the first screen. Same ink
 * background and artwork, at the same size and position, as the native
 * splash, so the hand-over does not flash.
 */
function LaunchOverlay() {
  return (
    <View style={styles.overlay} accessibilityViewIsModal>
      <StatusBar style="light" />
      <Image
        source={SPLASH_ICON}
        style={styles.splashIcon}
        resizeMode="contain"
        accessibilityElementsHidden
        importantForAccessibility="no"
      />
      <View style={styles.spinner}>
        <ActivityIndicator color={colors.white} accessibilityLabel="Loading" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.ink,
  },
  splashIcon: {
    width: SPLASH_ICON_SIZE,
    height: SPLASH_ICON_SIZE,
  },
  // Below the artwork without moving it off the native splash's centre.
  spinner: {
    position: 'absolute',
    top: '50%',
    marginTop: SPLASH_ICON_SIZE / 2 + 24,
  },
});
