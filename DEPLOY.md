# Shipping this app

Everything here is either done, or is a step only the account holder can take.
The short version: the code and the native config are ready; what is left needs
an Expo account, an Apple account, and a Play console.

Run `npm run verify` before any build. It is typecheck, lint, preflight and a
full bundle of every route - the last one catches what `tsc` cannot, because
`tsc` never resolves a route file it is not imported from.

---

## The one thing that will otherwise ship broken

`.env` is gitignored, so **EAS Build never sees it**. A cloud build reads only
`eas.json`'s `env` block and the project's EAS environment variables. Without
both of the pieces below, the binary compiles cleanly and then cannot reach
anything: `EXPO_PUBLIC_*` values that are missing at bundle time do not throw,
they become `""`.

`eas.json` now pins the API URL per profile, so a release can no longer
accidentally inherit the `http://localhost:3000` in your local `.env`:

| Profile | `EXPO_PUBLIC_API_URL` |
|---|---|
| `development` | `http://localhost:3000` |
| `preview` | `https://aireceptionistnow.com` |
| `production` | `https://aireceptionistnow.com` |

The two Supabase values are the same everywhere, so they belong in EAS rather
than in a file. Create them once:

```bash
eas env:create --scope project --name EXPO_PUBLIC_SUPABASE_URL      --value "<same as .env>" --visibility plaintext
eas env:create --scope project --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value "<same as .env>" --visibility plaintext
```

`plaintext` is correct for both. They are embedded in the binary and readable by
anyone who downloads it, which is what the publishable/anon key is designed for
- RLS and the bearer check on `/api/mobile/*` are what actually protect the
data. The **service-role key is never one of these** and must never leave the
Next.js server.

`scripts/preflight.mjs` enforces all of this. It runs as `eas-build-pre-install`,
so a build started from CI or the EAS dashboard is covered too, and it fails the
build rather than letting a dead binary reach TestFlight. It rejects a release
profile pointed at `http`, at `localhost`, or at a LAN address.

---

## Steps only you can do

### 1. `eas init`

This is the last item preflight still fails on:

```bash
npm i -g eas-cli
eas login
eas init          # writes extra.eas.projectId into app.json
```

Until that id exists, `getExpoPushTokenAsync` cannot mint a token, so **push
alerts do not work at all** - which is the app's headline feature over the
dashboard. The Alerts screen says so in plain words rather than failing
silently, and everything else works without it.

### 2. Push credentials

Push also needs per-platform credentials, and needs a real device - a simulator
has nothing for the push service to route to.

- **iOS**: `eas credentials` -> iOS -> Push Notification Key. EAS can create and
  upload the APNs key for you.
- **Android**: an FCM V1 service account JSON, uploaded via
  `eas credentials` -> Android -> FCM V1. Without it, Android builds register a
  token that never receives anything.

Server side, migration `0008_push_devices.sql` must be applied or registration
answers 500 and no alert is ever sent.

### 3. Store accounts and listing

- Apple Developer Program membership, and an app record in App Store Connect
  with bundle id `com.aireceptionistnow.app`.
- Google Play console entry with package `com.aireceptionistnow.app`.
- Screenshots, description, support URL, privacy policy URL. None of these live
  in this repo.
- Sign in with Apple needs four server env vars on the web project:
  `APPLE_SIWA_TEAM_ID`, `APPLE_SIWA_KEY_ID`, `APPLE_SIWA_PRIVATE_KEY` and
  `APPLE_SIWA_CLIENT_ID`. Without them, account deletion cannot revoke the
  Apple grant (web `lib/mobile/apple-signin.ts`), which App Review checks
  (guideline 5.1.1(v)).

### 4. App privacy answers

Answer them from what the app actually does, which is now narrower than it was:

- **Contact info**: email, name, phone numbers (the transfer number, callers'
  numbers in the call log).
- **User content**: call audio and transcripts, business details and what the
  receptionist is taught.
- **Identifiers**: a per-install UUID (`X-Device-Id`, lib/device.ts) and the push
  token.
- **Purchases**: purchase history (StoreKit; RevenueCat on Android).
- All linked to the user's identity and used for app functionality only. The
  Play Data safety form needs the same list, plus RevenueCat and Expo push as
  processors and the deletion URL `https://aireceptionistnow.com/account/delete`.
- **No tracking**, no third-party advertising identifiers, no analytics SDK.
- The app requests **notifications only**. It no longer declares microphone or
  Face ID (see below), so there is nothing else to justify.
- `ITSAppUsesNonExemptEncryption: false` is already set and is correct: the app
  uses only standard HTTPS through the OS stack and ships no custom crypto.

### 5. Store products and billing

The paywall sells nothing until the stores and RevenueCat know the products.
Follow the web repo's `BILLING.md`, section "Store subscriptions (App Store /
Google Play)" (`../aireceptionistnow/BILLING.md`). In short:

- App Store Connect: one subscription group with the four products
  `com.aireceptionistnow.app.{solo,team}.{monthly,annual}`. Set App Store
  Server Notifications (version 2) to
  `https://aireceptionistnow.com/api/apple/notifications`, for both
  Production and Sandbox.
- Play Console: subscriptions `solo` and `team`, each with the base plans
  `monthly` and `annual`.
- RevenueCat: a project with the Play app, entitlements `solo` and `team`,
  and a webhook to `https://aireceptionistnow.com/api/revenuecat/webhook`
  with the Authorization header value from the web env `REVENUECAT_WEBHOOK_AUTH`.
- EAS env for Android builds: `EXPO_PUBLIC_REVENUECAT_ANDROID_KEY` (the public
  `goog_` key) and `GOOGLE_SERVICES_JSON` (a `file` variable). Preflight
  checks that both exist, but not the store-side setup above.

