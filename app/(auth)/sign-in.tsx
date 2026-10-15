import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';

import { TextField } from '@/components/form';
import { Button, Notice, pressed, TextLink } from '@/components/ui';
import {
  colors,
  control,
  fonts,
  MAX_FONT_SCALE,
  radius,
  spacing,
  type,
} from '@/constants/theme';
import { useAuth } from '@/context/AuthContext';
import { apiConfigured } from '@/lib/api';
import { appleAuthModule, isAvailable, signInWithAppleNative } from '@/lib/apple-auth';
import { openInApp, PRIVACY_URL, TERMS_URL } from '@/lib/links';
import type { OAuthProvider } from '@/lib/oauth';
import { sessionEnded } from '@/lib/session-ended';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Sign in / sign up, mirroring the web's auth dialog.
 *
 * Three ways in: Apple, Google, then a 6-digit email code. There is no
 * separate "register" - all three create the account on first use, exactly
 * like `shouldCreateUser: true` does on the site, so someone who bought on the
 * web and someone who started in the app land on the same row.
 *
 * On iOS Apple comes first as Apple's own button (native flow, lib/apple-auth.ts);
 * where that is unavailable, and on Android, it is the browser flow behind our
 * button. The legal notice sits on both steps because this is where accounts
 * are created.
 *
 * Reached two ways: from the funnel's plan step (`?next=/onboarding`), which is
 * where a new customer meets it, and from the funnel's sign-in link for people
 * who already have an account.
 */
