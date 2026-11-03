import { Stack } from 'expo-router';

import { colors } from '@/constants/theme';

/**
 * Signed-out screens. Not guarded (see the root layout): sign-in leaves on its
 * own once a session lands, back to whatever is underneath (the funnel)
 * without remounting it.
 */
export default function AuthLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
      <Stack.Screen name="sign-in" />
    </Stack>
  );
}
