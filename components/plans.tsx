import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/Icon';
import { cardStyle, pressed, ripple, Segmented } from '@/components/ui';
import { colors, shape, spacing, type } from '@/constants/theme';
import { formatCurrency, STORE_NAME, type PriceSource, type StoreProduct } from '@/lib/purchases';
import type { BillingCycle, OnboardingPlan, PlanTerms } from '@/lib/types';

/**
 * The plan cards, shared by the funnel's plan step and the paywall route.
 *
 * The price on a card is the STORE's price - `product.displayPrice`, in the
 * user's storefront currency, VAT included - and it leads with the amount
 * that is actually billed per period: "€1,199.99 / year", with the per-month
 * figure as a subordinate line. The catalog's Stripe amounts appear only in
 * the 'indicative' state, which only guests reach, and are labelled as such.
 *
 * Lines come from `storeFeatures` and `storeIncluded`, never the raw
 * `features` / `included`: those advertise things the product does not
 * deliver (2.3.1) and Stripe-only price lines (overage, extra numbers).
 */

/**
 * Store-style money for the app's own figures: grouping and two decimals
 * ("€1,009.80"), 'en' locale like the rest of the copy. Cents in, as the
 * catalog sends them.
 */
export function money(cents: number, currency: string): string {
  return formatCurrency(cents / 100, currency);
}

/** The lines every card shows: the three numbers that differ between plans, then the plan's store feature copy. */
function planLines(plan: OnboardingPlan): string[] {
  return [
    // en-US explicitly: the app's copy is English, and a device set to a
    // space-separated locale renders "1 000 minutes", which reads as a typo.
    `${plan.minutesIncluded.toLocaleString('en-US')} minutes included`,
    `${plan.phoneNumbers} phone number${plan.phoneNumbers === 1 ? '' : 's'}`,
    plan.concurrentCalls === 1 ? 'One call at a time' : `${plan.concurrentCalls} calls at once`,
    ...(plan.storeFeatures ?? []),
  ];
}

/** "Solo, €119.99 per month, 1,000 minutes included, 1 phone number, one call at a time, ..." */
export function planA11yLabel(
  plan: OnboardingPlan,
  cycle: BillingCycle,
  product?: StoreProduct | null,
): string {
  const parts = [plan.name];
  if (product) parts.push(`${product.displayPrice} per ${product.period}`);
  for (const line of planLines(plan)) {
    parts.push(/^\d/.test(line) ? line : line.charAt(0).toLowerCase() + line.slice(1));
  }
  return parts.join(', ');
}

export function CycleToggle({
  cycle,
  onChange,
  terms,
  disabledCycles = [],
  products,
}: {
  cycle: BillingCycle;
  onChange: (next: BillingCycle) => void;
  terms: PlanTerms;
  /** From usePaywall: a cycle the store sells neither plan on. */
  disabledCycles?: BillingCycle[];
  /**
   * The picked plan's store products. Store prices are set per storefront and
   * do not keep the catalog's annual discount exactly, so when both are known
   * the badge is worked out from what the store will actually charge.
   */
  products?: { monthly: StoreProduct | null; annual: StoreProduct | null };
}) {
  const savePercent =
    products?.monthly && products.annual && products.monthly.price > 0 && products.annual.price > 0
      ? Math.floor((1 - products.annual.price / (products.monthly.price * 12)) * 100)
      : Math.round(terms.annualDiscount * 100);
  return (
    <Segmented<BillingCycle>
      options={[
        {
          value: 'monthly',
          label: 'Monthly',
          accessibilityLabel: 'Monthly billing',
          disabled: disabledCycles.includes('monthly'),
        },
        {
          value: 'annual',
          label: 'Annual',
          badge: savePercent > 0 ? `-${savePercent}%` : undefined,
          accessibilityLabel:
            savePercent > 0 ? `Annual billing, save ${savePercent} percent` : 'Annual billing',
          disabled: disabledCycles.includes('annual'),
        },
      ]}
      value={cycle}
      onChange={onChange}
      style={styles.toggle}
    />
  );
}

function PriceBlock({
  plan,
  cycle,
  product,
  priceSource,
}: {
  plan: OnboardingPlan;
  cycle: BillingCycle;
  product: StoreProduct | null | undefined;
  priceSource: PriceSource;
}) {
  const period = cycle === 'annual' ? 'year' : 'month';

  if (priceSource === 'store' && product) {
    return (
      <View style={styles.priceBlock}>
        <View style={styles.priceRow}>
          <Text style={styles.price}>{product.displayPrice}</Text>
          <Text style={styles.per}>/ {period}</Text>
        </View>
        {product.perMonthDisplay ? (
          <Text style={styles.perMonth}>about {product.perMonthDisplay} / month</Text>
        ) : null}
      </View>
    );
  }

  if (priceSource === 'indicative') {
    const billed = cycle === 'annual' ? plan.annualAmountCents : plan.monthlyAmountCents;
    return (
      <View style={styles.priceBlock}>
        <Text style={styles.eyebrow}>Indicative price</Text>
        <View style={styles.priceRow}>
          <Text style={styles.price}>{money(billed, plan.currency)}</Text>
          <Text style={styles.per}>/ {period}</Text>
        </View>
        {cycle === 'annual' ? (
          <Text style={styles.perMonth}>about {money(plan.annualMonthlyCents, plan.currency)} / month</Text>
        ) : null}
        <Text style={styles.note}>
          {STORE_NAME === 'App Store' ? 'The App Store' : 'Google Play'} shows the final price in your
          currency before you confirm.
        </Text>
      </View>
    );
  }

  if (priceSource === 'loading') {
    return (
      <View style={styles.priceBlock}>
        <Text style={styles.priceNote}>Loading price...</Text>
      </View>
    );
  }

  if (priceSource === 'missing') {
    return (
      <View style={styles.priceBlock}>
        <Text style={styles.priceNote}>Not available in the {STORE_NAME} right now</Text>
      </View>
    );
  }

  // 'error' and 'unavailable': the screen says why, once, not every card.
  return null;
}

