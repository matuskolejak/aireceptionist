import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Alert, Platform } from 'react-native';

import { useAuth } from '@/context/AuthContext';
import { api, ApiError } from '@/lib/api';
import { APPLE_SUBSCRIPTIONS_URL, openExternal, PLAY_SUBSCRIPTIONS_URL } from '@/lib/links';
import {
  createAdapter,
  isLiveStripe,
  PLATFORM_PROVIDER,
  STORE_NAME,
  unavailableReason,
  type PlanKey,
  type PurchaseOutcome,
  type SkuRef,
  type StoreAdapter,
  type StoreProduct,
  type StoreTransaction,
  type UnavailableReason,
} from '@/lib/purchases';
import type {
  BillingCycle,
  BillingSnapshot,
  OnboardingPlan,
  PurchaseContext as PurchaseReason,
} from '@/lib/types';

/**
 * The purchase layer the paywall screens build on.
 *
 * Every store transaction is VERIFIED WITH THE SERVER BEFORE IT IS FINISHED:
 * `/billing/apple/verify` (the StoreKit 2 JWS) or `/billing/google/sync`
 * (the server reads the RevenueCat customer) answers with the account's
 * BillingSnapshot, and only a 2xx - or a terminal 409/400 that the server's
 * own notification path owns - lets the transaction be finished. A transient
 * failure, or no session, leaves it unfinished: StoreKit re-delivers it on
 * the next launch and the persistent listener picks it up. Nothing here ever
 * asserts a subscription to the server; the reference app's `syncProStatus`
 * POST is the one thing deliberately not ported.
 *
 * Alerts are raised HERE, with the reference copy, so screens only handle
 * success and navigation. The rule by context: a purchase the user just
 * started alerts; a restore alerts at most once per run; a launch reconcile
 * or a re-delivered transaction never alerts - a second app user on a device
 * whose Apple Account owns someone else's subscription would otherwise get
 * one on every launch.
 */

export interface PurchaseResult {
  outcome: PurchaseOutcome;
  billing?: BillingSnapshot;
  message?: string;
}

export interface RestoreResult {
  restored: boolean;
  billing?: BillingSnapshot;
}

export interface PurchasesValue {
  /** False in Expo Go, on the web, or on an Android build without its RevenueCat key. */
  available: boolean;
  unavailableReason: UnavailableReason;
  /** Products are priced. Never an endless "Loading price...": `loadError` is set within 15s otherwise. */
  ready: boolean;
  loadError: string | null;
  retryProducts: () => Promise<void>;
  products: StoreProduct[];
  /** Null while loading, on error, or when the store does not sell this plan+cycle. */
  productFor: (plan: PlanKey, cycle: BillingCycle) => StoreProduct | null;
  storeName: 'App Store' | 'Google Play';
  platformProvider: 'apple' | 'google';
  busy: 'purchase' | 'restore' | null;
  /** A transaction exists that the server has not confirmed yet. */
  confirming: boolean;
  billing: BillingSnapshot | null;
  billingLoading: boolean;
  /** Re-reads billing. Resolves null on failure and keeps the last snapshot - never demotes locally. */
  refreshBilling: () => Promise<BillingSnapshot | null>;
  purchase: (
    plan: PlanKey,
    cycle: BillingCycle,
    opts: { acceptedTerms: true; context: 'onboarding' | 'pricing' },
  ) => Promise<PurchaseResult>;
  /** No terms needed (decision 1d): the server records nothing new for a restore. */
  restore: () => Promise<RestoreResult>;
  /** Open the store's subscription management screen. */
  manage: () => Promise<void>;
}

export const NO_PACKAGES_MESSAGE = 'No plans are available to buy right now. Please try again later.';
export const PENDING_MESSAGE =
  'Waiting for approval. Your subscription starts as soon as it is approved.';
export const CONFIRMING_MESSAGE =
  'We could not confirm your purchase yet. It will finish automatically next time you open the app.';