export default function SignInScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { next } = useLocalSearchParams<{ next?: string }>();
  const { sendCode, verifyCode, signInWithProvider, configured } = useAuth();

  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  // The code step is open. It opens without a send too ('I already have a
  // code'), so it never depends on email delivery or the OTP rate limit.
  const [sent, setSent] = useState(false);
  // Whether a code went out this time - only then can the subtitle say so.
  const [codeRequested, setCodeRequested] = useState(false);
  // One field rather than a boolean per button: only one of these can be in
  // flight, and the others have to disable while it is.
  const [pending, setPending] = useState<OAuthProvider | 'email' | 'verify' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Opened because the API refused the session (lib/use-query.ts): say so,
  // once, instead of a "Welcome" to someone who was mid-task a second ago.
  const [expired] = useState(sessionEnded);

  // iOS: Apple's own button when the native flow is available. null while the
  // check runs, so the slot keeps its height instead of the list jumping.
  const [appleNative, setAppleNative] = useState<boolean | null>(
    Platform.OS === 'ios' && appleAuthModule() ? null : false,
  );
  useEffect(() => {
    if (appleNative !== null) return;
    let alive = true;
    void isAvailable().then((ok) => {
      if (alive) setAppleNative(ok);
    });
    return () => {
      alive = false;
    };
  }, [appleNative]);

  const emailValid = EMAIL.test(email.trim());
  // Mock mode (dev only) has no .env to fill in. Inline, so a release build
  // folds the check away.
  const notConfigured =
    !(__DEV__ && process.env.EXPO_PUBLIC_MOCK === '1') && (!configured || !apiConfigured);
  const busy = pending !== null;

  // Runs one sign-in step with `pending` set, and always clears it: a flow
  // that throws (no Custom Tabs browser on Android, a browser sheet already
  // open on iOS, a network failure) must not leave every button disabled.
  async function run(kind: NonNullable<typeof pending>, step: () => Promise<string | null>) {
    setPending(kind);
    setError(null);
    try {
      const err = await step();
      // A null result covers both success and "user backed out". Neither is
      // an error; on success the root gate navigates on its own.
      if (err) setError(err);
      return err;
    } catch (e) {
      const message =
        e instanceof Error && e.message ? e.message : 'Sign-in could not start. Try again.';
      setError(message);
      return message;
    } finally {
      setPending(null);
    }
  }

  async function withProvider(provider: OAuthProvider) {
    await run(provider, () => signInWithProvider(provider));
  }

  async function withAppleNative() {
    if (busy || notConfigured) return;
    await run('apple', () => signInWithAppleNative(() => signInWithProvider('apple')));
  }

  async function onSend() {
    if (!emailValid) return setError('Enter a valid email address.');
    // 'I already have a code' stays on screen next to this, so a failed send
    // (rate limit, mail outage) never strands someone who has a code.
    const err = await run('email', () => sendCode(email));
    if (err) return;
    setCodeRequested(true);
    setSent(true);
  }

  function openCodeStep() {
    setError(null);
    setCodeRequested(false);
    setSent(true);
  }

  async function onVerify() {
    if (code.trim().length < 6) return setError('Enter the 6-digit code.');
    // No navigation here: the root layout's guards move on as soon as the
    // session lands, so redirecting from both places would double-push.
    await run('verify', () => verifyCode(email, code));
  }

  const appleBrowserButton = (
    <Button
      key="apple"
      label={pending === 'apple' ? 'Opening Apple...' : 'Continue with Apple'}
      icon="logo-apple"
      size="lg"
      variant="secondary"
      busy={pending === 'apple'}
      disabled={notConfigured || (busy && pending !== 'apple')}
      onPress={() => void withProvider('apple')}
    />
  );

  let appleButton: ReactNode;
  if (Platform.OS !== 'ios' || appleNative === false) {
    appleButton = appleBrowserButton;
  } else if (appleNative === null) {
    appleButton = <View key="apple" style={styles.applePlaceholder} />;
  } else {
    appleButton = (
      <AppleNativeButton
        key="apple"
        pending={pending === 'apple'}
        disabled={notConfigured || (busy && pending !== 'apple')}
        onPress={() => void withAppleNative()}
      />
    );
  }

  const googleButton = (
    <ProviderButton
      key="google"
      icon={<GoogleMark />}
      label="Continue with Google"
      pendingLabel="Opening Google..."
      pending={pending === 'google'}
      disabled={notConfigured || (busy && pending !== 'google')}
      onPress={() => void withProvider('google')}
    />
  );

  // Apple first on iOS (its own platform's sign-in), Google first on Android.
  const providers = Platform.OS === 'ios' ? [appleButton, googleButton] : [googleButton, appleButton];

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      // `padding` on both platforms: app.json turns on edge-to-edge, which
      // disables Android's adjustResize, so the window no longer shrinks for
      // the keyboard on its own and the email field would sit under it.
      behavior="padding"
    >
      <ScrollView
        contentContainerStyle={[
          styles.body,
          { paddingTop: insets.top + spacing.xl, paddingBottom: insets.bottom + spacing.xl },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <Image
          source={require('@/assets/images/logo.png')}
          style={styles.logo}
          resizeMode="contain"
          accessibilityElementsHidden
          importantForAccessibility="no"
        />
        <Text style={styles.title} accessibilityRole="header">
          {expired ? 'Welcome back' : 'Welcome'}
        </Text>
        <Text style={styles.subtitle}>
          {sent
            ? codeRequested
              ? `We sent a 6-digit code to ${email.trim()}.`
              : `Enter the 6-digit code for ${email.trim()}.`
            : expired
              ? 'Your session ended. Sign in again to pick up where you left off.'
              : next
                ? 'Sign in or create an account. Your setup is saved.'
                : 'Sign in to manage your AI receptionist.'}
        </Text>

        {notConfigured && (
          <Notice tone="warning" style={styles.notice}>
            Not configured yet. Copy .env.example to .env and fill in the Supabase and API values.
          </Notice>
        )}

        {error && (
          <Notice tone="error" live style={styles.notice}>
            {error}
          </Notice>
        )}

        {sent ? (
          <>
            <CodeInput
              value={code}
              onChange={(v) => {
                setCode(v);
                setError(null);
              }}
              onSubmit={() => void onVerify()}
              editable={!busy}
            />
            <Button
              label="Verify and continue"
              size="lg"
              onPress={() => void onVerify()}
              busy={pending === 'verify'}
              disabled={busy && pending !== 'verify'}
              style={styles.action}
            />
            <TextLink
              label="Use a different email"
              tone="secondary"
              disabled={busy}
              style={styles.textLink}
              onPress={() => {
                setSent(false);
                setCode('');
                setError(null);
              }}
            />
          </>
        ) : (
          <>
            <View style={styles.providers}>{providers}</View>

            <View style={styles.divider}>
              <View style={styles.rule} />
              <Text style={styles.dividerText}>or</Text>
              <View style={styles.rule} />
            </View>

            <TextField
              label="Email"
              value={email}
              onChangeText={(v) => {
                setEmail(v);
                setError(null);
              }}
              placeholder="you@company.com"
              autoCapitalize="none"
              autoComplete="email"
              textContentType="emailAddress"
              keyboardType="email-address"
              returnKeyType="go"
              onSubmitEditing={() => void onSend()}
              editable={!busy}
            />
            <Button
              label="Continue with email"
              size="lg"
              onPress={() => void onSend()}
              busy={pending === 'email'}
              disabled={notConfigured || (busy && pending !== 'email')}
            />
            {/* The code step without sending anything: for a code already in
                the inbox, or when sending just failed. App Review signs in
                through this with its fixed code (the app embeds neither the
                review email nor the code). */}
            {emailValid && (
              <TextLink
                label="I already have a code"
                tone="secondary"
                disabled={notConfigured || busy}
                style={styles.textLink}
                onPress={openCodeStep}
              />
            )}
          </>
        )}

        <LegalNotice />

        {/* The way back into the funnel for someone who opened sign-in from it
            and changed their mind - on the code step too, so returning is one
            tap rather than two. Only shown when there is something to go back
            to: `router.back()` on a root screen does nothing. */}
        {router.canGoBack() && (
          <TextLink
            label="Back to setup"
            tone="secondary"
            disabled={busy}
            style={styles.textLink}
            onPress={() => router.back()}
          />
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/**
 * Apple's own button (HIG, 4.0). It has no disabled state, so the wrapper
 * dims it and the handler ignores presses while something else is in flight.
 * The wrapper is the accessible element, so VoiceOver hears the disabled and
 * busy state the dimming shows; the native button is hidden from it.
 */
function AppleNativeButton({
  pending,
  disabled,
  onPress,
}: {
  pending: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const mod = appleAuthModule();
  if (!mod) return null;
  const { AppleAuthenticationButton, AppleAuthenticationButtonType, AppleAuthenticationButtonStyle } =
    mod;
  const off = disabled || pending;
  return (
    <View
      accessible
      accessibilityRole="button"
      accessibilityLabel="Continue with Apple"
      accessibilityState={{ disabled: off, busy: pending }}
      onAccessibilityTap={off ? undefined : onPress}
      style={[styles.appleWrap, off && styles.dimmed]}
    >
      <AppleAuthenticationButton
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        buttonType={AppleAuthenticationButtonType.CONTINUE}
        buttonStyle={AppleAuthenticationButtonStyle.BLACK}
        cornerRadius={radius.control}
        style={styles.appleButton}
        onPress={off ? () => {} : onPress}
      />
      {pending ? (
        <View style={styles.appleSpinner} pointerEvents="none">
          <ActivityIndicator size="small" color={colors.white} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * The lg secondary Button's shape (components/ui.tsx) with a brand mark in
 * place of an icon-font glyph, which the shared Button cannot take. The
 * spinner replaces the mark rather than sitting beside it, so the label does
 * not shift when tapped.
 */
function ProviderButton({
  icon,
  label,
  pendingLabel,
  pending,
  disabled,
  onPress,
}: {
  icon: ReactNode;
  label: string;
  pendingLabel: string;
  pending: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const off = disabled || pending;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: off, busy: pending }}
      style={({ pressed: down }) => [
        styles.provider,
        down && !off && pressed,
        disabled && !pending && styles.dimmed,
      ]}
    >
      <View style={styles.providerMark}>
        {pending ? <ActivityIndicator size="small" color={colors.ink} /> : icon}
      </View>
      <Text style={styles.providerText}>{pending ? pendingLabel : label}</Text>
    </Pressable>
  );
}

/** Google's four-colour "G", as on the web dialog (AuthDialogBody.tsx). Brand colours are fixed. */
function GoogleMark() {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" accessibilityElementsHidden importantForAccessibility="no">
      <Path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <Path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <Path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <Path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </Svg>
  );
}

/** The 6-digit code field: large, centred, with the focus border the form fields use. */
function CodeInput({
  value,
  onChange,
  onSubmit,
  editable,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  editable: boolean;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      style={[styles.codeInput, focused && styles.inputFocused, !editable && styles.inputOff]}
      value={value}
      onChangeText={(v) => onChange(v.replace(/[^\d]/g, '').slice(0, 6))}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      placeholder="000000"
      placeholderTextColor={colors.textMuted}
      keyboardType="number-pad"
      inputMode="numeric"
      autoComplete="one-time-code"
      textContentType="oneTimeCode"
      autoFocus
      maxLength={6}
      returnKeyType="go"
      onSubmitEditing={onSubmit}
      editable={editable}
      maxFontSizeMultiplier={MAX_FONT_SCALE}
      accessibilityLabel="6-digit code"
    />
  );
}

/**
 * Accounts are created on this screen, so the documents they agree to are
 * named - and one tap away - before any of the three buttons is pressed. Each
 * document is its own link element so VoiceOver and a thumb can both reach it.
 * The links sit in the sentence at its line height and reach 44pt through
 * hitSlop: a 44pt box per link would pull the two lines of fine print apart.
 */
function LegalNotice() {
  return (
    <View style={styles.legal}>
      <Text style={styles.legalText}>By continuing you agree to our </Text>
      <LegalLink label="Terms of Service" url={TERMS_URL} />
      <Text style={styles.legalText}> and acknowledge our </Text>
      <LegalLink label="Privacy Policy" url={PRIVACY_URL} />
      <Text style={styles.legalText} accessibilityElementsHidden importantForAccessibility="no">
        .
      </Text>
    </View>
  );
}

const LEGAL_HIT_SLOP = { top: 12, bottom: 12, left: 4, right: 4 };

function LegalLink({ label, url }: { label: string; url: string }) {
  return (
    <Pressable
      onPress={() => void openInApp(url)}
      accessibilityRole="link"
      accessibilityLabel={label}
      hitSlop={LEGAL_HIT_SLOP}
      style={({ pressed: down }) => [styles.legalHit, down && pressed]}
    >
      <Text style={styles.legalLink}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  body: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  logo: {
    width: 56,
    height: 56,
    borderRadius: radius.md,
    alignSelf: 'center',
    marginBottom: spacing.lg,
  },
  title: {
    ...type.display,
    textAlign: 'center',
  },
  subtitle: {
    ...type.body,
    marginTop: spacing.sm,
    marginBottom: spacing.xl,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  providers: {
    gap: spacing.md,
  },
  // Minimums, so the slot keeps pace with the ProviderButton beside it at
  // large text sizes; Apple's own button is a fixed native view inside.
  applePlaceholder: {
    minHeight: control.lg,
  },
  appleWrap: {
    minHeight: control.lg,
  },
  appleButton: {
    width: '100%',
    height: control.lg,
  },
  appleSpinner: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  provider: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: control.lg,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  providerMark: {
    width: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  providerText: {
    ...type.button,
    flexShrink: 1,
    color: colors.ink,
  },
  dimmed: { opacity: 0.5 },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginVertical: spacing.lg,
  },
  rule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  dividerText: {
    ...type.eyebrow,
    color: colors.textSecondary,
  },
  // The stat size, medium weight, no lineHeight (a single-line iOS TextInput
  // sits off centre with one).
  codeInput: {
    minHeight: 56,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    fontFamily: fonts.medium,
    fontSize: type.stat.fontSize,
    letterSpacing: 8,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
    color: colors.text,
  },
  inputFocused: { borderColor: colors.ink },
  inputOff: { backgroundColor: colors.surfaceSubtle, color: colors.textSecondary },
  action: { marginTop: spacing.md },
  textLink: {
    alignSelf: 'center',
    marginTop: spacing.xs,
    paddingHorizontal: spacing.lg,
  },
  legal: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    rowGap: spacing.xs,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  legalText: {
    ...type.caption,
  },
  // 20pt tall with 12pt of slop above and below: a 44pt target.
  legalHit: {
    minHeight: 20,
    justifyContent: 'center',
  },
  legalLink: {
    ...type.caption,
    fontFamily: fonts.medium,
    color: colors.inkSoft,
    textDecorationLine: 'underline',
  },
  notice: { marginBottom: spacing.lg },
});
