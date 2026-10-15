import Constants from 'expo-constants';
import * as Haptics from 'expo-haptics';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';

import { PurchasesUnavailableNotice } from '@/components/paywall';
import { Screen } from '@/components/Screen';
import {
  Badge,
  Button,
  Card,
  ErrorState,
  ListRow,
  Notice,
  Row,
  SectionCard,
  SkeletonCard,
  StaleNotice,
} from '@/components/ui';
import { colors, fonts, spacing, type } from '@/constants/theme';
import { useAuth } from '@/context/AuthContext';
import { usePurchases } from '@/context/PurchaseContext';
import { api } from '@/lib/api';
import { formatPhone } from '@/lib/format';
import { dial, openInApp, PRIVACY_URL, SUPPORT_URL, TERMS_URL } from '@/lib/links';
import { isLiveStripe } from '@/lib/purchases';
import type { Account, BillingSnapshot } from '@/lib/types';
import { useQuery } from '@/lib/use-query';

/**
 * Settings.
 *
 * Deliberately no link or button to web billing, checkout, the billing portal
 * or the web dashboard (decision 1a): the app sells through the App Store and
 * Google Play, and a way out to a web purchase - even one step removed, like a
 * dashboard carrying an Upgrade button - is what store review rejects. An
 * account billed on the web is told so in plain text and nothing more.
 */
export default function SettingsScreen() {
  const router = useRouter();
  const { email, name, initials, signOut } = useAuth();
  const { data, error, loading, refreshing, refresh } = useQuery(() => api.account(), []);
  const purchases = usePurchases();
  const { refreshBilling } = purchases;
  const [billingTried, setBillingTried] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  // The provider loads billing once per session; a purchase made on the other
  // platform or on the web since then only shows up if Settings asks again.
  useFocusEffect(
    useCallback(() => {
      void refreshBilling().finally(() => setBillingTried(true));
    }, [refreshBilling]),
  );

  const onRefresh = useCallback(() => {
    void Promise.all([refresh(), refreshBilling()]);
  }, [refresh, refreshBilling]);

  function confirmSignOut() {
    if (signingOut) return;
    Alert.alert('Sign out?', 'You will need to sign in again to see your calls.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => void runSignOut() },
    ]);
  }

  async function runSignOut() {
    setSigningOut(true);
    try {
      // Bounded inside AuthContext: it never hangs, online or not.
      await signOut();
    } finally {
      setSigningOut(false);
    }
  }

  if (loading) {
    return (
      <Screen title="Settings">
        <View style={styles.body}>
          <SkeletonCard lines={1} />
          <SkeletonCard lines={4} />
          <SkeletonCard lines={3} />
        </View>
      </Screen>
    );
  }

  // Only a missing payload is a dead end. A failed background refetch still has
  // the last good account to show, with the notice below saying so.
  if (!data) {
    return (
      <Screen title="Settings">
        <ErrorState message={error ?? 'Could not load your account.'} onRetry={refresh} />
      </Screen>
    );
  }

  return (
    <Screen title="Settings" onRefresh={onRefresh} refreshing={refreshing}>
      <View style={styles.body}>
        {error ? <StaleNotice message={error} onRetry={refresh} /> : null}

        <Card>
          <View
            style={styles.identity}
            accessible
            accessibilityLabel={`${data.profile.fullName || name}, ${email}`}
          >
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{initials}</Text>
            </View>
            <View style={styles.flex}>
              <Text style={styles.name} numberOfLines={1}>
                {data.profile.fullName || name}
              </Text>
              <Text style={styles.email} numberOfLines={1}>
                {email}
              </Text>
            </View>
          </View>
        </Card>

        <SubscriptionCard
          account={data}
          billing={purchases.billing}
          billingPending={!purchases.billing && (purchases.billingLoading || !billingTried)}
          onRetryBilling={() => void refreshBilling()}
          onRestored={() => Promise.all([refresh(), refreshBilling()]).then(() => undefined)}
        />

        <SectionCard title="Your details">
          <ListRow
            icon="business-outline"
            label="Business profile"
            value={data.profile.company || 'Not set'}
            onPress={() => router.push('/settings/profile')}
          />
          <ListRow
            icon="notifications-outline"
            label="Alerts"
            value={alertsSummary(data.notifications.email, data.notifications.sms)}
            onPress={() => router.push('/settings/alerts')}
            divided
          />
          <ListRow
            icon="calendar-outline"
            label="Connected calendars"
            onPress={() => router.push('/calendar/connections')}
            divided
          />
          <ListRow
            icon="phone-portrait-outline"
            label="Signed-in devices"
            onPress={() => router.push('/settings/devices')}
            divided
          />
        </SectionCard>

        {data.numbers.length > 0 && (
          <SectionCard title="Your numbers">
            {data.numbers.map((n, i) => (
              <ListRow
                key={n.id}
                icon="call-outline"
                label={formatPhone(n.e164)}
                trailing="none"
                onPress={() => void dial(n.e164)}
                accessibilityHint="Calls this number"
                divided={i > 0}
              />
            ))}
          </SectionCard>
        )}

        <SectionCard title="Help and legal">
          <ListRow
            icon="help-circle-outline"
            label="Help and support"
            trailing="external"
            onPress={() => void openInApp(SUPPORT_URL)}
          />
          <ListRow
            icon="document-text-outline"
            label="Privacy policy"
            trailing="external"
            onPress={() => void openInApp(PRIVACY_URL)}
            divided
          />
          <ListRow
            icon="reader-outline"
            label="Terms of service"
            trailing="external"
            onPress={() => void openInApp(TERMS_URL)}
            divided
          />
        </SectionCard>

        <SectionCard title="Account">
          <ListRow
            icon="log-out-outline"
            label="Sign out"
            trailing="none"
            busy={signingOut}
            onPress={confirmSignOut}
          />
          <ListRow
            icon="trash-outline"
            label="Delete account"
            destructive
            onPress={() => router.push('/settings/delete-account')}
            divided
          />
        </SectionCard>

        <Text style={styles.version}>Version {Constants.expoConfig?.version ?? '1.0.0'}</Text>
      </View>
    </Screen>
  );
}

