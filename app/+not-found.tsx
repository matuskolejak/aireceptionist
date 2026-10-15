import { Stack, useNavigation, useRouter } from 'expo-router';
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
 * funnel before that (and for a guest). The root Stack only lists the screens
 * the user may open right now (app/_layout.tsx), so its route names say which.
 */
export default function NotFoundScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();

  const goHome = () => {
    const allowed = navigation.getState()?.routeNames ?? [];
    router.replace(allowed.includes('(tabs)') ? '/' : '/onboarding');
  };

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
