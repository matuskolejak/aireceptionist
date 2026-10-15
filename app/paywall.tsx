import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  AiConsent,
  AiProcessingNotice,
  PaywallLegalLinks,
  PurchasesUnavailableNotice,
  SubscriptionDisclosure,
  TermsConsent,
} from '@/components/paywall';
import { CycleToggle, PlanCard } from '@/components/plans';
import { Button, ErrorState, IconButton, Notice, Skeleton, SkeletonCard } from '@/components/ui';
import { colors, fonts, radius, spacing, type } from '@/constants/theme';
import { usePurchases } from '@/context/PurchaseContext';
import { api } from '@/lib/api';
import { isLiveStripe, type PlanKey } from '@/lib/purchases';
import { usePaywall } from '@/lib/purchases/use-paywall';
import type { BillingCycle, BillingSnapshot, Catalog } from '@/lib/types';
import { useQuery } from '@/lib/use-query';

type Reason = 'number' | 'minutes' | 'plan';

const HEADINGS: Record<Reason, string> = {
  number: 'Subscribe to get a phone number',
  minutes: 'Need more minutes?',
  plan: 'Plans',
};

/** "14 Oct 2026". The app's copy is English, so the date is too. */
function shortDate(iso: string): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** 'Renews 14 Oct 2026' / 'Ends 14 Oct 2026', or null when the store gave no date. */
function periodLine(billing: BillingSnapshot | null): string | null {
  if (!billing?.currentPeriodEnd) return null;
  const date = shortDate(billing.currentPeriodEnd);
  if (!date) return null;
  return billing.cancelAtPeriodEnd ? `Ends ${date}` : `Renews ${date}`;
}

/**
 * The paywall: buy, change, restore or manage a subscription, for every
 * signed-in user (setup finished or not). A modal route with its own close
 * button; the funnel's plan step shares its building blocks (usePaywall and
 * components/paywall.tsx) so the two cannot drift on the rules.
 *
 * Prices are the STORE's (`displayPrice`, the user's storefront currency),
 * never the catalog's Stripe figures - a signed-in user never sees those
 * (decision 1f). An account billed anywhere but this store gets plain text and
 * no purchase control of any kind: no button, no web link (decision 1a).
 *
 * `?reason=number|minutes|plan` only picks the heading.
 */
