#!/usr/bin/env node
/**
 * Fails a build that would produce a broken binary.
 *
 * Every EXPO_PUBLIC_* value is read at BUNDLE time and inlined into the
 * JavaScript. A missing one does not throw - it becomes the empty string, and
 * the app ships looking fine until the first request, which goes to `/api/...`
 * with no host. `.env` is gitignored and is therefore NOT uploaded to EAS
 * Build, so a cloud build sees only what `eas.json` env and the project's EAS
 * environment variables provide. That gap is the single most likely way this
 * app reaches TestFlight dead.
 *
 * Runs in three places:
 *   npm run preflight                 - by hand
 *   npm run build:*                   - before handing off to EAS
 *   eas-build-pre-install             - on the EAS worker itself, so a build
 *                                       started from CI or the dashboard is
 *                                       covered too
 *
 * By hand: node scripts/preflight.mjs [profile] [ios|android]. The platform
 * defaults to both; on EAS it comes from EAS_BUILD_PLATFORM. Without a
 * platform, a local run only notes missing Android-only inputs.
 *
 * Plain Node with no imports beyond node: builtins, because on an EAS worker
 * this runs before `npm install`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** EAS sets this; locally it is undefined. */
const profile = process.env.EAS_BUILD_PROFILE ?? process.argv[2] ?? 'local';
const isRelease = profile === 'production' || profile === 'preview';
/** EAS sets this to ios or android; locally pass it as the second argument. */
const platform = process.env.EAS_BUILD_PLATFORM ?? process.argv[3] ?? 'all';
const checksAndroid = platform === 'android' || platform === 'all';
/**
 * The Android-only inputs (RevenueCat key, google-services.json) normally live only in the
 * EAS environment, which a laptop cannot see. A local run that names no platform (npm run
 * build:*) would fail on them even for an iOS build, so there they are notes; the
 * eas-build-pre-install run on the worker enforces them with the real env and platform.
 */
const androidStrict = platform === 'android' || Boolean(process.env.EAS_BUILD);

const problems = [];
const notes = [];

/** Keys filled from the local .env only. EAS Build never receives .env (it is gitignored). */
const fromDotEnv = new Set();

const set = (key, value) => {
  if (value === undefined || process.env[key] !== undefined) return false;
  process.env[key] = value;
  return true;
};

