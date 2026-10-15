import type { BillingCycle } from '@/lib/types';

import type {
  PlanKey,
  SkuRef,
  StoreAdapter,
  StoreProduct,
  StorePurchaseResult,
  StoreTransaction,
} from './types';
import { perMonthDisplay } from './types';

/**
 * DEV ONLY (EXPO_PUBLIC_IAP_MOCK=1): a store that always answers, for the
 * simulator and Expo Go, where neither StoreKit nor RevenueCat exists.
 *
 * Never imported statically: lib/purchases/index.ts reaches it through an
 * inline `if (__DEV__ && process.env.EXPO_PUBLIC_IAP_MOCK === '1') require`,
 * which a release build folds away with this file. The string below is a
 * sentinel for the release-bundle grep in the acceptance checks; if it ever
 * shows up in an export, the guard has been broken:
 * 'arn-iap-mock-2c91'.
 *
 *   EXPO_PUBLIC_IAP_MOCK_OUTCOME  purchased (default) | cancelled | pending |
 *                                 already-owned | failed | confirming
 *
 * The transaction token is `mock-jws:<productId>`, which the mock server's
 * apple/verify route accepts in place of a StoreKit JWS; on an Android-shaped
 * run the provider sends the product id as `debugProductId` to google/sync.
 * `restore()` returns the last mock purchase of this app run.
 */

export const MOCK_SENTINEL = 'arn-iap-mock-2c91';

const OUTCOME = process.env.EXPO_PUBLIC_IAP_MOCK_OUTCOME ?? 'purchased';
const PURCHASE_DELAY_MS = 800;

/** Store-looking prices, VAT-inclusive like a real storefront's. */
const PRICES: Record<`${PlanKey}:${BillingCycle}`, { displayPrice: string; price: number }> = {
  'solo:monthly': { displayPrice: '€119.99', price: 119.99 },
  'solo:annual': { displayPrice: '€1,199.99', price: 1199.99 },
  'team:monthly': { displayPrice: '€359.99', price: 359.99 },
  'team:annual': { displayPrice: '€3,599.99', price: 3599.99 },
};

/** Matches the mock server's `providerRef` for an Apple row, so a launch reconcile is a no-op after a purchase. */
const MOCK_ORIGINAL_TRANSACTION_ID = '2000000912345678';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createMockAdapter(): StoreAdapter {
  let refs: SkuRef[] = [];
  let last: StoreTransaction | null = null;
  const listeners = new Set<(tx: StoreTransaction) => void>();

  function txFor(product: SkuRef): StoreTransaction {
    return {
      id: `mock-tx-${Date.now()}`,
      productId: product.productId,
      token: `mock-jws:${product.productId}`,
      originalTransactionId: MOCK_ORIGINAL_TRANSACTION_ID,
      expiresAt: Date.now() + (product.cycle === 'annual' ? 365 : 30) * 24 * 60 * 60 * 1000,
      appAccountToken: null,
      raw: { mock: MOCK_SENTINEL },
    };
  }

  return {
    kind: 'mock',
    async init(skus) {
      refs = skus;
    },
    async products() {
      await delay(300);
      return refs.map((ref) => {
        const price = PRICES[`${ref.plan}:${ref.cycle}`];
        const product: StoreProduct = {
          ...ref,
          displayPrice: price.displayPrice,
          price: price.price,
          currency: 'EUR',
          period: ref.cycle === 'annual' ? 'year' : 'month',
          perMonthDisplay: null,
        };
        product.perMonthDisplay = perMonthDisplay(product);
        return product;
      });
    },
    async purchase(product): Promise<StorePurchaseResult> {
      await delay(PURCHASE_DELAY_MS);
      switch (OUTCOME) {
        case 'cancelled':
          return { status: 'cancelled' };
        case 'pending':
          return { status: 'pending' };
        case 'already-owned':
          return { status: 'already-owned' };
        case 'confirming':
          return { status: 'confirming' };
        case 'failed':
          return { status: 'failed', message: 'The mock store refused the purchase.' };
        default: {
          last = txFor(product);
          return { status: 'transaction', tx: last };
        }
      }
    },
    async finish() {},
    async owned() {
      return last ? [last] : [];
    },
    async restore() {
      await delay(400);
      return last ? [last] : [];
    },
    async manage() {},
    onTransaction(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    async identify() {},
    async reset() {
      last = null;
    },
  };
}
