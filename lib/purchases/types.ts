import type { BillingCycle, BillingSnapshot } from '@/lib/types';

/**
 * The shapes the purchase layer speaks in, shared by the three store adapters
 * (expo-iap on iOS, RevenueCat on Android, the __DEV__ mock) and the
 * PurchaseProvider that drives them.
 *
 * An adapter knows how to talk to ONE store. It never decides whether the user
 * is subscribed - that is the server's call, made on the JWS (iOS) or on the
 * RevenueCat customer (Android) - so nothing here carries an "isPro" flag.
 */

export type PlanKey = 'solo' | 'team';

export type StoreKind = 'ios' | 'android' | 'mock';

/** Why purchases cannot run here. `null` means they can. */
export type UnavailableReason = 'expo-go' | 'web' | 'no-key' | null;

/**
 * One product the catalog names for this platform, before the store has been
 * asked about it. The ids come from `plans[].storeProductIds`; the app never
 * hardcodes a sku.
 */
export interface SkuRef {
  plan: PlanKey;
  cycle: BillingCycle;
  /** App Store product id, or the RevenueCat product id ('solo:monthly') on Android. */
  productId: string;
  /** RevenueCat package id in the default offering ('solo_monthly'). Android only. */
  packageId?: string;
}

/**
 * A product the store has priced. `displayPrice` is the store's own localized
 * string and is the ONLY figure a paywall shows as the price; `price` and
 * `currency` exist for the subordinate per-month line and for sorting.
 */
export interface StoreProduct extends SkuRef {
  displayPrice: string;
  price: number;
  /** ISO 4217, as the store reports it. */
  currency: string;
  period: 'month' | 'year';
  /** The annual price divided by twelve, formatted. Subordinate text only. Null on monthly. */
  perMonthDisplay: string | null;
}

export type PurchaseOutcome =
  | 'purchased'
  | 'cancelled'
  | 'pending'
  | 'failed'
  | 'confirming'
  | 'blocked';

/**
 * A store transaction as the provider handles it: verified with the server
 * first, finished (iOS) only after a 2xx or a terminal 409/400.
 */
export interface StoreTransaction {
  /** The store's transaction id - the dedupe key while a transaction is being processed. */
  id: string;
  productId: string;
  /** iOS: the StoreKit 2 signed transaction (JWS). Android: unused - the server asks RevenueCat. */
  token: string;
  /** Apple originalTransactionId; the RevenueCat app user id on Android. Compared with `billing.providerRef`. */
  originalTransactionId: string | null;
  /** Milliseconds since the epoch, when the store reports one. */
  expiresAt: number | null;
  /** The appAccountToken the transaction was bought with (iOS), when the store reports it. */
  appAccountToken: string | null;
  /** The store's own object, handed back to `finish()`. */
  raw: unknown;
}

/** What the store said to a purchase request, before the server has seen anything. */
export type StorePurchaseResult =
  | { status: 'transaction'; tx: StoreTransaction }
  | { status: 'cancelled' }
  | { status: 'pending' }
  | { status: 'already-owned' }
  | { status: 'confirming' }
  | { status: 'failed'; message: string };

export interface StoreAdapter {
  readonly kind: StoreKind;
  /** Connect to the store and remember which skus are ours. Safe to call again. */
  init(skus: SkuRef[]): Promise<void>;
  /** Price our skus. A sku the store does not sell is simply absent. */
  products(): Promise<StoreProduct[]>;
  /**
   * Start a purchase. `userId` becomes the appAccountToken (iOS). `changeFrom`
   * is the Play subscription id the user already holds, for an Android product
   * change; iOS handles a change inside the subscription group by itself.
   */
  purchase(
    product: StoreProduct,
    opts: { userId: string; changeFrom?: string | null },
  ): Promise<StorePurchaseResult>;
  /** Tell the store the transaction is done. Only after the server has it. */
  finish(tx: StoreTransaction): Promise<void>;
  /** Our active subscriptions on this store account. */
  owned(): Promise<StoreTransaction[]>;
  /** Ask the store to sync, then `owned()`. */
  restore(): Promise<StoreTransaction[]>;
  /** Open the store's subscription management screen. */
  manage(billing: BillingSnapshot | null): Promise<void>;
  /**
   * Transactions the store delivers outside `purchase()`: a re-delivered
   * unfinished one, an Ask to Buy approval, a renewal. Returns the unsubscribe.
   */
  onTransaction(cb: (tx: StoreTransaction) => void): () => void;
  /** Tie the store account to the signed-in user (RevenueCat logIn). No-op on iOS. */
  identify(userId: string): Promise<void>;
  /** Undo `identify` on sign-out (RevenueCat logOut). No-op on iOS. */
  reset(): Promise<void>;
}

/**
 * Store-style currency formatting for the app's own figures: grouping and two
 * decimals ("€1,009.80"), 'en' locale like the rest of the copy. Falls back to
 * a plain "1009.80 EUR" if the runtime's Intl has no data for the currency.
 */
export function formatCurrency(amount: number, currency: string): string {
  const code = currency.toUpperCase();
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${code}`;
  }
}

/**
 * Where the figure on a plan card comes from - the one thing a paywall must
 * get right. Only 'store' is a price the user will be charged; 'indicative'
 * is the catalog's Stripe figure and is shown to guests only, labelled.
 */
export type PriceSource = 'store' | 'loading' | 'indicative' | 'missing' | 'error' | 'unavailable';

/**
 * LIVE STRIPE: billed on the web, so no store purchase may be offered. Word
 * for word the server's guard (lib/types.ts BillingSnapshot): provider
 * 'stripe' AND status in (active, trialing, past_due, unpaid, incomplete) AND
 * an unexpired period. `billing.active` alone is NOT this rule - it is false
 * for past_due, and a past_due Stripe customer must still not buy twice.
 */
export function isLiveStripe(billing: BillingSnapshot | null, now: number = Date.now()): boolean {
  return (
    billing !== null &&
    billing.provider === 'stripe' &&
    ['active', 'trialing', 'past_due', 'unpaid', 'incomplete'].includes(billing.status ?? '') &&
    (billing.currentPeriodEnd === null || Date.parse(billing.currentPeriodEnd) > now)
  );
}

/** The subordinate "about X / month" figure of an annual product. */
export function perMonthDisplay(product: Pick<StoreProduct, 'cycle' | 'price' | 'currency'>): string | null {
  if (product.cycle !== 'annual' || !(product.price > 0) || !product.currency) return null;
  return formatCurrency(product.price / 12, product.currency);
}
