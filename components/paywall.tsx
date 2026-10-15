import { Fragment, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/Icon';
import { Notice, pressed, TextLink } from '@/components/ui';
import { colors, control, fonts, spacing, type } from '@/constants/theme';
import { aiConsentGiven, setAiConsentGiven } from '@/lib/ai-consent';
import { APPLE_EULA_URL, openInApp, PRIVACY_URL, TERMS_URL } from '@/lib/links';
import type { StoreProduct, UnavailableReason } from '@/lib/purchases';
import type { BillingCycle, OnboardingPlan } from '@/lib/types';

/**
 * The paywall's building blocks, shared by the funnel's plan step and the
 * paywall route: the subscription disclosure App Review checks against
 * 3.1.2 / Play's policy, the two consents (Terms; third-party AI processing),
 * the legal links, and the "no store here" notice.
 *
 * Every tappable thing here is its own element with a 44pt hit area and a
 * role: the document links are NOT nested inside a checkbox's label, which
 * would make them unreachable (funnel/A11Y-1).
 */

/**
 * Apple 3.1.2 / Play: title, length, price and renewal, then how it is
 * charged and cancelled. ONE Text so VoiceOver reads it whole. No refund
 * promise and no money-back guarantee (decision 1g).
 */
export function SubscriptionDisclosure({
  plan,
  cycle,
  product,
}: {
  plan: OnboardingPlan;
  cycle: BillingCycle;
  product: StoreProduct | null;
}) {
  if (!product) return null;
  const length = cycle === 'annual' ? '1 year' : '1 month';
  const title = `${plan.name} ${cycle === 'annual' ? 'Annual' : 'Monthly'} - ${length}, ${product.displayPrice} per ${product.period}, renews automatically.`;
  const terms =
    Platform.OS === 'android'
      ? 'Payment is charged to your Google Play account when you confirm the purchase. The subscription renews automatically at the same price unless you cancel before the end of the current period. Manage or cancel any time in Google Play > Payments & subscriptions > Subscriptions.'
      : 'Payment is charged to your Apple Account when you confirm the purchase. The subscription renews automatically at the same price unless you cancel at least 24 hours before the end of the current period. Manage or cancel any time in Settings > Apple Account > Subscriptions.';
  return (
    <Text style={styles.disclosure}>
      <Text style={styles.disclosureTitle}>{title}</Text>
      {'\n'}
      {terms}
    </Text>
  );
}

/**
 * The processors named, in plain words, with the policy one tap away
 * (store/STORE-6). `compact` is the one-line form for once consent is held:
 * the paragraph has been read, and repeating it above every notes box made
 * the app feel like it was asking again.
 */
export function AiProcessingNotice({ compact }: { compact?: boolean }) {
  const link = (
    <Text
      style={styles.inlineLink}
      accessibilityRole="link"
      onPress={() => void openInApp(PRIVACY_URL)}
    >
      {compact ? 'How your data is used' : 'Privacy Policy'}
    </Text>
  );
  if (compact) {
    return (
      <Text style={styles.noticeCompact}>
        Processed by third-party AI services (ElevenLabs, Google Gemini). {link}
      </Text>
    );
  }
  return (
    <Text style={styles.notice}>
      Your receptionist runs on third-party AI services - ElevenLabs for the voice and Google
      Gemini for understanding. Your business details, what you teach it and your calls are
      processed by them to answer your phone. {link}
    </Text>
  );
}

function CheckRow({
  checked,
  onToggle,
  label,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      style={({ pressed: down }) => [styles.checkRow, down && pressed]}
    >
      <View style={[styles.box, checked && styles.boxOn]}>
        {checked ? <Icon name="checkmark" size={13} color={colors.white} /> : null}
      </View>
      <Text style={styles.checkText}>{label}</Text>
    </Pressable>
  );
}

function LinkButton({
  label,
  onPress,
  role = 'link',
  busy,
}: {
  label: string;
  onPress: () => void;
  role?: 'link' | 'button';
  busy?: boolean;
}) {
  return (
    <TextLink
      label={busy ? 'Restoring...' : label}
      onPress={onPress}
      role={role}
      tone="secondary"
      disabled={busy}
      accessibilityLabel={label}
      style={styles.link}
    />
  );
}

/**
 * Explicit permission before any data goes to a third-party AI (5.1.2(i)).
 * Unticked by default. Once given it is remembered on the device
 * (lib/ai-consent.ts): later the notice alone renders and `accepted` is
 * reported as true, so the funnel and the teach sheet do not ask twice.
 */
export function AiConsent({
  accepted,
  onChange,
}: {
  accepted: boolean;
  onChange: (accepted: boolean) => void;
}) {
  const [stored, setStored] = useState<boolean | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    let alive = true;
    void aiConsentGiven().then((given) => {
      if (!alive) return;
      setStored(given);
      if (given) onChangeRef.current(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const toggle = () => {
    const next = !accepted;
    onChange(next);
    if (next) void setAiConsentGiven();
  };

  // Held already: one line, the policy a tap away, no box.
  if (stored === true) return <AiProcessingNotice compact />;
  return (
    <View style={styles.block}>
      <AiProcessingNotice />
      <CheckRow
        checked={accepted}
        onToggle={toggle}
        label="I agree that my business details, what I teach my receptionist and my calls are processed by these AI services."
      />
    </View>
  );
}

/** The Terms consent a NEW purchase needs (decision 1d). Restore never asks. */
export function TermsConsent({
  accepted,
  onChange,
}: {
  accepted: boolean;
  onChange: (accepted: boolean) => void;
}) {
  return (
    <View style={styles.block}>
      <CheckRow
        checked={accepted}
        onToggle={() => onChange(!accepted)}
        label="I agree to the Terms of Service and Privacy Policy"
      />
      <View style={styles.linkRow}>
        <LinkButton label="Terms of Service" onPress={() => void openInApp(TERMS_URL)} />
        <Text style={styles.dot} accessibilityElementsHidden importantForAccessibility="no">·</Text>
        <LinkButton label="Privacy Policy" onPress={() => void openInApp(PRIVACY_URL)} />
      </View>
    </View>
  );
}

/** Privacy · Terms · Terms of Use (EULA, iOS) · Restore purchases. */
export function PaywallLegalLinks({
  onRestore,
  restoreBusy,
}: {
  onRestore?: () => void;
  restoreBusy?: boolean;
}) {
  const items: { label: string; onPress: () => void; role?: 'link' | 'button'; busy?: boolean }[] = [
    { label: 'Privacy Policy', onPress: () => void openInApp(PRIVACY_URL) },
    { label: 'Terms of Service', onPress: () => void openInApp(TERMS_URL) },
  ];
  // Apple's standard EULA is what an iOS subscription paywall links (decision 1c).
  if (Platform.OS === 'ios') {
    items.push({ label: 'Terms of Use (EULA)', onPress: () => void openInApp(APPLE_EULA_URL) });
  }
  if (onRestore) {
    items.push({ label: 'Restore purchases', onPress: onRestore, role: 'button', busy: restoreBusy });
  }
  return (
    <View style={styles.legalRow}>
      {items.map((item, i) => (
        <Fragment key={item.label}>
          {i > 0 ? <Text style={styles.dot} accessibilityElementsHidden importantForAccessibility="no">·</Text> : null}
          <LinkButton label={item.label} onPress={item.onPress} role={item.role} busy={item.busy} />
        </Fragment>
      ))}
    </View>
  );
}

/** Why there is no Subscribe here. `reason` from `usePurchases().unavailableReason`. */
export function PurchasesUnavailableNotice({ reason }: { reason: UnavailableReason }) {
  const message =
    reason === 'expo-go'
      ? 'Purchases need the installed app from the App Store or Google Play.'
      : 'Purchases are not available right now. Please try again later.';
  return (
    <Notice tone="neutral" live>
      {message}
    </Notice>
  );
}

const styles = StyleSheet.create({
  disclosure: {
    ...type.footnote,
  },
  disclosureTitle: {
    fontFamily: fonts.medium,
    color: colors.text,
  },
  notice: {
    ...type.bodySm,
    color: colors.textSecondary,
  },
  noticeCompact: {
    ...type.footnote,
  },
  inlineLink: {
    fontFamily: fonts.medium,
    color: colors.ink,
    textDecorationLine: 'underline',
  },
  block: {
    gap: spacing.sm,
  },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: control.md,
    paddingVertical: spacing.xs,
  },
  box: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: {
    backgroundColor: colors.ink,
    borderColor: colors.ink,
  },
  checkText: {
    ...type.bodySm,
    flex: 1,
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginLeft: 22 + spacing.md,
  },
  legalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  link: {
    paddingHorizontal: spacing.xs,
  },
  dot: {
    ...type.caption,
    color: colors.textMuted,
  },
});