function alertsSummary(email: boolean, sms: boolean): string {
  if (email && sms) return 'Email and text';
  if (email) return 'Email only';
  if (sms) return 'Text only';
  return 'Off';
}

// ── Subscription ─────────────────────────────────────────────────────────────

/** Who bills this account, from this phone's point of view. */
type BilledBy = 'this-store' | 'other-store' | 'stripe' | 'comp' | 'none';

/**
 * A store subscription that still exists in the store: the server's STORE_LIVE
 * (lib/dashboard/account-deletion.ts). past_due is billing retry and paused is
 * a Play pause - both are still the user's to manage there.
 */
const STORE_LIVE = ['active', 'trialing', 'past_due', 'paused'];

function billedBy(billing: BillingSnapshot, platform: 'apple' | 'google'): BilledBy {
  // The LIVE STRIPE rule, not `active`: a past_due web subscription is still
  // billed on the web and must never be offered a store purchase on top.
  if (isLiveStripe(billing)) return 'stripe';
  if (billing.provider === 'comp' && billing.active) return 'comp';
  if ((billing.provider === 'apple' || billing.provider === 'google') && STORE_LIVE.includes(billing.status ?? '')) {
    return billing.provider === platform ? 'this-store' : 'other-store';
  }
  return 'none';
}

const storeLabel = (provider: 'apple' | 'google') => (provider === 'apple' ? 'App Store' : 'Google Play');
/** "in the App Store" but "in Google Play". */
const inStore = (provider: 'apple' | 'google') => (provider === 'apple' ? 'in the App Store' : 'in Google Play');

function formatDate(iso: string | null): string {
  const ms = Date.parse(iso ?? '');
  if (!Number.isFinite(ms)) return '';
  return new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric' }).format(
    new Date(ms),
  );
}

function statusLine(billing: BillingSnapshot, kind: BilledBy): { text: string; warn: boolean } | null {
  if (kind === 'none') return { text: 'No active subscription.', warn: false };
  const status = billing.status ?? '';
  const store = billing.provider === 'apple' || billing.provider === 'google' ? billing.provider : null;
  if (store && status === 'past_due') {
    return { text: `Payment issue - update your payment method ${inStore(store)}.`, warn: true };
  }
  // Neutral on purpose, with no pointer to the web account (decision 1a).
  if (kind === 'stripe' && ['past_due', 'unpaid', 'incomplete'].includes(status)) {
    return { text: 'There is a payment issue with this subscription.', warn: true };
  }
  const date = formatDate(billing.currentPeriodEnd);
  if (status === 'paused') return { text: date ? `Paused until ${date}.` : 'Paused.', warn: false };
  if (!date) return null;
  return { text: billing.cancelAtPeriodEnd ? `Ends ${date}` : `Renews ${date}`, warn: false };
}

/** 0 means no cap - Infinity does not survive JSON. */
const limit = (n: number) => (n === 0 ? 'Unlimited' : n.toLocaleString('en-US'));

