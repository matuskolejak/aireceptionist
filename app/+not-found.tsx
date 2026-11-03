import { Stack, useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NotFoundState } from '@/components/ui';
import { colors } from '@/constants/theme';

/**
 * Where a link that matches no screen lands - a stale push payload, a mistyped
 * or outdated `aireceptionistnow://` link - instead of expo-router's
 * development "Unmatched route" page.
 *
 * "Home" depends on where the user is: the tabs once setup is done, the setup
 * funnel before that (and for a guest). Over either one, this steps back to
 * it; a replace would stack a second copy on top. Opened cold, with nothing
 * below, "/" is the tabs, and their guard redirects anyone not done yet to the
 * funnel (app/_layout.tsx).
 */
export default function NotFoundScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const goHome = () => (router.canDismiss() ? router.dismissAll() : router.replace('/'));

  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <NotFoundState
        title="Page not found"
        body="That link does not go anywhere in the app."
        actionLabel="Go to Home"
        onAction={goHome}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
});