function Line({ text }: { text: string }) {
  return (
    <View style={styles.line}>
      <Icon name="checkmark" size={15} color={colors.successText} />
      <Text style={styles.lineText}>{text}</Text>
    </View>
  );
}

/**
 * One plan. With `onPress` the whole card is the selector (a radio, labelled
 * by `planA11yLabel`) - then pass no interactive children, VoiceOver would
 * not reach them. Without it, the card is a plain container for a CTA child.
 *
 * `priceSource` defaults to 'unavailable' (no price) so a caller that has no
 * store product to show never falls back to a catalog figure by accident.
 */
export function PlanCard({
  plan,
  cycle,
  product,
  priceSource = 'unavailable',
  selected = false,
  variant = 'funnel',
  badge,
  onPress,
  children,
}: {
  plan: OnboardingPlan;
  cycle: BillingCycle;
  product?: StoreProduct | null;
  priceSource?: PriceSource;
  selected?: boolean;
  /** 'full' also lists `storeIncluded` under an Included heading (the paywall route). */
  variant?: 'funnel' | 'full';
  /** Replaces the 'Most popular' ribbon, e.g. 'Current plan'. */
  badge?: string;
  onPress?: () => void;
  /** The call to action. Left to the caller: the funnel docks its own, the paywall buys. */
  children?: ReactNode;
}) {
  const disabled = priceSource === 'missing';
  const ribbon = badge ?? (plan.highlight ? 'Most popular' : undefined);
  const included = variant === 'full' ? (plan.storeIncluded ?? []) : [];

  const body = (
    <>
      {ribbon ? (
        <View style={styles.ribbon}>
          <Text style={styles.ribbonText}>{ribbon}</Text>
        </View>
      ) : null}

      <View style={styles.head}>
        <Text style={styles.name}>{plan.name}</Text>
        <Text style={styles.tagline}>{plan.tagline}</Text>
      </View>

      <PriceBlock plan={plan} cycle={cycle} product={product} priceSource={priceSource} />

      <View style={styles.lines}>
        {planLines(plan).map((line) => (
          <Line key={line} text={line} />
        ))}
      </View>

      {included.length > 0 ? (
        <View style={styles.included}>
          <Text style={styles.includedTitle}>Included</Text>
          {included.map((line) => (
            <Line key={line} text={line} />
          ))}
        </View>
      ) : null}

      {children}
    </>
  );

  const cardStyles = [styles.card, selected && styles.cardSelected, disabled && styles.cardDisabled];

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="radio"
        accessibilityState={{ checked: selected, disabled }}
        accessibilityLabel={planA11yLabel(plan, cycle, product)}
        android_ripple={ripple}
        style={({ pressed: down }) => [...cardStyles, down && !disabled && pressed]}
      >
        {body}
      </Pressable>
    );
  }
  return <View style={cardStyles}>{body}</View>;
}

const styles = StyleSheet.create({
  toggle: {
    alignSelf: 'stretch',
    marginBottom: spacing.lg,
  },

  card: {
    ...cardStyle,
    padding: 20,
    marginBottom: spacing.md,
    overflow: 'hidden',
  },
  cardSelected: {
    borderWidth: 1.5,
    borderColor: colors.ink,
  },
  cardDisabled: {
    opacity: 0.5,
  },
  ribbon: {
    alignSelf: 'flex-start',
    backgroundColor: colors.ink,
    ...shape.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 3,
    marginBottom: spacing.sm,
  },
  ribbonText: {
    ...type.micro,
    color: colors.white,
  },
  head: { gap: 2 },
  name: { ...type.heading },
  tagline: { ...type.footnote },

  priceBlock: { marginTop: spacing.md },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    flexWrap: 'wrap',
  },
  price: { ...type.price },
  per: { ...type.body, marginLeft: 4, color: colors.textSecondary },
  perMonth: { ...type.caption, marginTop: 2 },
  eyebrow: { ...type.eyebrow, marginBottom: 2 },
  note: { ...type.caption, marginTop: spacing.xs },
  priceNote: { ...type.body, color: colors.textSecondary },

  lines: { marginTop: spacing.lg, gap: spacing.sm },
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  lineText: { ...type.bodySm, flex: 1, color: colors.textSecondary },
  included: { marginTop: spacing.lg, gap: spacing.sm },
  includedTitle: { ...type.label },
});
