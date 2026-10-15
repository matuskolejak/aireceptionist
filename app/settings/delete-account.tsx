import { useHeaderHeight } from '@react-navigation/elements';
import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { TextField, useKeyboardUp } from '@/components/form';
import { Button, Notice } from '@/components/ui';
import { colors, spacing, type } from '@/constants/theme';
import { useAuth } from '@/context/AuthContext';
import { usePurchases } from '@/context/PurchaseContext';
import { api, ApiError } from '@/lib/api';
import { APPLE_SUBSCRIPTIONS_URL, openExternal, PLAY_SUBSCRIPTIONS_URL } from '@/lib/links';
import { isLiveStripe } from '@/lib/purchases';
import type { BillingSnapshot } from '@/lib/types';

/**
 * Delete the account, in the app (App Store 5.1.1(v), Google Play's account
 * deletion policy). Reachable with any session, including before setup is
 * finished - the funnel's account menu opens it too.
 *
 * The server cancels a web (Stripe) subscription itself. It cannot cancel an
 * App Store or Google Play one - only the subscriber can, in that store - so a
 * live store subscription gets a warning and a way there BEFORE the delete,
 * and a reminder after it.
 */

const CONFIRM_WORD = 'DELETE';

/** The server's STORE_LIVE: a store subscription that can still charge. */
const STORE_LIVE = ['active', 'trialing', 'past_due', 'paused'];

type Store = 'apple' | 'google';

const storeLabel = (store: Store) => (store === 'apple' ? 'App Store' : 'Google Play');
const inStore = (store: Store) => (store === 'apple' ? 'in the App Store' : 'in Google Play');

function liveStore(billing: BillingSnapshot | null): Store | null {
  if (!billing || (billing.provider !== 'apple' && billing.provider !== 'google')) return null;
  return STORE_LIVE.includes(billing.status ?? '') ? billing.provider : null;
}

/**
 * The subscription page of the store that bills it - not necessarily this
 * phone's store. No Play `sku`: `billing.plan` is our plan name ('solo'), not a
 * store product id, and a wrong sku opens an error page instead of the list.
 */
function storeManageUrl(store: Store): string {
  return store === 'apple' ? APPLE_SUBSCRIPTIONS_URL : PLAY_SUBSCRIPTIONS_URL();
}

export default function DeleteAccountScreen() {
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  const keyboardUp = useKeyboardUp();
  const { signOut } = useAuth();
  const { billing, refreshBilling, platformProvider, manage } = usePurchases();

  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The provider only loads billing when a store is available; ask directly so
  // the store warning shows in Expo Go and before setup as well.
  useEffect(() => {
    void refreshBilling();
  }, [refreshBilling]);

  const store = liveStore(billing);
  const stripe = isLiveStripe(billing);
  const armed = confirm === CONFIRM_WORD;

  function openManage(which: Store) {
    // manage() opens THIS platform's store only; a Google subscription viewed
    // on an iPhone needs the Play page instead.
    if (which === platformProvider) void manage();
    else void openExternal(storeManageUrl(which));
  }

  async function onDelete() {
    if (!armed || busy) return;
    Keyboard.dismiss();
    setBusy(true);
    setError(null);
    // What billing said before the delete, in case the answer never arrives.
    let remaining: Store | null = store;
    try {
      const res = await api.deleteAccount();
      remaining = res.storeSubscription ?? null;
    } catch (err) {
      // A 401 means an earlier attempt already went through and the session no
      // longer verifies - that is a deleted account, not a failure.
      if (!(err instanceof ApiError && err.status === 401)) {
        setError((err as Error).message || 'Could not delete your account. Try again.');
        setBusy(false);
        return;
      }
    }

    // Clears this install's traces of the account too. The navigation guards
    // then take the user back to the start.
    await signOut({ afterDeletion: true });

    if (remaining) {
      const which = remaining;
      Alert.alert(
        'Your account was deleted.',
        `Your ${storeLabel(which)} subscription is not cancelled. Cancel it ${inStore(which)} so you are not charged again.`,
        [
          { text: 'Not now', style: 'cancel' },
          { text: 'Manage subscription', onPress: () => void openExternal(storeManageUrl(which)) },
        ],
      );
    } else {
      Alert.alert('Your account was deleted.');
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior="padding"
      // The KAV measures itself against the window, so on iOS it has to be told
      // about the navigation header above it or it stops short of the keyboard.
      keyboardVerticalOffset={Platform.OS === 'ios' ? headerHeight : 0}
    >
      <Stack.Screen options={{ title: 'Delete account' }} />
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        {/* No heading of its own: the native title already says it, and two
            "Delete account"s in the same weight stacked read as a stutter. */}
        <Text style={styles.body}>
          This permanently deletes your receptionists, call history, recordings and transcripts,
          knowledge, connected calendars and devices. Your phone number is released.
        </Text>
        <Text style={styles.body}>
          This cannot be undone. Account data is deleted immediately; payment records are kept
          only as long as tax law requires.
        </Text>

        {stripe ? (
          <Text style={styles.body}>Your web subscription is cancelled when you delete your account.</Text>
        ) : null}

        {store ? (
          <Notice
            tone="warning"
            live
            action={
              <Button
                label="Manage subscription"
                variant="secondary"
                size="pill"
                icon="open-outline"
                iconPosition="right"
                onPress={() => openManage(store)}
                accessibilityHint={`Opens your subscriptions ${inStore(store)}`}
                style={styles.warningButton}
              />
            }
          >
            {`Deleting your account does not cancel your ${storeLabel(store)} subscription. Cancel it first so you are not charged again.`}
          </Notice>
        ) : null}

        <View style={styles.field}>
          <TextField
            label={`Type ${CONFIRM_WORD} to confirm`}
            value={confirm}
            onChangeText={(v) => {
              setConfirm(v);
              if (error) setError(null);
            }}
            autoCapitalize="characters"
            autoComplete="off"
            editable={!busy}
            returnKeyType="done"
            // Done only closes the keyboard: the red button stays the one way to delete.
            onSubmitEditing={() => Keyboard.dismiss()}
            error={error ?? undefined}
          />
        </View>
      </ScrollView>

      <View
        style={[
          styles.footer,
          // The keyboard already covers the home-indicator strip.
          { paddingBottom: keyboardUp ? spacing.md : Math.max(insets.bottom, spacing.md) },
        ]}
      >
        <Button
          label="Delete account"
          variant="danger"
          size="lg"
          icon="trash-outline"
          onPress={() => void onDelete()}
          busy={busy}
          disabled={!armed}
          accessibilityHint={armed ? 'Deletes your account for good' : `Type ${CONFIRM_WORD} above first`}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
  body: { ...type.body, color: colors.text },
  warningButton: { alignSelf: 'flex-start' },
  field: { marginTop: spacing.sm },
  footer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
});