// On an EAS worker the env is already populated from eas.json + the project's
// EAS environment variables, so leave it alone. Locally, reconstruct what the
// named profile WOULD see: eas.json's env for that profile first (it is what
// the build actually uses), then .env as the fallback for anything eas.json
// does not pin. Without this, checking the production profile from a laptop
// just re-reads the local .env and reports a failure that would not happen.
if (!process.env.EAS_BUILD) {
  try {
    const easJson = JSON.parse(readFileSync(join(root, 'eas.json'), 'utf8'));
    const profileEnv = easJson?.build?.[profile]?.env ?? {};
    for (const [key, value] of Object.entries(profileEnv)) set(key, value);
  } catch {
    notes.push('No readable eas.json; checking against the ambient environment only.');
  }
  try {
    for (const line of readFileSync(join(root, '.env'), 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (m && set(m[1], m[2].trim().replace(/^["']|["']$/g, ''))) fromDotEnv.add(m[1]);
    }
  } catch {
    notes.push('No .env file found; relying on the ambient environment.');
  }
}

const required = [
  'EXPO_PUBLIC_API_URL',
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_ANON_KEY',
];

for (const key of required) {
  const value = (process.env[key] ?? '').trim();
  if (!value) {
    problems.push(
      `${key} is empty. For an EAS build, set it in eas.json under build.${profile}.env, ` +
        `or as a project environment variable: eas env:create --name ${key}`,
    );
  }
}

const apiUrl = (process.env.EXPO_PUBLIC_API_URL ?? '').trim();

// A release build pointed at a laptop is the failure this whole script exists
// for: it passes every other check, installs cleanly, and shows "No connection"
// on every screen for every user.
if (isRelease && apiUrl) {
  if (!apiUrl.startsWith('https://')) {
    problems.push(
      `EXPO_PUBLIC_API_URL is "${apiUrl}" for the "${profile}" profile. A release build must use ` +
        `https - iOS App Transport Security blocks cleartext http, and a LAN address is ` +
        `unreachable from any device but your own.`,
    );
  }
  if (/localhost|127\.0\.0\.1|\b10\.|\b192\.168\.|\b172\.(1[6-9]|2\d|3[01])\./.test(apiUrl)) {
    problems.push(
      `EXPO_PUBLIC_API_URL is "${apiUrl}" for the "${profile}" profile - that is a local or ` +
        `LAN address. Point it at the deployed Next.js app.`,
    );
  }
}

// Android in-app purchases go through RevenueCat. Without its public SDK key the
// paywall has nothing to sell, and nothing fails until a user taps Subscribe.
// A secret key (sk_...) here would be worse: it would ship inside the binary. That
// check runs for every platform, because EXPO_PUBLIC_ values are inlined into the
// shared JavaScript and an iOS build carries the key too.
const rcKey = (process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY ?? '').trim();
const rcKeyMessage = (what) =>
  `EXPO_PUBLIC_REVENUECAT_ANDROID_KEY is ${what} for the "${profile}" profile. Set the ` +
  `RevenueCat Android public SDK key (never the secret key): eas env:create --name ` +
  `EXPO_PUBLIC_REVENUECAT_ANDROID_KEY.`;

if (isRelease && rcKey && !rcKey.startsWith('goog_')) {
  problems.push(rcKeyMessage('not a public Google key (goog_...)'));
}

if (isRelease && checksAndroid) {
  const androidMissing = (message) => {
    if (androidStrict) {
      problems.push(message);
    } else {
      notes.push(
        `${message} Not enforced in a local run without a platform: eas-build-pre-install ` +
          `checks it on the Android worker (pass "android" to check it here).`,
      );
    }
  };

  if (!rcKey) androidMissing(rcKeyMessage('empty'));

  // Android push needs the Firebase client config compiled in (see app.config.js);
  // without it getExpoPushTokenAsync throws and call alerts never arrive.
  if (!process.env.GOOGLE_SERVICES_JSON && !existsSync(join(root, 'google-services.json'))) {
    androidMissing(
      `No google-services.json for the "${profile}" Android build, so push notifications ` +
        `cannot register. Upload it as a file variable: eas env:create --name ` +
        `GOOGLE_SERVICES_JSON --type file, or place it in the project root for a local build.`,
    );
  }
}

// The mock API and mock store are __DEV__-only in code, so a release build ignores
// them anyway. A release profile that sets them is still a mistake worth stopping.
// A flag that only lives in the local .env is left as a note: that is where
// day-to-day mock development sets it, and the cloud build never sees the file.
if (isRelease) {
  for (const key of ['EXPO_PUBLIC_MOCK', 'EXPO_PUBLIC_IAP_MOCK']) {
    const value = (process.env[key] ?? '').trim().toLowerCase();
    if (!value || value === '0' || value === 'false') continue;
    if (fromDotEnv.has(key)) {
      notes.push(`${key} is set in .env; EAS Build does not receive .env, so the "${profile}" build is unaffected.`);
    } else {
      problems.push(
        `${key} is "${process.env[key]}" for the "${profile}" profile. Mock flags are for ` +
          `local development only; remove it from eas.json and the EAS environment.`,
      );
    }
  }
}

if (apiUrl.endsWith('/')) {
  notes.push(`EXPO_PUBLIC_API_URL has a trailing slash; lib/api.ts strips it, so this is harmless.`);
}

// Push notifications cannot mint a token without an EAS project id, and the
// failure is silent at build time - the Alerts screen reports it at runtime
// instead. Worth surfacing before a release rather than after.
try {
  const appJson = JSON.parse(readFileSync(join(root, 'app.json'), 'utf8'));
  const projectId = appJson?.expo?.extra?.eas?.projectId;
  if (!projectId) {
    const message =
      'app.json has no extra.eas.projectId, so getExpoPushTokenAsync cannot mint a token and ' +
      'push alerts will not work in this build. Run `eas init` to write one.';
    if (isRelease) problems.push(message);
    else notes.push(message);
  }
  if (isRelease && appJson?.expo?.ios?.supportsTablet) {
    problems.push(
      'app.json has ios.supportsTablet: true. Version 1.0 is iPhone-only; an iPad build needs ' +
        'its own screenshots and review pass.',
    );
  }
  if (appJson?.expo?.ios?.bundleIdentifier !== appJson?.expo?.android?.package) {
    notes.push('iOS bundle identifier and Android package differ; confirm that is intended.');
  }
} catch (err) {
  problems.push(`Could not read app.json: ${err.message}`);
}

for (const note of notes) console.log(`  note: ${note}`);

if (problems.length > 0) {
  console.error(`\npreflight failed for profile "${profile}":\n`);
  for (const p of problems) console.error(`  - ${p}\n`);
  process.exit(1);
}

console.log(`preflight ok (profile: ${profile}, platform: ${platform}, api: ${apiUrl})`);
