// Type-only imports: erased at compile time, so this file still never loads
// expo-iap itself. The module object arrives through native.ts.
import type { ProductSubscription, Purchase, PurchaseIOS } from 'expo-iap';
import { Linking } from 'react-native';

import { APPLE_SUBSCRIPTIONS_URL } from '@/lib/links';

import type { ExpoIapModule } from './native';
import type {
  SkuRef,
  StoreAdapter,
  StoreProduct,
  StorePurchaseResult,
  StoreTransaction,
} from './types';
import { perMonthDisplay } from './types';

/**
 * StoreKit 2 through expo-iap.
 *
 * One pair of listeners lives for the whole session, registered at init and
 * not per purchase: StoreKit re-delivers every unfinished transaction on
 * launch (a crash between purchase and verify, an Ask to Buy approval that
 * came through while the app was closed, a renewal) and a listener that only
 * exists while `purchase()` is awaiting would miss all of them. A delivery
 * that answers the purchase in flight resolves it; every other delivery goes
 * to `onTransaction`, where the provider verifies and finishes it.
 */

/** How long after the store sheet has closed a purchase may wait for its transaction. */
const PURCHASE_TIMEOUT_MS = 120_000;

/** StoreKit dates arrive as ms since the epoch; normalise in case one comes back in seconds. */
function toMs(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return value < 1e12 ? value * 1000 : value;
}

function toTx(p: PurchaseIOS): StoreTransaction {
  return {
    id: p.transactionId || p.id,
    productId: p.productId,
    token: p.purchaseToken ?? '',
    originalTransactionId: p.originalTransactionIdentifierIOS ?? null,
    expiresAt: toMs(p.expirationDateIOS),
    appAccountToken: p.appAccountToken ?? null,
    raw: p,
  };
}

export function createIosAdapter(iap: ExpoIapModule): StoreAdapter {
  let refs: SkuRef[] = [];
  let connected = false;
  /** The `initConnection` in flight, shared by every `init()` call until it settles. */
  let connecting: Promise<void> | null = null;
  const listeners = new Set<(tx: StoreTransaction) => void>();
  let subscriptions: { remove: () => void }[] = [];
  /** The purchase awaiting its transaction, if any. Settled exactly once. */
  let inflight: { settle: (result: StorePurchaseResult) => void } | null = null;

  const ours = (productId: string) => refs.some((r) => r.productId === productId);

  function mapError(error: unknown): StorePurchaseResult {
    const e = error as { code?: string; message?: string } | null;
    switch (e?.code) {
      case iap.ErrorCode.UserCancelled:
        return { status: 'cancelled' };
      case iap.ErrorCode.DeferredPayment:
      case iap.ErrorCode.Pending:
        return { status: 'pending' };
      case iap.ErrorCode.AlreadyOwned:
        return { status: 'already-owned' };
      default:
        return { status: 'failed', message: e?.message ?? '' };
    }
  }

  function listen(): void {
    if (subscriptions.length > 0) return;
    subscriptions = [
      iap.purchaseUpdatedListener((purchase: Purchase) => {
        // Anything not ours is another app's noise on a shared sandbox account.
        if (!ours(purchase.productId)) return;
        const tx = toTx(purchase as PurchaseIOS);
        // One subscription group: a downgrade or a crossgrade to another
        // duration can deliver the CURRENT product's transaction rather than
        // the requested sku, so any of our four skus answers the purchase.
        if (inflight) {
          inflight.settle({ status: 'transaction', tx });
          return;
        }
        listeners.forEach((cb) => cb(tx));
      }),
      iap.purchaseErrorListener((error) => {
        if (inflight) inflight.settle(mapError(error));
      }),
    ];
  }

  async function init(skus: SkuRef[]): Promise<void> {
    refs = skus;
    if (connected) return;
    // One connection at a time: a retry while the first `initConnection` is
    // still pending joins it instead of stacking a second pair of listeners
    // that the first call's failure would then tear down.
    if (!connecting) {
      connecting = (async () => {
        // Listeners first: connecting starts StoreKit's transaction stream,
        // and the unfinished transactions it replays at once must not fall
        // on the floor between `initConnection` resolving and a listener
        // being added.
        listen();
        try {
          await iap.initConnection();
          connected = true;
        } catch (error) {
          subscriptions.forEach((s) => s.remove());
          subscriptions = [];
          throw error;
        } finally {
          connecting = null;
        }
      })();
    }
    await connecting;
  }

  async function products(): Promise<StoreProduct[]> {
    if (refs.length === 0) return [];
    const list = (await iap.fetchProducts({
      skus: refs.map((r) => r.productId),
      type: 'subs',
    })) as ProductSubscription[] | null;
    const out: StoreProduct[] = [];
    for (const ref of refs) {
      const p = list?.find((x) => x.id === ref.productId);
      if (!p || !p.displayPrice) continue;
      const product: StoreProduct = {
        ...ref,
        displayPrice: p.displayPrice,
        price: typeof p.price === 'number' ? p.price : 0,
        currency: p.currency ?? '',
        period: ref.cycle === 'annual' ? 'year' : 'month',
        perMonthDisplay: null,
      };
      product.perMonthDisplay = perMonthDisplay(product);
      out.push(product);
    }
    return out;
  }

  function purchase(
    product: StoreProduct,
    { userId }: { userId: string; changeFrom?: string | null },
  ): Promise<StorePurchaseResult> {
    if (inflight) {
      return Promise.resolve({ status: 'failed', message: 'A purchase is already in progress.' });
    }
    return new Promise<StorePurchaseResult>((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const settle = (result: StorePurchaseResult) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        inflight = null;
        resolve(result);
      };
      inflight = { settle };
      iap
        .requestPurchase({
          // The Supabase user id as appAccountToken: it must be a UUID, and it
          // is what ties the transaction to this account on the server.
          request: { apple: { sku: product.productId, appAccountToken: userId } },
          type: 'subs',
        })
        .then(() => {
          // The sheet has closed. The transaction normally lands through the
          // listener at once; if nothing arrives, hand over to the persistent
          // listener (which replays the stored intent) rather than hang.
          if (!done) timer = setTimeout(() => settle({ status: 'confirming' }), PURCHASE_TIMEOUT_MS);
        })
        .catch((error: unknown) => settle(mapError(error)));
    });
  }

  async function finish(tx: StoreTransaction): Promise<void> {
    await iap.finishTransaction({ purchase: tx.raw as Purchase, isConsumable: false });
  }

  async function owned(): Promise<StoreTransaction[]> {
    const list = await iap.getAvailablePurchases({
      onlyIncludeActiveItemsIOS: true,
      alsoPublishToEventListenerIOS: false,
    });
    const now = Date.now();
    return list
      .filter((p) => ours(p.productId))
      .map((p) => toTx(p as PurchaseIOS))
      .filter((tx) => tx.expiresAt !== null && tx.expiresAt > now);
  }

  async function restore(): Promise<StoreTransaction[]> {
    await iap.restorePurchases();
    return owned();
  }

  async function manage(): Promise<void> {
    try {
      await iap.deepLinkToSubscriptions();
    } catch {
      await Linking.openURL(APPLE_SUBSCRIPTIONS_URL);
    }
  }

  function onTransaction(cb: (tx: StoreTransaction) => void): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }

  return {
    kind: 'ios',
    init,
    products,
    purchase,
    finish,
    owned,
    restore,
    manage,
    onTransaction,
    identify: async () => {},
    reset: async () => {},
  };
}