const NOT_AVAILABLE_MESSAGE = 'Purchases not available. Please try again later.';
const GENERIC_MESSAGE = 'Something went wrong. Please try again.';
const NO_SUBSCRIPTION_MESSAGE = 'We could not find an active subscription for this account.';
const STRIPE_ACTIVE_MESSAGE =
  Platform.OS === 'android'
    ? 'Your plan is already billed through your web account, so this Google Play purchase was not added to it. To avoid paying twice, cancel it in Google Play > Payments & subscriptions > Subscriptions and ask Google for a refund.'
    : 'Your plan is already billed through your web account, so this App Store purchase was not added to it. To avoid paying twice, cancel it in Settings > Apple Account > Subscriptions and ask Apple for a refund.';

/**
 * Purchase bookkeeping on the device. Both keys are cleared with the account's
 * other local traces after a deletion (context/AuthContext.tsx).
 *
 * 'iap.intent': the purchase the user last started - sku, user, terms, context.
 * A transaction for that sku by the same user within seven days (an Ask to Buy
 * approval, a late delivery after the purchase timed out, a 'confirming' retry
 * on the next launch) is verified with THESE terms, so the server records the
 * acceptance for that new purchase instead of a terms-less 'reconcile'.
 *
 * 'iap.reconcile.skip': transactions the server has already refused with a
 * terminal 409/400 during a silent reconcile, each with the refusal it
 * answered, so later launches do not re-POST them and a Restore that finds
 * only refused subscriptions can still say why. A 409 (bound to another
 * account) is kept as `${userId}:${originalTransactionId}`, since every renewal
 * shares it; a 400 (expired, refunded, unreadable) only as
 * `${userId}:tx:${transactionId}`, since it says nothing about the next renewal.
 */
const INTENT_KEY = 'iap.intent';
const SKIP_KEY = 'iap.reconcile.skip';
const INTENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const PRODUCTS_TIMEOUT_MS = 15_000;
/** Retries after a transient verify failure during a purchase, before giving up as 'confirming'. */
const VERIFY_BACKOFF_MS = [2_000, 5_000, 10_000];

interface Intent {
  sku: string;
  userId: string;
  acceptedTerms: true;
  context: 'onboarding' | 'pricing';
  startedAt: number;
}

interface VerifyBody {
  acceptedTerms?: true;
  context: PurchaseReason;
}

type VerifyResult =
  | { kind: 'ok'; billing: BillingSnapshot }
  /** 409 / 400: the server will never accept this transaction for this account. */
  | { kind: 'terminal'; status: number; code?: string; message: string }
  /** 402: RevenueCat holds nothing for this customer. */
  | { kind: 'none' }
  /** 401: no session - keep the transaction and try once there is one. */
  | { kind: 'unauthorized' }
  | { kind: 'transient'; message: string };

