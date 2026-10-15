// Type-only imports: erased at compile time, so this file still never loads
// react-native-purchases itself. The SDK class arrives through native.ts.
import type { CustomerInfo, PurchasesPackage } from 'react-native-purchases';
import { Linking } from 'react-native';

import { PLAY_SUBSCRIPTIONS_URL } from '@/lib/links';
import type { BillingSnapshot } from '@/lib/types';

import type { RevenueCatModule } from './native';
import type {
  SkuRef,
  StoreAdapter,
  StoreProduct,
  StorePurchaseResult,
  StoreTransaction,
} from './types';
import { perMonthDisplay } from './types';

/**
 * Google Play through RevenueCat 10.x.
 *
 * Configured anonymously at init so a guest sees prices, then `logIn` with the
 * Supabase user id once there is a session and `logOut` on sign-out. Nothing
 * here decides entitlement: after a purchase the provider asks the server,
 * which reads the customer from RevenueCat itself (`/billing/google/sync`).
 *
 * A "transaction" on this platform is an active entitlement, keyed on the
 * RevenueCat app user id (what `billing.providerRef` holds for a Google row).
 * There is nothing to finish: RevenueCat acknowledges Play purchases.
 */

/** The subscription id half of a RevenueCat Play product id ('solo:monthly' -> 'solo'). */
const subscriptionId = (productId: string) => productId.split(':')[0];

