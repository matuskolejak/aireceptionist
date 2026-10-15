import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  CONFIRMING_MESSAGE,
  PENDING_MESSAGE,
  usePurchases,
  type PurchaseResult,
  type RestoreResult,
} from '@/context/PurchaseContext';
import type { BillingCycle, OnboardingPlan } from '@/lib/types';

import { isLiveStripe, type PlanKey, type PriceSource, type StoreProduct } from './types';

export type { PriceSource } from './types';

/**
 * What the paywall is for this account right now.
 *
 *   buy                no subscription - Subscribe
 *   change             subscribed here, a different plan or cycle is picked - Switch
 *   current            subscribed here, the picked plan+cycle is the one held
 *   managed-elsewhere  billed on the web (LIVE STRIPE), complimentary, or on the
 *                      other store - text only, never a purchase (decision 1a/1b)
 *   signed-out         the guest funnel - prices, no purchase
 *   unavailable        no store here (Expo Go, web, a build without its key)
 */
export type PaywallMode =
  | 'buy'
  | 'change'
  | 'current'
  | 'managed-elsewhere'
  | 'signed-out'
  | 'unavailable';

export interface Paywall {
  cycle: BillingCycle;
  setCycle: (cycle: BillingCycle) => void;
  picked: PlanKey;
  setPicked: (plan: PlanKey) => void;
  /** The Terms consent. Required for buy and change, never for restore. */
  accepted: boolean;
  setAccepted: (accepted: boolean) => void;
  /** The store product for the picked plan+cycle, or null. */
  product: StoreProduct | null;
  priceSource: PriceSource;
  priceSourceFor: (plan: PlanKey, cycle: BillingCycle) => PriceSource;
  /** A cycle neither plan can be bought on here (both products missing). */
  disabledCycles: BillingCycle[];
  mode: PaywallMode;
  statusText: string | null;
  ctaLabel: string;
  ctaDisabled: boolean;
  /** Subscribe / Switch, or a retry when prices failed to load. */
  buy: () => Promise<PurchaseResult>;
  restore: () => Promise<RestoreResult>;
  busy: 'purchase' | 'restore' | null;
  /** Copy for an outcome that is not done yet ('pending', 'confirming'). The CTA is off while it is set. */
  pendingMessage: string | null;
  /**
   * Re-read billing while a purchase is waiting on the store or the server.
   * Resolves true once the subscription is active, which also clears
   * `pendingMessage`; false leaves the note (and the disabled CTA) in place.
   */
  checkAgain: () => Promise<boolean>;
  checking: boolean;
}

const CYCLES: BillingCycle[] = ['monthly', 'annual'];

/**
 * The one hook both paywalls use: the funnel's plan step (context
 * 'onboarding') and the paywall route (context 'pricing'). It owns the
 * picked plan and cycle, the consent, and turns the provider's state into
 * a mode, a price source per card and a CTA - so the two screens only lay
 * things out and cannot drift on the rules.
 *
 * Default pick is Solo, the cheaper plan: the web FAQ steers unsure buyers
 * there, and preselecting the pricier one on a paywall is the kind of thing
 * App Review reads as steering.
 */
