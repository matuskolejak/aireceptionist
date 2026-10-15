# AI Receptionist Now - mobile

The phone-shaped half of [AI Receptionist Now](https://aireceptionistnow.com). It
answers one question the web dashboard cannot answer well from a pocket: *is my
receptionist working right now, and what did it just do?*

Expo (SDK 54) + expo-router, structured after the `mobileapp` project in this
same folder, but pointed at this product's data and palette.

---

## What it does

| Tab | What it shows |
|-----|---------------|
| **Home** | Answering / paused status, pause+resume, a live banner while a call is in progress, a **Today / This month** toggle (today's counts and activity feed; the month's totals, 30-day volume chart and sentiment donut), what needs attention with a link to each fix, upcoming appointments, minutes used and where they are heading |
| **Calls** | The full call log with search and status filters, tapping through to a call |
| **Calendar** | Every appointment the receptionist booked **merged with the events already on your connected calendar**, upcoming first, with sync failures called out |
| **Assistant** | Pause / resume each receptionist, the number it answers on, its opening line |
| **Settings** | Account, plan (bought and restored in-app), numbers, alert status, account deletion |

A **call detail** screen sits behind the Calls and Home tabs: transcript, what
the assistant actually did (bookings, messages, transfers), an in-app player for
the call audio, the accuracy-audit flag, and call-back / text-back /
copy-number actions. A live call polls every 5 seconds; a finished one does not
poll at all.

### Staying in step with the web

The dashboard is the source of truth for behaviour, and these are the places
the app used to quietly disagree with it - each one is worth not regressing:

- **The call log is inbound-only**, because `/dashboard/calls` hardcodes exactly
  that. The route ignores any client-supplied direction; honouring one let
  outbound rows (test calls, cancellation callbacks) into the phone's log that
  the web hides, so one account had two different call histories.
- **Screens refetch when they come forward.** A tab navigator keeps every tab
  mounted, so a mount-only fetch left Calls showing a list from an hour ago
  while the web - every dashboard route is `force-dynamic` - was current on the
  next click. See `STALE_MS` in [`lib/use-query.ts`](lib/use-query.ts).
- **The Calendar merges external events.** Bookings alone reported an emptier
  day than the dashboard did for the same account.
- **The month chart is 30 days**, from `analytics.volume` - not the 14-day
  `overview.callVolume`, which is a different series that was being drawn under
  a "This month" heading.
- **Every "needs attention" row goes somewhere**, with the same four rules and
  thresholds as the web overview.

Deliberate deviations, both defensible on a phone: needs-attention sits above
the activity feed rather than beside it, and the Calls tab keeps its status
chips (the web filters by `?status=` with no visible control).

### The four things it does that the dashboard cannot

1. **Push alerts.** A notification when a call ends, led by what the call
   produced - a failed booking and a flagged call read differently from
   "answered". Tapping one opens that call. The dashboard can only ever show
   you a missed call after you think to go and look.
2. **Play the call back.** Streamed from ElevenLabs through
   `/api/mobile/calls/[id]/recording` behind your bearer token, with 1x/1.5x/2x
   and 10-second skip. Note that `calls.recording_url` has never been written by
   anything, so this is the first surface in the product where call audio exists
   at all.
3. **Text the caller back.** From the line they rang, so their reply reaches the
   business rather than whoever's phone was nearest. Three templates, because
   this gets used one-handed.
4. **See the bill coming.** The minutes meter reports the past; the forecast
   next to it says where the month lands at the current rate and, when it
   matters, which day the allowance runs out. Being surprised by an overage is
   the loudest complaint in this category of product.

### What it deliberately does not do

- **Edit the assistant's config.** Voice, prompt, knowledge, escalation rules and
  transfer hours stay on the web. They are long-form settings with real
  consequences on a live phone line, and a half-finished edit typed one-handed
  is a worse outcome than opening a laptop.
- **Link to web billing.** Subscriptions are sold in-app through the App Store
  (StoreKit 2, `expo-iap`) and Google Play (RevenueCat), verified by the server;
  nothing in the app links to the website's checkout (App Store 3.1.3).
- **Query Supabase directly.** See below - it cannot, by design.

---

## Architecture

```
  App (Expo)
    │
    ├── Supabase JS ──────────► Supabase Auth        (sign-in ONLY, anon key)
    │                            email one-time code
    │
    └── fetch + Bearer <jwt> ─► Next.js /api/mobile/* (all data)
                                  │
                                  └── lib/dashboard/* on the service-role
                                      client, scoped by owner_id
```

**Why the app never reads Supabase tables directly.** Every operational table in
this product (`calls`, `assistants`, `phone_numbers`, `call_actions`, ...) has
RLS enabled with **no policies**. The web app reads them through the service-role
client server-side and scopes each query by `owner_id` in application code. The
anon key can therefore read nothing - a table query from here returns an empty
array, which looks exactly like "you have no calls yet" and is a genuinely
nasty bug to chase. All data goes through `/api/mobile/*`, which verifies the
Supabase access token and reuses the same owner-scoped functions the dashboard
uses. The service-role key never leaves the server.

The session lives in the OS keychain via `expo-secure-store`, chunked because a
Supabase session exceeds SecureStore's 2048-byte-per-entry guidance. See
[`lib/secure-storage.ts`](lib/secure-storage.ts).

### Layout

```
app/
  _layout.tsx          root stack + auth gate
  (auth)/sign-in.tsx   email one-time code
  (tabs)/              index | calls | calendar | assistant | settings
  call/[id].tsx        call detail
components/            Screen shell, BarChart, shared UI primitives
constants/theme.ts     the dashboard palette, ported from app/globals.css
context/AuthContext    Supabase session, sign-in, sign-out
lib/
  api.ts               typed client for /api/mobile/*
  types.ts             the wire shapes those routes return
  use-query.ts         fetch / refresh / 401-signs-you-out
  supabase.ts          auth client (never used for table reads)
  secure-storage.ts    chunked keychain adapter
  format.ts            phone, duration, relative time, owner-timezone dates
```

---

## Running it

```bash
npm install
cp .env.example .env      # then fill it in
npm start
```

`.env`:

| Variable | Notes |
|----------|-------|
| `EXPO_PUBLIC_API_URL` | Where the Next.js app is. Against a local `npm run dev`, use your machine's **LAN IP** (`http://192.168.x.x:3000`) - a phone or simulator cannot reach `localhost`. |
| `EXPO_PUBLIC_SUPABASE_URL` | Same project as the web app |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | The publishable/anon key. Public by design. |

Everything prefixed `EXPO_PUBLIC_` is embedded in the shipped binary and
readable by anyone who downloads the app. The service-role key is never one of
them.

`.env` is for local development only. It is gitignored, which also means EAS
Build never receives it: a cloud build reads `eas.json`'s per-profile `env` and
the project's EAS environment variables instead. `eas.json` pins
`EXPO_PUBLIC_API_URL` per profile so a release cannot inherit the localhost URL
in your `.env`; the two Supabase values come from `eas env:create`. See
[DEPLOY.md](DEPLOY.md), and run `npm run preflight production` to check what a
release would actually be built with.

**Push alerts need an EAS project id.** `getExpoPushTokenAsync` cannot mint a
token without one, and a fresh clone has none - run `eas init` (which writes
`extra.eas.projectId` into `app.json`) and rebuild. Until then the Alerts screen
says so in plain words rather than failing silently, and everything else works.
They also need a real device: a simulator has nothing for the push service to
route to.

Sign-in emails a 6-digit code through the same Supabase project the dashboard
uses, so an account works on both surfaces. Sign in with Apple (native on iOS)
and Google are wired up too - see "Sign-in providers" below.

### Server side

The app needs the `/api/mobile/*` routes, which live in the **`aireceptionistnow`**
repo: `app/api/mobile/` plus `lib/mobile/auth.ts`, `lib/mobile/push.ts`,
`lib/mobile/devices.ts` and `lib/mobile/plans.ts`. They must be deployed before a
build of this app can load anything.

Two migrations back features that fail soft without them:

| Migration | Without it |
| --- | --- |
| `0008_push_devices.sql` | Registration answers 500 and no alert is ever sent. |
| `0010_account_devices.sql` | Settings > Signed-in devices is always empty; registration answers `{ ok: false }` and logs a warning. Nothing else breaks. |

### Sign-in providers

Google and Apple go through Supabase's browser OAuth flow (`lib/oauth.ts`), the
same providers and the same project the web dialog uses. Two things must be true
in the Supabase dashboard or the buttons bounce at the provider:

1. **Authentication > Providers** - Google and Apple enabled (they already are).
2. **Authentication > URL Configuration > Redirect URLs** - both of these added:

   ```
   aireceptionistnow://auth-callback     # a real build
   exp://127.0.0.1:8081/--/auth-callback # Expo Go, dev only
   ```

   `oauthRedirectUri()` resolves to whichever of the two applies, so a missing
   entry shows up as "requested path is invalid" from GoTrue after the provider
   hands control back.

The client is on `flowType: 'pkce'`, so what travels in the deep link is a
one-time code rather than the tokens themselves - a scheme is claimable by any
app on the device.

### The funnel

Setup runs **signed out**, like the website's. Steps 1-3 are answered against a
local draft (`lib/onboarding-draft.ts`) and the plan step is where the account is
created; `flushDraft` replays the draft onto the account afterwards, guarding
every part against what the server already holds so a returning customer's
config is never overwritten. `lib/use-funnel.ts` hides which store is behind it.

The pickers and prices a guest sees come from `GET /api/mobile/catalog`, the one
unauthenticated route under `/api/mobile` - everything it serves is already
public on `/pricing`.

**The receptionist asks the questions.** Every screen has the same three zones,
built in `components/funnel.tsx`:

```
 ▁▁▁▁▁▁▁▁░░░░░░░░   one bar across all eight screens
 VOICE        4/8   which question, and how many are left
 ◕ Ava
 ╭──────────────╮   the question, as something it SAYS - fixed, never scrolls
 │ How should   │
 │ I sound?     │
 ╰──────────────╯
   [ answer ]       the only zone that scrolls
 ← [   Next   → ]   docked in the thumb zone
```

That shape came out of looking at the first pass at real phone size, where three
things were wrong: two progress systems competing (four dots AND a five-bar
rail, so neither answered "how much is left"), a card floating with ~160pt of
dead background under it and the primary button floating with it out of thumb
reach, and Back sitting *below* Next.

Step 1 is the web's `MeetAssistant` - the same five questions in the same order
(business, name, country, voice, transfer) - and steps 2-4 keep the character
asking, so the thing you named is still there when you teach it.

| Web | App | Why it differs |
| --- | --- | --- |
| `AiAvatar` + `LiveAvatar` | `components/avatar.tsx` | Same head, same `MOUTHS` paths, same moods. The web tracks the cursor; the app has none, so the eyes glance on their own and follow the last tap. |
| Voice described in text | Voice **plays**, avatar's mouth moves | A phone has a speaker. Picking a phone voice by reading about it was the weakest beat in the web funnel. |
| CSS keyframes | `Animated` + `react-native-svg` | Float, nod and success pop are native-driver view transforms; blink, gaze and mouth are SVG props. See the header comment in `avatar.tsx` for why it is split. |
| Green tick on success | The avatar, celebrating | The payoff should be the character you just built, not a checkmark. |
| Headings above fields | The question in a speech bubble | The product is a thing that talks to your customers; setting it up should read as a conversation with it, and it gives the avatar a job on every screen instead of decorating step 1. |
| CSS `prefers-reduced-motion` | `AccessibilityInfo.isReduceMotionEnabled` | With it on, the ambient loops (float, blink, glance) never start. The nod, the mouth and the expression stay - they are responses to something you did. |

`lib/personality.ts` is a verbatim port of the web's regexes on purpose: both
funnels read the same ElevenLabs descriptions, and a phone that decides a voice
is "calm" while the site decides it is "friendly" gives one product two faces.

---

## Checks

```bash
npm run verify    # typecheck + lint + preflight + bundle every route
npm start         # then load the app
```

`verify` is the one to run before a build. Its four parts each catch something
the others cannot:

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # expo lint
npm run preflight   # the EXPO_PUBLIC_* values a build would actually bake in
npm run doctor      # expo-doctor: SDK versions, duplicate native modules
npx expo export --platform ios   # bundles every route; catches what tsc cannot,
                                 # because tsc never resolves a route file
                                 # nothing imports
```

`npm run preflight <profile>` reconstructs what a named EAS profile would see -
`eas.json`'s env first, then `.env` - so `npm run preflight production` tells
you whether a release build would come out pointed at your laptop. It also runs
on the EAS worker as `eas-build-pre-install`, where it fails the build rather
than letting a binary with an empty API URL reach TestFlight.

Shipping to the stores: [DEPLOY.md](DEPLOY.md).