async function readIntent(): Promise<Intent | null> {
  try {
    const raw = await AsyncStorage.getItem(INTENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Intent>;
    if (
      typeof parsed.sku !== 'string' ||
      typeof parsed.userId !== 'string' ||
      typeof parsed.startedAt !== 'number' ||
      (parsed.context !== 'onboarding' && parsed.context !== 'pricing')
    ) {
      return null;
    }
    return {
      sku: parsed.sku,
      userId: parsed.userId,
      acceptedTerms: true,
      context: parsed.context,
      startedAt: parsed.startedAt,
    };
  } catch {
    return null;
  }
}

async function writeIntent(intent: Intent): Promise<void> {
  try {
    await AsyncStorage.setItem(INTENT_KEY, JSON.stringify(intent));
  } catch {
    // A delayed transaction then verifies as 'reconcile' (no terms), which the
    // server accepts; only the terms record is lost.
  }
}

async function clearIntent(): Promise<void> {
  try {
    await AsyncStorage.removeItem(INTENT_KEY);
  } catch {
    // Expires by itself after seven days.
  }
}

interface SkipEntry {
  code?: string;
  /** The refusal as the user would be shown it (already the stripe_active copy when that was the code). */
  message: string;
}

type SkipList = Record<string, SkipEntry>;

async function readSkip(): Promise<SkipList> {
  try {
    const raw = await AsyncStorage.getItem(SKIP_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: SkipList = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as Partial<SkipEntry> | null;
      if (entry && typeof entry.message === 'string') {
        out[key] = { message: entry.message, ...(typeof entry.code === 'string' ? { code: entry.code } : {}) };
      }
    }
    return out;
  } catch {
    return {};
  }
}

async function addSkip(key: string, entry: SkipEntry): Promise<void> {
  try {
    const list = await readSkip();
    if (list[key]) return;
    await AsyncStorage.setItem(SKIP_KEY, JSON.stringify({ ...list, [key]: entry }));
  } catch {
    // One more silent request next launch.
  }
}

function skipKeys(uid: string, tx: StoreTransaction): { chain: string; tx: string } {
  return { chain: `${uid}:${tx.originalTransactionId ?? tx.id}`, tx: `${uid}:tx:${tx.id}` };
}

function refusalFor(skip: SkipList, uid: string, tx: StoreTransaction): SkipEntry | undefined {
  const keys = skipKeys(uid, tx);
  return skip[keys.chain] ?? skip[keys.tx];
}

/** The four skus for this platform, straight from the catalog. The app never hardcodes one. */
function skusFor(plans: OnboardingPlan[]): SkuRef[] {
  const out: SkuRef[] = [];
  for (const plan of plans) {
    if (plan.id !== 'solo' && plan.id !== 'team') continue;
    const ids = plan.storeProductIds;
    if (!ids) continue;
    for (const cycle of ['monthly', 'annual'] as const) {
      if (PLATFORM_PROVIDER === 'google') {
        out.push({
          plan: plan.id,
          cycle,
          productId: ids.android[cycle],
          packageId: cycle === 'monthly' ? ids.android.packageMonthly : ids.android.packageAnnual,
        });
      } else {
        out.push({ plan: plan.id, cycle, productId: ids.ios[cycle] });
      }
    }
  }
  return out;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One verify / sync call, its outcome sorted into what the transaction should do next. */
async function verifyOnce(
  adapter: StoreAdapter,
  tx: StoreTransaction,
  body: VerifyBody,
): Promise<VerifyResult> {
  try {
    const billing =
      PLATFORM_PROVIDER === 'google'
        ? await api.syncGooglePurchase({
            ...body,
            // The mock store has no RevenueCat customer to read; the real server ignores this.
            ...(adapter.kind === 'mock' ? { debugProductId: tx.productId } : {}),
          })
        : await api.verifyApplePurchase({ jws: tx.token, ...body });
    return { kind: 'ok', billing };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 401) return { kind: 'unauthorized' };
      if (error.status === 402) return { kind: 'none' };
      if (error.status === 409 || error.status === 400) {
        return { kind: 'terminal', status: error.status, code: error.code, message: error.message };
      }
      return { kind: 'transient', message: error.message };
    }
    return { kind: 'transient', message: GENERIC_MESSAGE };
  }
}

const INERT: PurchasesValue = {
  available: false,
  unavailableReason: null,
  ready: false,
  loadError: null,
  retryProducts: async () => {},
  products: [],
  productFor: () => null,
  storeName: STORE_NAME,
  platformProvider: PLATFORM_PROVIDER,
  busy: null,
  confirming: false,
  billing: null,
  billingLoading: false,
  refreshBilling: async () => null,
  purchase: async () => ({ outcome: 'failed', message: NOT_AVAILABLE_MESSAGE }),
  restore: async () => ({ restored: false }),
  manage: async () => {},
};

const PurchasesContext = createContext<PurchasesValue | null>(null);

interface ProcessOptions {
  /** Who is waiting: a Subscribe tap, a Restore tap, or nobody (launch, re-delivery). */
  reason: 'purchase' | 'restore' | 'redelivery';
  /** The terms of a purchase the user just made. */
  body?: { acceptedTerms: true; context: 'onboarding' | 'pricing' };
  /** The sku that was asked for, to notice when the store delivered a different one. */
  requestedSku?: string;
  /** A skip list already read by the caller's loop. */
  skip?: SkipList;
}