export function createAndroidAdapter(Purchases: RevenueCatModule, apiKey: string): StoreAdapter {
  let refs: SkuRef[] = [];
  let configured = false;
  /** productId -> package, from the last `products()`. */
  const packages = new Map<string, PurchasesPackage>();
  const listeners = new Set<(tx: StoreTransaction) => void>();

  const ours = (productId: string) =>
    refs.some((r) => subscriptionId(r.productId) === subscriptionId(productId));

  function txsFrom(info: CustomerInfo): StoreTransaction[] {
    return Object.values(info.entitlements.active).map((e) => {
      // With base plans RevenueCat reports the subscription and the plan
      // separately; join them into the catalog's 'solo:monthly' form.
      const productId =
        e.productPlanIdentifier && !e.productIdentifier.includes(':')
          ? `${e.productIdentifier}:${e.productPlanIdentifier}`
          : e.productIdentifier;
      return {
        id: `${info.originalAppUserId}:${productId}`,
        productId,
        token: '',
        originalTransactionId: info.originalAppUserId,
        expiresAt: e.expirationDate ? Date.parse(e.expirationDate) : null,
        appAccountToken: null,
        raw: e,
      };
    });
  }

  function mapError(error: unknown): StorePurchaseResult {
    const e = error as { code?: unknown; userCancelled?: boolean | null; message?: string } | null;
    const code = e?.code == null ? '' : String(e.code);
    const codes = Purchases.PURCHASES_ERROR_CODE;
    if (e?.userCancelled || code === codes.PURCHASE_CANCELLED_ERROR) return { status: 'cancelled' };
    if (code === codes.PRODUCT_ALREADY_PURCHASED_ERROR) return { status: 'already-owned' };
    if (code === codes.PAYMENT_PENDING_ERROR) return { status: 'pending' };
    return { status: 'failed', message: e?.message ?? '' };
  }

  async function init(skus: SkuRef[]): Promise<void> {
    refs = skus;
    if (configured) return;
    if (!(await Purchases.isConfigured())) {
      if (__DEV__) await Purchases.setLogLevel(Purchases.LOG_LEVEL.DEBUG);
      Purchases.configure({ apiKey });
    }
    configured = true;
    // Fires on every customer refresh, including a renewal or an Ask-to-Buy
    // style pending purchase resolving while the app is open. The provider
    // treats each as a re-delivery and syncs only when billing is behind.
    Purchases.addCustomerInfoUpdateListener((info) => {
      for (const tx of txsFrom(info)) {
        if (ours(tx.productId)) listeners.forEach((cb) => cb(tx));
      }
    });
  }

  async function products(): Promise<StoreProduct[]> {
    if (refs.length === 0) return [];
    const offerings = await Purchases.getOfferings();
    const offering = offerings.current ?? offerings.all.default ?? null;
    const available = offering?.availablePackages ?? [];
    packages.clear();
    const out: StoreProduct[] = [];
    for (const ref of refs) {
      const pkg = available.find(
        (p) =>
          (ref.packageId != null && p.identifier === ref.packageId) ||
          p.product.identifier === ref.productId,
      );
      if (!pkg?.product.priceString) continue;
      packages.set(ref.productId, pkg);
      const product: StoreProduct = {
        ...ref,
        displayPrice: pkg.product.priceString,
        price: pkg.product.price,
        currency: pkg.product.currencyCode,
        period: ref.cycle === 'annual' ? 'year' : 'month',
        perMonthDisplay: null,
      };
      product.perMonthDisplay = perMonthDisplay(product);
      out.push(product);
    }
    return out;
  }

  async function purchase(
    product: StoreProduct,
    { userId, changeFrom }: { userId: string; changeFrom?: string | null },
  ): Promise<StorePurchaseResult> {
    const pkg = packages.get(product.productId);
    if (!pkg) {
      return {
        status: 'failed',
        message: 'No subscription packages available. Please try again later.',
      };
    }
    try {
      // The server reads the RevenueCat customer by this user id. The sign-in
      // `identify` swallows its errors, so a purchase made while still
      // anonymous would land on a customer the server never asks about.
      if ((await Purchases.getAppUserID()) !== userId) await Purchases.logIn(userId);
    } catch {
      return { status: 'failed', message: "Couldn't reach the store. Check your connection and try again." };
    }
    try {
      // `oldProductIdentifier` is the Play SUBSCRIPTION id ('solo'), not
      // 'solo:monthly': RevenueCat's own paywall code passes
      // `activePlayStoreSubscription.productIdentifier` there, and a base
      // plan change inside the same subscription passes the same id.
      const change = changeFrom
        ? {
            oldProductIdentifier: subscriptionId(changeFrom),
            replacementMode: Purchases.STORE_REPLACEMENT_MODE.WITH_TIME_PRORATION,
          }
        : null;
      const { customerInfo } = await Purchases.purchasePackage(pkg, null, change);
      const active = txsFrom(customerInfo).find(
        (tx) => subscriptionId(tx.productId) === subscriptionId(product.productId),
      );
      return {
        status: 'transaction',
        tx: {
          id: `${customerInfo.originalAppUserId}:${product.productId}:${Date.now()}`,
          productId: product.productId,
          token: '',
          originalTransactionId: customerInfo.originalAppUserId,
          expiresAt: active?.expiresAt ?? null,
          appAccountToken: null,
          raw: customerInfo,
        },
      };
    } catch (error) {
      return mapError(error);
    }
  }

  async function owned(): Promise<StoreTransaction[]> {
    if (!configured) return [];
    const info = await Purchases.getCustomerInfo();
    return txsFrom(info).filter((tx) => ours(tx.productId));
  }

  async function restore(): Promise<StoreTransaction[]> {
    if (!configured) return [];
    const info = await Purchases.restorePurchases();
    return txsFrom(info).filter((tx) => ours(tx.productId));
  }

  async function manage(billing: BillingSnapshot | null): Promise<void> {
    let url: string | null = null;
    if (configured) {
      try {
        url = (await Purchases.getCustomerInfo()).managementURL;
      } catch {
        // Fall through to the store's own page.
      }
    }
    // The Play subscription id is the bare plan id ('solo' of 'solo:monthly'),
    // so the plan names it - but only when Play is what bills this account.
    const sku = billing?.provider === 'google' ? (billing.plan ?? undefined) : undefined;
    await Linking.openURL(url ?? PLAY_SUBSCRIPTIONS_URL(sku));
  }

  function onTransaction(cb: (tx: StoreTransaction) => void): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }

  async function identify(userId: string): Promise<void> {
    if (!configured) return;
    await Purchases.logIn(userId);
  }

  async function reset(): Promise<void> {
    if (!configured) return;
    try {
      await Purchases.logOut();
    } catch {
      // Already anonymous (LOG_OUT_ANONYMOUS_USER_ERROR): nothing to undo.
    }
  }

  return {
    kind: 'android',
    init,
    products,
    purchase,
    finish: async () => {},
    owned,
    restore,
    manage,
    onTransaction,
    identify,
    reset,
  };
}