function SubscriptionCard({
  account,
  billing,
  billingPending,
  onRetryBilling,
  onRestored,
}: {
  account: Account;
  billing: BillingSnapshot | null;
  billingPending: boolean;
  onRetryBilling: () => void;
  onRestored: () => Promise<void>;
}) {
  const router = useRouter();
  const { platformProvider, available, unavailableReason, busy, restore, manage } = usePurchases();

  if (!billing) {
    if (billingPending) return <SkeletonCard lines={4} />;
    return (
      <SectionCard title="Subscription">
        <Text style={styles.cardText}>Could not load your subscription.</Text>
        <Button
          label="Try again"
          variant="secondary"
          size="pill"
          onPress={onRetryBilling}
          style={styles.inlineButton}
        />
      </SectionCard>
    );
  }

  const kind = billedBy(billing, platformProvider);
  const status = statusLine(billing, kind);
  const plan = account.plan;
  const planName =
    kind === 'none'
      ? null
      : plan?.active
        ? plan.name
        : billing.plan
          ? billing.plan.charAt(0).toUpperCase() + billing.plan.slice(1)
          : null;
  const billedThrough =
    kind === 'stripe'
      ? 'Your web account'
      : kind === 'comp'
        ? 'Complimentary'
        : billing.provider === 'apple' || billing.provider === 'google'
          ? storeLabel(billing.provider)
          : null;
  const note =
    kind === 'other-store'
      ? platformProvider === 'apple'
        ? 'Managed on Google Play.'
        : 'Managed on the App Store.'
      : kind === 'stripe'
        ? 'Your subscription is billed through your web account.'
        : kind === 'comp'
          ? 'Complimentary account.'
          : null;

  async function onRestore() {
    const result = await restore();
    // Every failure has already been alerted by the purchase layer.
    if (!result.restored) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await onRestored();
    Alert.alert('Purchases restored', 'Your subscription is active on this account.');
  }

  return (
    <SectionCard
      title="Subscription"
      action={planName ? <Badge label={planName} tone={status?.warn ? 'warning' : 'neutral'} /> : null}
    >
      {status ? (
        status.warn ? (
          <Notice tone="warning" live style={styles.statusNotice}>
            {status.text}
          </Notice>
        ) : (
          <Text style={styles.status} accessibilityLiveRegion="polite">
            {status.text}
          </Text>
        )
      ) : null}

      {billedThrough ? <Row label="Billed through" value={billedThrough} /> : null}
      {plan?.active && kind !== 'none' ? (
        <>
          <Row
            label="Phone numbers"
            value={
              plan.limits.phoneNumbers === 0
                ? `${plan.numbersUsed} (unlimited)`
                : `${plan.numbersUsed} of ${plan.limits.phoneNumbers}`
            }
          />
          <Row label="Receptionists" value={String(plan.assistantsUsed)} />
          <Row label="Minutes included" value={limit(plan.limits.minutesIncluded)} />
          <Row label="Concurrent calls" value={limit(plan.limits.concurrentCalls)} />
        </>
      ) : null}

      {note ? <Text style={styles.cardText}>{note}</Text> : null}

      {kind === 'none' ? (
        <Button
          label="Choose a plan"
          onPress={() => router.push('/paywall')}
          style={styles.choose}
        />
      ) : null}

      <View style={styles.cardActions}>
        {kind === 'this-store' ? (
          <>
            <ListRow
              icon="swap-horizontal-outline"
              label="Change plan"
              onPress={() => router.push('/paywall')}
              divided
            />
            <ListRow
              icon="card-outline"
              label="Manage subscription"
              value={storeLabel(platformProvider)}
              trailing="external"
              onPress={() => void manage()}
              divided
            />
          </>
        ) : null}
        {available ? (
          <ListRow
            icon="refresh-outline"
            label="Restore purchases"
            trailing="none"
            busy={busy === 'restore'}
            disabled={busy !== null}
            onPress={() => void onRestore()}
            divided
          />
        ) : kind === 'this-store' || kind === 'none' ? (
          <View style={styles.unavailable}>
            <PurchasesUnavailableNotice reason={unavailableReason} />
          </View>
        ) : null}
      </View>
    </SectionCard>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.lg, gap: spacing.md },
  flex: { flex: 1 },
  identity: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.ink,
  },
  avatarText: { ...type.button, color: colors.white },
  name: { ...type.body, fontFamily: fonts.semibold },
  email: { ...type.footnote, marginTop: 2 },
  status: { ...type.bodySm, marginBottom: spacing.xs },
  statusNotice: { marginBottom: spacing.sm },
  cardText: { ...type.bodySm, color: colors.textSecondary, marginTop: spacing.sm },
  inlineButton: { alignSelf: 'flex-start', marginTop: spacing.md },
  choose: { marginTop: spacing.md },
  cardActions: { marginTop: spacing.sm },
  unavailable: { marginTop: spacing.md },
  version: { ...type.caption, textAlign: 'center', marginTop: spacing.xs },
});
