# Store listing (App Store and Google Play)

Draft copy for both stores, written from what the app and the backend actually do.
Paste it into App Store Connect and the Play Console by hand; nothing here is pushed
by a script.

Rules this copy follows (from the web repo's claim audit, keep them):
- Never "free", "trial", "no card", HIPAA, or invented testimonials.
- Name only integrations that exist: Google Calendar, Microsoft Outlook.
- No refund promise in the store copy: App Store and Play refunds go through
  Apple and Google, so the website's 30-day guarantee does not apply as written.

## App Store

| Field | Limit | Text |
|---|---|---|
| Name | 30 | AI Receptionist Now |
| Subtitle | 30 | Answer every business call |
| Promotional text | 170 | Your phone, answered 24/7. Set up an AI receptionist in minutes: it picks up, books appointments into your calendar and texts you what matters. |
| Keywords | 100 | answering service,virtual,spa,phone,missed,booking,appointment,scheduler,voicemail,front desk,salon |
| Category | | Business (secondary: Productivity) |
| Age rating | | 4+ |

Keywords: the name and subtitle already index "AI", "receptionist", "answer", "business",
"call"; repeating them wastes characters. Check the 100-character count after edits.

### Description

```
Never lose a customer to voicemail again.

AI Receptionist Now answers your business phone 24/7 with a natural-sounding voice. It
greets callers with your business name, answers their questions, books appointments into
your calendar and puts urgent calls through to you. When a call ends, you get a
notification with what happened.

SET UP IN MINUTES, ON YOUR PHONE
- Name your business and your receptionist
- Pick its voice: tap to hear each one
- Teach it your hours, prices and services in plain words
- Connect Google Calendar or Outlook so it books real slots
- Get a local phone number and go live

SEE EVERY CALL FROM YOUR POCKET
- Alerts the moment a call ends, led by what it produced: a booking, a message, a transfer
- Read the transcript or play the recording at 1x, 1.5x or 2x
- Text the caller back from your business line
- Pause and resume your receptionist with one switch
- Watch your minutes and see where the month will land

BUILT FOR SMALL BUSINESSES
Salons, clinics, trades, restaurants, real estate, law offices and anyone who cannot stop
mid-job to pick up the phone.

SUBSCRIPTION
AI Receptionist Now requires a Solo or Team subscription, billed monthly or yearly through
your Apple ID. Payment is charged at confirmation of purchase. The subscription renews
automatically unless cancelled at least 24 hours before the end of the current period.
Manage or cancel it in your App Store account settings.

Terms of Service: https://aireceptionistnow.com/terms-of-service
Privacy Policy: https://aireceptionistnow.com/privacy-policy
```

### Review notes (App Review Information)

```
Sign in: tap "Sign in", enter the review email below and tap "Email me a code", then enter
the review code below. This account is already set up with a receptionist and sample calls.

Subscriptions are sold with StoreKit (Solo and Team, monthly and yearly). Phone calls are
answered by our server; the app shows them, plays recordings and sends alerts.

AI processing: calls are transcribed and answered by third-party AI providers (ElevenLabs
for voice). The app asks for consent before a subscription starts this processing.
```

Fill in the review email and code from the server's review-login config
(`lib/mobile/review-login.ts` in the web repo); never commit them here.

## Google Play

| Field | Limit | Text |
|---|---|---|
| App name | 30 | AI Receptionist Now |
| Short description | 80 | An AI receptionist that answers your business calls 24/7 and books appointments. |
| Category | | Business |
| Tags | | Business, Productivity, Communication |

Full description: the App Store description above, with the SUBSCRIPTION paragraph
replaced by:

```
SUBSCRIPTION
AI Receptionist Now requires a Solo or Team subscription, billed monthly or yearly through
Google Play. It renews automatically until cancelled. Manage or cancel it any time in
Google Play > Payments & subscriptions.
```

## Screenshots

Six frames, in this order; each caption is one line over the screen:

1. First setup question with the receptionist avatar: "Every call answered, even when you can't pick up"
2. Home, answering, today's calls: "See what your receptionist did today"
3. Call detail with transcript and player: "Read or replay every call"
4. Voice question in setup: "Pick a voice you like, hear it first"
5. Calendar with bookings: "Bookings land in your calendar"
6. Plan step: "Live on your own number in minutes"

Sizes: App Store needs 6.9" (1320 x 2868, iPhone 17 Pro Max simulator) at minimum; Play
needs at least 2 phone screenshots (1080 x 1920 or larger) and a 1024 x 500 feature graphic.
Capture with mock data (`EXPO_PUBLIC_MOCK=1`, see `.env.example`), so no real caller
numbers appear.