export default function PaywallScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { reason } = useLocalSearchParams<{ reason?: string }>();
  // Compared by value, not `reason in HEADINGS`: a link's `?reason=toString`
  // would find the prototype's function and render it as a child.
  const heading = HEADINGS[reason === 'number' || reason === 'minutes' ? reason : 'plan'];

  const purchases = usePurchases();
  const { billing, refreshBilling } = purchases;
  const catalog = useQuery<Catalog>(() => api.catalog(), []);
  const plans = catalog.data?.plans ?? [];

  const pw = usePaywall({
    plans,
    context: 'pricing',
    signedIn: true,
    initialPlan: billing?.plan ?? undefined,
    initialCycle: billing?.cycle ?? undefined,
  });
  const { setPicked, setCycle } = pw;

  // Open on what the account holds, so 'Current plan' is the card in view. The
  // snapshot can land after the first render (it is re-read below); once the
  // user has picked something themselves it is left alone.
  const touched = useRef(false);
  const seeded = useRef(Boolean(billing?.plan));
  useEffect(() => {
    if (seeded.current || touched.current || !billing?.plan) return;
    seeded.current = true;
    setPicked(billing.plan);
    if (billing.cycle) setCycle(billing.cycle);
  }, [billing, setPicked, setCycle]);

  // The paywall is where a plan decision is made, so it reads billing fresh
  // rather than trusting a snapshot from launch.
  useEffect(() => {
    void refreshBilling();
  }, [refreshBilling]);

  const [retrying, setRetrying] = useState(false);
  // A first purchase starts the AI processing (a number, a live agent), so it
  // asks for the same explicit permission the funnel's plan step does
  // (5.1.2(i)). A plan change only moves a receptionist that is already live.
  const [aiAccepted, setAiAccepted] = useState(false);

  const close = () => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    // Opened as the first screen (a link): "back" is the user's home, which
    // is the tabs once setup is done and the funnel before that.
    const allowed = navigation.getState()?.routeNames ?? [];
    router.replace(allowed.includes('(tabs)') ? '/' : '/onboarding');
  };

  const pick = (plan: PlanKey) => {
    touched.current = true;
    setPicked(plan);
  };
  const pickCycle = (cycle: BillingCycle) => {
    touched.current = true;
    setCycle(cycle);
  };

  const onBuy = async () => {
    const result = await pw.buy();
    // The provider raises every alert and the success haptic; 'pending' and
    // 'confirming' leave their message on the sheet (pw.pendingMessage).
    if (result.outcome === 'purchased') close();
  };

  const onRestore = async () => {
    const result = await pw.restore();
    if (result.restored) close();
  };

  // A purchase the store or the server has not finished with: Subscribe is
  // off while the note is up, and this re-reads billing. Active means done.
  const onCheckAgain = async () => {
    if (await pw.checkAgain()) close();
  };

  const onRetryPrices = async () => {
    setRetrying(true);
    try {
      await purchases.retryProducts();
    } finally {
      setRetrying(false);
    }
  };

  // The plan this account holds, including a past_due / unpaid web
  // subscription (LIVE STRIPE), which `active` alone does not cover.
  const heldPlan = billing && (billing.active || isLiveStripe(billing)) ? billing.plan : null;
  const heldCycle = heldPlan ? billing?.cycle : null;

  const { mode } = pw;
  // Picking a card only means something where a purchase can follow.
  const selectable = mode === 'buy' || mode === 'change' || mode === 'current';
  const pickedPlan = plans.find((p) => p.id === pw.picked) ?? null;

  let body: ReactNode;
  if (!catalog.data) {
    body = catalog.loading ? (
      // The shape of what is coming: the cycle toggle and two plan cards.
      <View accessible accessibilityLabel="Loading">
        <Skeleton height={44} radius={radius.pill} style={styles.skeletonToggle} />
        <SkeletonCard lines={5} style={styles.skeletonCard} />
        <SkeletonCard lines={5} style={styles.skeletonCard} />
      </View>
    ) : (
      <ErrorState
        message={catalog.error ?? 'Could not load the plans.'}
        onRetry={() => void catalog.refresh()}
      />
    );
  } else {
    body = (
      <>
        <CycleToggle
          cycle={pw.cycle}
          onChange={pickCycle}
          terms={catalog.data.terms}
          disabledCycles={pw.disabledCycles}
          products={{
            monthly: purchases.productFor(pw.picked, 'monthly'),
            annual: purchases.productFor(pw.picked, 'annual'),
          }}
        />

        <View accessibilityRole={selectable ? 'radiogroup' : undefined}>
          {plans.map((plan) => {
            const key = plan.id as PlanKey;
            return (
              <PlanCard
                key={plan.id}
                plan={plan}
                cycle={pw.cycle}
                product={purchases.productFor(key, pw.cycle)}
                priceSource={pw.priceSourceFor(key, pw.cycle)}
                variant="full"
                selected={selectable && pw.picked === key}
                // A plan held without a cycle (a complimentary account) is
                // current whichever cycle is on screen.
                badge={
                  heldPlan === key && (!heldCycle || heldCycle === pw.cycle)
                    ? 'Current plan'
                    : undefined
                }
                onPress={selectable ? () => pick(key) : undefined}
              />
            );
          })}
        </View>

        {mode === 'managed-elsewhere' ? (
          // Decision 1a: where it is billed, as text. No button, no link.
          <View style={styles.section}>
            <Text style={styles.status}>{pw.statusText}</Text>
            <PaywallLegalLinks onRestore={onRestore} restoreBusy={pw.busy === 'restore'} />
          </View>
        ) : mode === 'unavailable' ? (
          <View style={styles.section}>
            <PurchasesUnavailableNotice reason={purchases.unavailableReason} />
            <PaywallLegalLinks />
          </View>
        ) : mode === 'current' ? (
          <View style={styles.section}>
            <View
              accessible
              accessibilityLabel={[pw.statusText, periodLine(billing)].filter(Boolean).join(' ')}
              style={styles.statusBlock}
            >
              <Text style={styles.status}>{pw.statusText}</Text>
              {periodLine(billing) ? (
                <Text style={styles.statusSub}>{periodLine(billing)}</Text>
              ) : null}
            </View>
            <Button
              label="Manage subscription"
              size="lg"
              variant="secondary"
              onPress={() => void purchases.manage()}
            />
            <PaywallLegalLinks onRestore={onRestore} restoreBusy={pw.busy === 'restore'} />
          </View>
        ) : pw.priceSource === 'error' ? (
          // Never an endless "Loading price...": the provider gives up after
          // 15s and says so, and the retry lives here.
          <View style={styles.section}>
            <Notice
              tone="error"
              live
              action={
                <Button
                  label="Try again"
                  variant="secondary"
                  size="pill"
                  onPress={() => void onRetryPrices()}
                  busy={retrying}
                  style={styles.inlineAction}
                />
              }
            >
              {purchases.loadError ?? 'Prices could not be loaded.'}
            </Notice>
            <PaywallLegalLinks onRestore={onRestore} restoreBusy={pw.busy === 'restore'} />
          </View>
        ) : (
          // buy / change
          <View style={styles.section}>
            {pickedPlan ? (
              <SubscriptionDisclosure plan={pickedPlan} cycle={pw.cycle} product={pw.product} />
            ) : null}
            {pw.mode === 'buy' ? (
              <AiConsent accepted={aiAccepted} onChange={setAiAccepted} />
            ) : (
              <AiProcessingNotice />
            )}
            <TermsConsent accepted={pw.accepted} onChange={pw.setAccepted} />
            {pw.pendingMessage ? (
              <Notice
                tone="neutral"
                live
                action={
                  <Button
                    label="Check again"
                    variant="secondary"
                    size="pill"
                    onPress={() => void onCheckAgain()}
                    busy={pw.checking}
                    style={styles.inlineAction}
                  />
                }
              >
                {pw.pendingMessage}
              </Notice>
            ) : null}
            <Button
              label={pw.ctaLabel}
              size="lg"
              onPress={() => void onBuy()}
              disabled={pw.ctaDisabled || (pw.mode === 'buy' && !aiAccepted)}
              busy={pw.busy === 'purchase'}
            />
            <PaywallLegalLinks onRestore={onRestore} restoreBusy={pw.busy === 'restore'} />
          </View>
        )}
      </>
    );
  }

  // iOS presents this as a sheet that already sits below the status bar, but
  // only over another screen: opened first (a link on a cold start) it is a
  // plain full-screen page. Android always slides it up full screen.
  const sheet = Platform.OS === 'ios' && router.canGoBack();

  return (
    <View style={styles.root}>
      <View style={[styles.topBar, { paddingTop: sheet ? spacing.sm : insets.top }]}>
        <IconButton icon="close" label="Close" tone="plain" onPress={close} />
      </View>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]}
      >
        <Text style={styles.heading} accessibilityRole="header">
          {heading}
        </Text>
        {body}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  topBar: {
    flexDirection: 'row',
    paddingHorizontal: spacing.sm,
  },
  content: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xs,
  },
  heading: {
    ...type.display,
    marginBottom: spacing.lg,
  },
  section: {
    gap: spacing.lg,
    marginTop: spacing.sm,
  },
  statusBlock: { gap: 2 },
  status: {
    ...type.body,
    fontFamily: fonts.medium,
  },
  statusSub: {
    ...type.bodySm,
    color: colors.textSecondary,
  },
  inlineAction: { alignSelf: 'flex-start' },
  skeletonToggle: { marginBottom: spacing.lg },
  skeletonCard: { marginBottom: spacing.md },
});