---

## What was changed to make a build submittable

- **`icon.png` carried an alpha channel and pre-rounded corners.** App Store
  Connect rejects an icon with alpha, and iOS masks the icon itself, so a
  pre-rounded one gets masked twice. It is now a full-bleed 1024x1024 square on
  the brand ink, with no alpha channel.
- **The Android adaptive icon was the same full-bleed black square**, which
  Android's mask clips into a shape the brand never intended, on a white
  background. The foreground is now the bars alone on transparent, with
  `adaptiveIcon.backgroundColor` set to `#1D1D1D` - so it composes correctly
  under a circle, a squircle or a teardrop mask.
- **The splash mark was a `#000` square on a `#1D1D1D` background**, a visible
  seam. It is now the bars alone, cropped tight so `imageWidth` means what it
  reads like, configured through the `expo-splash-screen` plugin.
- **Two peer dependencies were missing.** `@expo/vector-icons` needs
  `expo-font` and `expo-audio` needs `expo-asset`; npm resolved both to SDK 55+
  majors that duplicated the SDK 54 copies inside `expo`. Duplicate native
  modules are a build error waiting to happen, and expo-doctor's own words were
  "your app may crash outside of Expo Go". Both are now direct dependencies at
  the versions that match the installed SDK (now SDK 58; use `npx expo install`).
  `expo-doctor` is 18/18.
- **`expo-audio` was declaring microphone permissions the app never uses.** Its
  default config adds `NSMicrophoneUsageDescription` and Android
  `RECORD_AUDIO`; this app only ever plays a recording back. `RECORD_AUDIO` is a
  dangerous permission that surfaces in the Play listing as "Microphone" and
  invites a policy review for an app with no reason to want it. Now
  `{ microphonePermission: false, recordAudioAndroid: false }`.
- **`expo-secure-store` was declaring Face ID** the same way. The app never uses
  `requireAuthentication`, so it is off.
- **`READ/WRITE_EXTERNAL_STORAGE` are blocked**; nothing in the app touches
  files.

The app now requests **no iOS usage-string permission at all**, and on Android
only `INTERNET`, `VIBRATE`, `MODIFY_AUDIO_SETTINGS` and (merged from
expo-notifications) `POST_NOTIFICATIONS`.
TODO: check after the first prebuild. Libraries may merge more, for example
`com.android.vending.BILLING` from RevenueCat.

`SYSTEM_ALERT_WINDOW` (the React Native template's dev-menu overlay) is in
`android.blockedPermissions` too, so "Display over other apps" stays off the
Play listing; the Android dev client loses its overlay as the cost.

---

## Building

```bash
npm run verify              # typecheck + lint + preflight + bundle every route
npm run build:preview       # internal build, production API
npm run build:production    # store build, autoIncrement version
eas submit --profile production --platform ios
eas submit --profile production --platform android
```

`cli.appVersionSource: "remote"` means EAS owns `buildNumber` and `versionCode`;
do not add them to `app.json`. Bump `expo.version` in `app.json` by hand for a
user-visible version change.

---

## Over-the-air updates: recommended, not set up

There is no OTA path today, so **every JavaScript fix needs a full store
review**. For an app whose job is to be correct about live phone calls, that is
the difference between a same-day fix and a three-day one. `runtimeVersion` is
already set to the `appVersion` policy in anticipation.

It is deliberately not installed, because it cannot be configured before
`eas init` runs and a half-configured `expo-updates` ships a broken update URL.
After step 1:

```bash
npx expo install expo-updates
eas update:configure
```

then add `"channel": "production"` / `"channel": "preview"` to the matching
`eas.json` build profiles. `expo-updates` only takes effect from the next
**native** build, so do this before the first submission rather than after.

---

## Server-side follow-ups

None of these block a release. All of them are in the `aireceptionistnow` repo
and were found by cross-checking the client against the live routes.

1. **Done.** The route now answers 409 "This booking is already cancelled."
   for a second cancel (web `app/api/mobile/calendar/bookings/[id]/route.ts`).
   Old note: **`/api/mobile/calendar/bookings/[id]` is not idempotent on cancel.** A
   second `action: 'cancel'` POST for the same booking re-runs
   `cancelCalendarEvent` and schedules `notifyCancelledCustomer` again, which
   places a second cancellation call to a real customer. The app can no longer
   send that second POST, but a retry, another device, or the web dashboard
   still can. Return 200 early when the booking already carries a cancellation
   payload.
2. **`registerPushDevice` upserts `enabled: true`**, so every cold-start
   registration resurrects a mute the user set. The app now mirrors the mute
   locally and re-applies it after each register, which closes the visible hole
   but leaves a window where the row is enabled. Preserve `enabled` when
   `owner_id` is unchanged.
3. **`/api/mobile/push` has no `GET`**, so the Alerts switch cannot read back
   this install's real server state - including a mute set from another install.
4. **Done.** `/api/mobile/web-link` now bounces to `/mobile/done?return=...`.
   Old note: **The calendar OAuth flow never redirects back to `aireceptionistnow://`**,
   so the auth browser has to be dismissed by hand. The client already reads an
   `error` param off the returned URL, so it starts working the moment a bounce
   page exists.
5. **`/api/mobile/knowledge` collapses every website-import failure** into "That
   page could not be read.", discarding four distinct, already user-facing
   messages from `lib/knowledge/website.ts`.
6. **`/api/mobile/calendar` returns bookings and their own synced calendar
   events**, so a booking that reached the connected calendar appears twice. The
   app now de-duplicates client-side; the web dashboard still double-counts.