export function usePaywall({
  plans,
  context,
  initialPlan = 'solo',
  initialCycle = 'monthly',
  signedIn,
}: {
  plans: OnboardingPlan[];
  context: 'onboarding' | 'pricing';
  initialPlan?: PlanKey;
  initialCycle?: BillingCycle;
  /** From `useAuth().session` - the hook must not guess. */
  signedIn: boolean;
}): Paywall {
  const purchases = usePurchases();
  const {
    available,
    ready,
    loadError,
    productFor,
    billing,
    platformProvider,
    storeName,
    busy,
    retryProducts,
  } = purchases;

  const [cycle, setCycle] = useState<BillingCycle>(initialCycle);
  const [picked, setPicked] = useState<PlanKey>(initialPlan);
  const [accepted, setAccepted] = useState(false);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const planName = (key: PlanKey) =>
    plans.find((p) => p.id === key)?.name ?? key.charAt(0).toUpperCase() + key.slice(1);

  // Decision 1f: a signed-in user never sees a catalog (Stripe, EUR excl.
  // VAT) figure - it is the wrong number in the wrong currency. A guest may,
  // clearly labelled, when the store could not be asked. A product the store
  // was asked about and does not sell is 'missing' for everyone: an
  // indicative price there would flip to 'Not available' on sign-in, and
  // `disabledCycles` already greys that cycle for the guest.
  const priceSourceFor = useCallback(
    (plan: PlanKey, c: BillingCycle): PriceSource => {
      if (productFor(plan, c)) return 'store';
      const guest = signedIn === false;
      if (!available) return guest ? 'indicative' : 'unavailable';
      if (loadError) return guest ? 'indicative' : 'error';
      if (!ready) return 'loading';
      return 'missing';
    },
    [productFor, signedIn, available, loadError, ready],
  );

  const product = productFor(picked, cycle);
  const priceSource = priceSourceFor(picked, cycle);

  const disabledCycles = useMemo(
    () =>
      available && ready && !loadError
        ? CYCLES.filter((c) => plans.every((p) => !productFor(p.id as PlanKey, c)))
        : [],
    [available, ready, loadError, plans, productFor],
  );

  // A cycle the store cannot sell at all must not stay picked.
  useEffect(() => {
    if (disabledCycles.includes(cycle)) {
      const other = CYCLES.find((c) => !disabledCycles.includes(c));
      if (other) setCycle(other);
    }
  }, [cycle, disabledCycles]);

  let mode: PaywallMode;
  let statusText: string | null = null;
  if (!signedIn) {
    mode = 'signed-out';
  } else if (isLiveStripe(billing)) {
    mode = 'managed-elsewhere';
    statusText = 'Your subscription is billed through your web account.';
  } else if (billing?.active && billing.provider === 'comp') {
    mode = 'managed-elsewhere';
    statusText = 'Complimentary account.';
  } else if (billing?.active && billing.provider && billing.provider !== platformProvider) {
    mode = 'managed-elsewhere';
    statusText = platformProvider === 'apple' ? 'Managed on Google Play.' : 'Managed on the App Store.';
  } else if (billing?.active && billing.provider === platformProvider) {
    if (billing.plan === picked && billing.cycle === cycle) {
      mode = 'current';
      statusText = 'Your current plan.';
    } else {
      mode = available ? 'change' : 'unavailable';
    }
  } else {
    mode = available ? 'buy' : 'unavailable';
  }

  let ctaLabel: string;
  let ctaDisabled = true;
  const canBuy = mode === 'buy' || mode === 'change';
  if (mode === 'signed-out') {
    ctaLabel = 'Sign in to subscribe';
  } else if (mode === 'current') {
    ctaLabel = 'Current plan';
  } else if (mode === 'managed-elsewhere') {
    ctaLabel = 'Billed elsewhere';
  } else if (priceSource === 'error') {
    ctaLabel = 'Prices unavailable - try again';
    ctaDisabled = false;
  } else if (priceSource === 'loading') {
    ctaLabel = 'Loading price...';
  } else if (priceSource === 'missing') {
    ctaLabel = `Not available in the ${storeName} right now`;
  } else if (mode === 'unavailable' || !product) {
    ctaLabel = 'Purchases unavailable';
  } else if (mode === 'change') {
    ctaLabel = `Switch to ${planName(picked)} - ${product.displayPrice} / ${product.period}`;
    ctaDisabled = !accepted;
  } else {
    ctaLabel = `Subscribe - ${product.displayPrice} / ${product.period}`;
    ctaDisabled = !accepted;
  }
  // A purchase the store or the server has not finished with is still a
  // purchase: a live Subscribe under "it will finish on its own" invites a
  // second one. `checkAgain` is the way forward while the note is up.
  if (busy || checking || pendingMessage) ctaDisabled = true;

  const buy = useCallback(async (): Promise<PurchaseResult> => {
    if (priceSource === 'error') {
      await retryProducts();
      return { outcome: 'failed' };
    }
    if (!canBuy || !product || !accepted) return { outcome: 'blocked' };
    setPendingMessage(null);
    const result = await purchases.purchase(picked, cycle, { acceptedTerms: true, context });
    if (result.outcome === 'pending') setPendingMessage(result.message ?? PENDING_MESSAGE);
    else if (result.outcome === 'confirming') setPendingMessage(result.message ?? CONFIRMING_MESSAGE);
    return result;
  }, [priceSource, retryProducts, canBuy, product, accepted, purchases, picked, cycle, context]);

  const restore = useCallback(async (): Promise<RestoreResult> => {
    setPendingMessage(null);
    return purchases.restore();
  }, [purchases]);

  const checkAgain = useCallback(async (): Promise<boolean> => {
    setChecking(true);
    try {
      const snapshot = await purchases.refreshBilling();
      const active = Boolean(snapshot?.active);
      if (active) setPendingMessage(null);
      return active;
    } finally {
      setChecking(false);
    }
  }, [purchases]);

  return {
    cycle,
    setCycle,
    picked,
    setPicked,
    accepted,
    setAccepted,
    product,
    priceSource,
    priceSourceFor,
    disabledCycles,
    mode,
    statusText,
    ctaLabel,
    ctaDisabled,
    buy,
    restore,
    busy,
    pendingMessage,
    checkAgain,
    checking,
  };
}