/**
 * What `load()` got done. `inited` (catalog read, adapter connected) is what
 * the session needs - RevenueCat logIn, the launch reconcile - and does not
 * depend on the store pricing our skus; `priced` is what the paywall needs.
 */
interface LoadResult {
  inited: boolean;
  priced: boolean;
}

interface ProcessResult extends PurchaseResult {
  terminal?: { code?: string; message: string };
  none?: boolean;
}

export function PurchaseProvider({ children }: { children: ReactNode }) {
  const { userId } = useAuth();

  const adapter = useMemo(() => createAdapter(), []);
  const reason = useMemo(() => (adapter ? null : unavailableReason()), [adapter]);

  const [products, setProducts] = useState<StoreProduct[]>([]);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [billing, setBillingState] = useState<BillingSnapshot | null>(null);
  const [billingLoading, setBillingLoading] = useState(false);
  const [busy, setBusy] = useState<'purchase' | 'restore' | null>(null);
  const [confirming, setConfirming] = useState(false);

  // Refs mirror the state the async flows read, so a listener registered once
  // sees the current session and billing rather than the ones at mount.
  const userIdRef = useRef<string | null>(userId);
  userIdRef.current = userId;
  const billingRef = useRef<BillingSnapshot | null>(null);
  const productsRef = useRef<StoreProduct[]>([]);
  const planNamesRef = useRef<Record<string, string>>({});
  const busyRef = useRef<'purchase' | 'restore' | null>(null);
  /** Transactions waiting for a session or for the server: unfinished, retried on sign-in and on launch. */
  const queueRef = useRef<StoreTransaction[]>([]);
  /** Transaction ids being verified right now, so a re-delivery mid-verify is not processed twice. */
  const processingRef = useRef(new Set<string>());
  /** The load in progress (or last finished): settles within the products timeout. */
  const loadRef = useRef<Promise<LoadResult>>(Promise.resolve({ inited: false, priced: false }));

  const setBilling = useCallback((next: BillingSnapshot | null) => {
    billingRef.current = next;
    setBillingState(next);
  }, []);

  const enqueue = (tx: StoreTransaction) => {
    if (!queueRef.current.some((t) => t.id === tx.id)) queueRef.current.push(tx);
    setConfirming(true);
  };
  const dequeue = (tx: StoreTransaction) => {
    queueRef.current = queueRef.current.filter((t) => t.id !== tx.id);
    if (queueRef.current.length === 0) setConfirming(false);
  };

  // ── Products ──────────────────────────────────────────────────────────────

  const load = useCallback(async (): Promise<LoadResult> => {
    if (!adapter) return { inited: false, priced: false };
    setLoadError(null);
    // Tracked apart from pricing: a store that connects but cannot price our
    // skus (getOfferings down, a slow fetchProducts) must still get the
    // session's logIn and reconcile.
    let inited = false;
    const work = (async () => {
      const catalog = await api.catalog();
      planNamesRef.current = Object.fromEntries(catalog.plans.map((p) => [p.id, p.name]));
      await adapter.init(skusFor(catalog.plans));
      inited = true;
      return adapter.products();
    })();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), PRODUCTS_TIMEOUT_MS);
    });
    try {
      const list = await Promise.race([work, timeout]);
      productsRef.current = list;
      setProducts(list);
      setReady(true);
      return { inited: true, priced: true };
    } catch (error) {
      if (__DEV__) console.log('[purchases] products failed:', error);
      setLoadError(NO_PACKAGES_MESSAGE);
      return { inited, priced: false };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }, [adapter]);

  useEffect(() => {
    if (!adapter) return;
    loadRef.current = load();
  }, [adapter, load]);

  const productFor = useCallback(
    (plan: PlanKey, cycle: BillingCycle) =>
      products.find((p) => p.plan === plan && p.cycle === cycle) ?? null,
    [products],
  );

  // ── Billing ───────────────────────────────────────────────────────────────

  const refreshBilling = useCallback(async (): Promise<BillingSnapshot | null> => {
    if (!userIdRef.current) return null;
    setBillingLoading(true);
    try {
      const next = await api.billing();
      setBilling(next);
      return next;
    } catch {
      // Keep the last snapshot: a lost packet must not demote a paying user.
      return null;
    } finally {
      setBillingLoading(false);
    }
  }, [setBilling]);

  // ── The one verify-then-finish path ───────────────────────────────────────

  const changeMessage = (requestedSku: string): string | undefined => {
    const ref = productsRef.current.find((p) => p.productId === requestedSku);
    if (!ref) return undefined;
    const name = planNamesRef.current[ref.plan] ?? ref.plan;
    return `Your plan changes to ${name} ${ref.cycle} at your next renewal.`;
  };

  const safeFinish = async (tx: StoreTransaction) => {
    try {
      await adapter?.finish(tx);
    } catch (error) {
      // The server already has it. StoreKit re-delivers an unfinished one and
      // the server dedupes on originalTransactionId, so nothing is lost.
      if (__DEV__) console.log('[purchases] finish failed:', error);
    }
  };

  const processTransaction = useCallback(
    async (tx: StoreTransaction, opts: ProcessOptions): Promise<ProcessResult> => {
      if (!adapter) return { outcome: 'failed', message: NOT_AVAILABLE_MESSAGE };
      const uid = userIdRef.current;
      if (!uid) {
        // Signed out: keep it, unfinished, until there is someone to bind it to.
        enqueue(tx);
        return { outcome: 'confirming', message: CONFIRMING_MESSAGE };
      }
      if (processingRef.current.has(tx.id)) return { outcome: 'confirming' };
      processingRef.current.add(tx.id);
      try {
        let body: VerifyBody;
        let intentMatched = false;
        if (opts.body) {
          body = opts.body;
        } else if (opts.reason === 'restore') {
          body = { context: 'restore' };
        } else {
          const intent = await readIntent();
          if (
            intent &&
            intent.sku === tx.productId &&
            intent.userId === uid &&
            Date.now() - intent.startedAt < INTENT_TTL_MS
          ) {
            body = { acceptedTerms: true, context: intent.context };
            intentMatched = true;
          } else {
            body = { context: 'reconcile' };
          }
        }

        if (body.context === 'reconcile' || body.context === 'restore') {
          const skip = opts.skip ?? (await readSkip());
          const refused = refusalFor(skip, uid, tx);
          if (refused) {
            // Refused before. Finished then too; finishing again is harmless.
            // The stored refusal lets a Restore that finds nothing else say
            // why, instead of 'No subscription found'.
            await safeFinish(tx);
            dequeue(tx);
            return { outcome: 'blocked', message: refused.message, terminal: refused };
          }
        }

        // A purchase the user is waiting on retries a transient failure with
        // backoff; a silent path gets one try - StoreKit and the launch
        // reconcile try again later anyway.
        const backoff = opts.reason === 'purchase' ? VERIFY_BACKOFF_MS : [];
        let result = await verifyOnce(adapter, tx, body);
        for (const wait of backoff) {
          const retry = result.kind === 'transient' || (result.kind === 'none' && opts.reason === 'purchase');
          if (!retry) break;
          setConfirming(true);
          await delay(wait);
          result = await verifyOnce(adapter, tx, body);
        }

        switch (result.kind) {
          case 'ok': {
            await safeFinish(tx);
            if (opts.body || intentMatched) await clearIntent();
            dequeue(tx);
            setBilling(result.billing);
            if (opts.reason === 'purchase') {
              void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
            }
            const changed = opts.requestedSku != null && tx.productId !== opts.requestedSku;
            return {
              outcome: 'purchased',
              billing: result.billing,
              message: changed && opts.requestedSku ? changeMessage(opts.requestedSku) : undefined,
            };
          }
          case 'terminal': {
            // Bound to another account, or not our product. The server's
            // notification path owns it; left unfinished it would re-alert on
            // every launch.
            await safeFinish(tx);
            if (opts.body || intentMatched) await clearIntent();
            dequeue(tx);
            const message = result.code === 'stripe_active' ? STRIPE_ACTIVE_MESSAGE : result.message;
            if (opts.reason === 'purchase') {
              Alert.alert('Purchase failed', message);
            } else if (opts.reason === 'redelivery') {
              const keys = skipKeys(uid, tx);
              await addSkip(result.status === 409 ? keys.chain : keys.tx, { code: result.code, message });
              if (__DEV__) console.log('[purchases] reconcile refused:', result.status, result.code, tx.productId);
            }
            return { outcome: 'blocked', message, terminal: { code: result.code, message } };
          }
          case 'none':
            dequeue(tx);
            return { outcome: 'failed', none: true };
          case 'unauthorized':
            enqueue(tx);
            return { outcome: 'confirming', message: CONFIRMING_MESSAGE };
          case 'transient':
            enqueue(tx);
            return { outcome: 'confirming', message: CONFIRMING_MESSAGE };
        }
      } finally {
        processingRef.current.delete(tx.id);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [adapter, setBilling],
  );

  // Transactions the store delivers on its own: a re-delivered unfinished one,
  // an Ask to Buy approval, a renewal, a late one after purchase() timed out.
  useEffect(() => {
    if (!adapter) return;
    return adapter.onTransaction((tx) => {
      if (PLATFORM_PROVIDER === 'google') {
        // RevenueCat replays the customer on configure, after every logIn and
        // after each purchase or restore. There is nothing to finish on this
        // platform, so sync only when billing is behind (the spec's Android
        // reconcile rule), never on top of a purchase or restore that syncs
        // itself, and not while signed out - the sign-in reconcile re-reads
        // the customer anyway.
        const current = billingRef.current;
        if (current?.active && current.provider === 'google') return;
        if (busyRef.current !== null) return;
        if (!userIdRef.current) return;
      }
      // iOS: unconditional. An unfinished transaction must always be verified
      // and finished, whatever billing already says.
      void processTransaction(tx, { reason: 'redelivery' });
    });
  }, [adapter, processTransaction]);

  /** Launch / sign-in reconcile (PAY-15): what the store holds that billing does not know. */
  const reconcile = useCallback(
    async (uid: string, snapshot: BillingSnapshot | null) => {
      if (!adapter) return;
      let owned: StoreTransaction[] = [];
      try {
        owned = await adapter.owned();
      } catch (error) {
        if (__DEV__) console.log('[purchases] owned failed:', error);
        return;
      }
      const skip = await readSkip();
      for (const tx of owned) {
        if (userIdRef.current !== uid) return;
        const known =
          snapshot?.active &&
          snapshot.provider === PLATFORM_PROVIDER &&
          (PLATFORM_PROVIDER === 'google' || snapshot.providerRef === tx.originalTransactionId);
        if (known) continue;
        if (refusalFor(skip, uid, tx)) continue;
        const result = await processTransaction(tx, { reason: 'redelivery', skip });
        snapshot = result.billing ?? billingRef.current;
        // One sync covers the whole RevenueCat customer.
        if (PLATFORM_PROVIDER === 'google') break;
      }
    },
    [adapter, processTransaction],
  );

  const drainQueue = useCallback(async () => {
    for (const tx of [...queueRef.current]) {
      if (!userIdRef.current) return;
      await processTransaction(tx, { reason: 'redelivery' });
    }
  }, [processTransaction]);

  // ── Session ───────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!adapter) return;
    if (!userId) {
      void adapter.reset().catch(() => {});
      setBilling(null);
      return;
    }
    let alive = true;
    void (async () => {
      // identify and reconcile need the adapter connected, not priced: a
      // subscriber must reach RevenueCat's logIn even when getOfferings fails.
      const { inited } = await loadRef.current;
      if (!alive) return;
      if (inited) await adapter.identify(userId).catch(() => {});
      await refreshBilling();
      if (!alive) return;
      await drainQueue();
      if (!alive || !inited) return;
      // billingRef, not the fetched snapshot: the drain may just have moved it.
      await reconcile(userId, billingRef.current);
    })();
    return () => {
      alive = false;
    };
  }, [adapter, userId, refreshBilling, drainQueue, reconcile, setBilling]);

  const retryProducts = useCallback(async () => {
    if (!adapter) return;
    loadRef.current = load();
    const { inited } = await loadRef.current;
    const uid = userIdRef.current;
    if (!inited || !uid) return;
    await adapter.identify(uid).catch(() => {});
    await drainQueue();
    await reconcile(uid, billingRef.current);
  }, [adapter, load, drainQueue, reconcile]);

  // ── Restore ───────────────────────────────────────────────────────────────

  const runRestore = useCallback(async (): Promise<RestoreResult> => {
    if (!adapter) {
      Alert.alert('Restore failed', NOT_AVAILABLE_MESSAGE);
      return { restored: false };
    }
    if (!userIdRef.current) return { restored: false };
    try {
      const owned = await adapter.restore();
      const skip = await readSkip();
      let restored: BillingSnapshot | undefined;
      let firstTerminal: { code?: string; message: string } | null = null;

      if (PLATFORM_PROVIDER === 'google') {
        // One sync covers the RevenueCat customer, whatever it holds.
        const tx: StoreTransaction = owned[0] ?? {
          id: 'google-restore',
          productId: '',
          token: '',
          originalTransactionId: null,
          expiresAt: null,
          appAccountToken: null,
          raw: null,
        };
        const result = await processTransaction(tx, { reason: 'restore', skip });
        if (result.outcome === 'purchased') restored = result.billing;
        else if (result.terminal) firstTerminal = result.terminal;
      } else {
        for (const tx of owned) {
          const result = await processTransaction(tx, { reason: 'restore', skip });
          if (result.outcome === 'purchased') {
            restored = result.billing ?? restored;
          } else if (result.terminal && !firstTerminal) {
            firstTerminal = result.terminal;
          }
        }
      }

      if (restored) return { restored: true, billing: restored };
      if (firstTerminal) {
        // At most ONE alert per restore run: the user asked, so a silent
        // no-op would read as broken.
        Alert.alert('Restore failed', firstTerminal.message);
        return { restored: false };
      }
      Alert.alert('No subscription found', NO_SUBSCRIPTION_MESSAGE);
      return { restored: false };
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : GENERIC_MESSAGE;
      Alert.alert('Restore failed', message);
      return { restored: false };
    }
  }, [adapter, processTransaction]);

  const restore = useCallback(async (): Promise<RestoreResult> => {
    if (busyRef.current) return { restored: false };
    busyRef.current = 'restore';
    setBusy('restore');
    try {
      return await runRestore();
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  }, [runRestore]);

  // ── Purchase ──────────────────────────────────────────────────────────────

  const purchase = useCallback(
    async (
      plan: PlanKey,
      cycle: BillingCycle,
      opts: { acceptedTerms: true; context: 'onboarding' | 'pricing' },
    ): Promise<PurchaseResult> => {
      if (!adapter) {
        Alert.alert('Purchase failed', NOT_AVAILABLE_MESSAGE);
        return { outcome: 'failed', message: NOT_AVAILABLE_MESSAGE };
      }
      const uid = userIdRef.current;
      if (!uid) return { outcome: 'blocked', message: 'Sign in to subscribe.' };

      // Decision 1b: never sell to an account billed elsewhere. The UI should
      // never get here (usePaywall's mode), so no alert - just a refusal.
      const current = billingRef.current;
      if (isLiveStripe(current) || (current?.active && current.provider !== PLATFORM_PROVIDER)) {
        return { outcome: 'blocked', message: 'This account is billed elsewhere.' };
      }

      const product = productsRef.current.find((p) => p.plan === plan && p.cycle === cycle) ?? null;
      if (!product) {
        Alert.alert('Purchase failed', NO_PACKAGES_MESSAGE);
        return { outcome: 'failed', message: NO_PACKAGES_MESSAGE };
      }
      if (busyRef.current) return { outcome: 'failed', message: 'A purchase is already in progress.' };

      busyRef.current = 'purchase';
      setBusy('purchase');
      try {
        await writeIntent({
          sku: product.productId,
          userId: uid,
          acceptedTerms: true,
          context: opts.context,
          startedAt: Date.now(),
        });
        // An Android product change needs the Play subscription the user holds.
        const changeFrom =
          PLATFORM_PROVIDER === 'google' && current?.active && current.provider === 'google'
            ? current.plan
            : null;
        const result = await adapter.purchase(product, { userId: uid, changeFrom });
        switch (result.status) {
          case 'cancelled':
            await clearIntent();
            return { outcome: 'cancelled' };
          case 'pending':
            // Ask to Buy: the intent stays for the approval's delivery.
            return { outcome: 'pending', message: PENDING_MESSAGE };
          case 'confirming':
            // The store sheet closed with no transaction: the persistent
            // listener replays the intent when one turns up.
            setConfirming(true);
            return { outcome: 'confirming', message: CONFIRMING_MESSAGE };
          case 'failed': {
            await clearIntent();
            const message = result.message || GENERIC_MESSAGE;
            Alert.alert('Purchase failed', message);
            return { outcome: 'failed', message };
          }
          case 'already-owned': {
            // This store account already holds it: adopt it instead of erroring.
            await clearIntent();
            const restored = await runRestore();
            return restored.restored
              ? { outcome: 'purchased', billing: restored.billing }
              : { outcome: 'failed', message: NO_SUBSCRIPTION_MESSAGE };
          }
          case 'transaction': {
            const processed = await processTransaction(result.tx, {
              reason: 'purchase',
              body: { acceptedTerms: true, context: opts.context },
              requestedSku: product.productId,
            });
            if (processed.none) {
              // RevenueCat has not seen the purchase yet: the launch reconcile will.
              enqueue(result.tx);
              return { outcome: 'confirming', message: CONFIRMING_MESSAGE };
            }
            return { outcome: processed.outcome, billing: processed.billing, message: processed.message };
          }
        }
      } finally {
        busyRef.current = null;
        setBusy(null);
      }
    },
    [adapter, processTransaction, runRestore],
  );

  // ── Manage ────────────────────────────────────────────────────────────────

  const manage = useCallback(async () => {
    if (adapter) {
      try {
        await adapter.manage(billingRef.current);
        return;
      } catch {
        // Fall through to the store's own page.
      }
    }
    // The Play subscription id is the bare plan id ('solo' of 'solo:monthly');
    // name it only when Play is what bills this account.
    const billing = billingRef.current;
    const sku = billing?.provider === 'google' ? (billing.plan ?? undefined) : undefined;
    await openExternal(
      PLATFORM_PROVIDER === 'google' ? PLAY_SUBSCRIPTIONS_URL(sku) : APPLE_SUBSCRIPTIONS_URL,
    );
  }, [adapter]);

  const value = useMemo<PurchasesValue>(
    () => ({
      available: adapter !== null,
      unavailableReason: reason,
      ready,
      loadError,
      retryProducts,
      products,
      productFor,
      storeName: STORE_NAME,
      platformProvider: PLATFORM_PROVIDER,
      busy,
      confirming,
      billing,
      billingLoading,
      refreshBilling,
      purchase,
      restore,
      manage,
    }),
    [
      adapter,
      reason,
      ready,
      loadError,
      retryProducts,
      products,
      productFor,
      busy,
      confirming,
      billing,
      billingLoading,
      refreshBilling,
      purchase,
      restore,
      manage,
    ],
  );

  return <PurchasesContext.Provider value={value}>{children}</PurchasesContext.Provider>;
}

/** Inert outside a provider (available: false, no-op functions) rather than throwing. */
export function usePurchases(): PurchasesValue {
  return useContext(PurchasesContext) ?? INERT;
}
