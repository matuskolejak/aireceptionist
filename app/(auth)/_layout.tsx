import { Stack } from 'expo-router';

import { colors } from '@/constants/theme';

/**
 * Signed-out screens. The whole group is behind the root layout's
 * `guard={!session}`, so a session landing here removes it and the Stack
 * returns to whatever is underneath (the funnel) without remounting it.
 */
export default function AuthLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
      <Stack.Screen name="sign-in" />
    </Stack>
  );
}
