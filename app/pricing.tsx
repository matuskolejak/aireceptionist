import { Redirect } from 'expo-router';

// Compatibility stub: settings.tsx (WP-14) still pushes /pricing until it lands; WP-15 deletes
// this file. Plans are bought, changed and restored on the paywall (app/paywall.tsx).
export default function Pricing() {
  return <Redirect href="/paywall" />;
}
