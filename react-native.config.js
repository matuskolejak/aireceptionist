// RevenueCat is Android-only (iOS buys through expo-iap / StoreKit 2), so the iOS binary
// must not link it. Same pattern as the MeltFlex reference app.
module.exports = { dependencies: { 'react-native-purchases': { platforms: { ios: null } } } };
