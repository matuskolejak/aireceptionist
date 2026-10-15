import * as Haptics from 'expo-haptics';
import * as ExpoLinking from 'expo-linking';
import { useFocusEffect, useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useRef, useState, type Ref } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  AppState,
  BackHandler,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { inputStyleLg, Sheet } from '@/components/form';
import { Actions, Ask, CHAPTERS, FunnelHeader, Pill } from '@/components/funnel';
import { Icon } from '@/components/Icon';
import {
  CountryPicker,
  MeetAssistant,
  type BasicsValues,
  type MeetAssistantHandle,
} from '@/components/meet-assistant';
import {
  AiConsent,
  AiProcessingNotice,
  PaywallLegalLinks,
  PurchasesUnavailableNotice,
  SubscriptionDisclosure,
  TermsConsent,
} from '@/components/paywall';
import { CycleToggle, PlanCard } from '@/components/plans';
import {
  Button,
  cardStyle,
  ErrorState,
  ICON,
  Loading,
  Notice,
  pressed,
  StaleNotice,
} from '@/components/ui';
import { colors, control, fonts, radius, spacing, type } from '@/constants/theme';
import { useAuth } from '@/context/AuthContext';
import { usePurchases } from '@/context/PurchaseContext';
import { useSetupGate } from '@/context/SetupGate';
import { useAiConsent } from '@/lib/ai-consent';
import { api } from '@/lib/api';
import { formatPhone } from '@/lib/format';
import { dial } from '@/lib/links';
import type { DraftBasicsPartial } from '@/lib/onboarding-draft';
import { voicePersonality, type Mood } from '@/lib/personality';
import { STORE_NAME, type PlanKey } from '@/lib/purchases';
import { usePaywall } from '@/lib/purchases/use-paywall';
import { markPrimerAnswered, primerAnswered, requestAndRegister } from '@/lib/push';
import type { CalendarConnections, OnboardingState, ProvisionPoll } from '@/lib/types';
import { useFunnel, type Funnel } from '@/lib/use-funnel';
import { useQuery } from '@/lib/use-query';

/**
 * Setup, on a phone.
 *
 * Runs signed OUT, like the website's funnel does: steps 1-3 are answered before
 * anyone is asked for an account, and the plan step is where signing up happens.
 * `useFunnel` hides which store is behind it - a local draft for a guest, the
 * server for a session - and replays the draft onto the account on sign-in, so
 * nothing typed before signing up is retyped after.
 *
 * The web gates URL-jumping with a cookie; a native stack cannot be deep-linked
 * past a step, so the gate is simply which step this screen renders.
 *
 * The plan step sells the subscription through the App Store / Google Play
 * (`usePaywall`, lib/purchases): the purchase is verified by the server, which
 * marks the account paid and starts provisioning, and this screen then polls
 * until the number is live. Nothing here links to a web purchase.
 */
export default function OnboardingScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { markSetupDone } = useSetupGate();
  const { session, email, signOut } = useAuth();
  const funnel = useFunnel(Boolean(session), email);
  const { state: data, error, loading, refresh } = funnel;
  const [step, setStep] = useState<number | null>(null);
  // Which of step 1's questions to open on when the caller has walked BACK into
  // them. Read once per mount - see `back`.
  const [basicsEntry, setBasicsEntry] = useState<number | null>(null);
  const basicsBack = useRef<MeetAssistantHandle>(null);

  // Signing in keeps this screen mounted, and the guest's local position (the
  // plan step, where they tapped "Create my account") is not the account's:
  // the server decides where a new session resumes.
  const [wasGuest, setWasGuest] = useState(funnel.guest);
  if (wasGuest !== funnel.guest) {
    setWasGuest(funnel.guest);
    setStep(null);
    setBasicsEntry(null);
  }

  // Where step 1 is inside its own five questions, reported upward so the one
  // progress bar covers all eight screens rather than resetting per chapter.
  const [sub, setSub] = useState({ index: 0, total: 5, chapter: 'Business' });
  const onSubstep = useCallback(
    (index: number, total: number, chapter: string) => setSub({ index, total, chapter }),
    [],
  );

  // The server decides how far the user has got; local state only moves forward
  // from there, and a refresh re-syncs. Without the `?? server` fallback a
  // completed step would bounce back on every refetch.
  const current = step ?? data?.step ?? 1;

  // Tell the root gate before navigating. It probed `done` once at sign-in and
  // still holds the answer from then, so leaving without flipping it means it
  // immediately redirects back here.
  useEffect(() => {
    if (data?.done) {
      markSetupDone();
      router.replace('/(tabs)');
    }
  }, [data?.done, markSetupDone, router]);

  const advance = useCallback(
    async (next: number) => {
      setStep(next);
      await refresh();
    },
    [refresh],
  );

  /**
   * The way back out of a screen.
   *
   * Nothing is re-submitted on the way back - every step's `act` has already
   * run - so this is purely which screen renders.
   */
  const back = useCallback(
    (to: number) => {
      // Back into the questions lands on the LAST one asked, not the first.
      if (to === 1) setBasicsEntry(sub.total - 1);
      setStep(to);
    },
    [sub.total],
  );

  // A guest has nothing to provision - there is no account to buy a number for.
  // Unpaid never provisions either: the server answers 'waiting-payment' for
  // ever, so an account whose billing lapsed mid-setup goes back to the plan
  // step instead of a spinner with no way out.
  const showProvisioning =
    data !== null &&
    !funnel.guest &&
    data.paid &&
    (data.status === 'provisioning' || data.status === 'error' || current >= 4);

  /**
   * Android's back button walks the funnel instead of leaving the app: a
   * previous step, then a previous question, and only on the very first
   * question does it fall through to the system (which backgrounds the app).
   * While a number is being bought there is nowhere to go back to. Focus-scoped
   * so a screen stacked on top (sign-in) keeps its own back behaviour.
   */
  useFocusEffect(
    useCallback(() => {
      const handler = BackHandler.addEventListener('hardwareBackPress', () => {
        if (!data) return false;
        if (showProvisioning) return true;
        if (current > 1) {
          back(current - 1);
          return true;
        }
        return basicsBack.current?.goBack() ?? false;
      });
      return () => handler.remove();
    }, [data, showProvisioning, current, back]),
  );

  /** Who is signed in, and the two ways out (App Store 5.1.1(v): deletion before setup too). */
  const openAccount = useCallback(() => {
    const title = email ? `Signed in as ${email}` : 'Signed in';
    const remove = () => router.push('/settings/delete-account');
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title,
          options: ['Sign out', 'Delete account', 'Cancel'],
          destructiveButtonIndex: 1,
          cancelButtonIndex: 2,
        },
        (index) => {
          if (index === 0) void signOut();
          else if (index === 1) remove();
        },
      );
      return;
    }
    Alert.alert(title, undefined, [
      { text: 'Sign out', onPress: () => void signOut() },
      { text: 'Delete account', style: 'destructive', onPress: remove },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [email, router, signOut]);

  // A signed-in first load is the account being read (and a guest draft
  // replayed onto it): the same calm wait either way, never a bare spinner
  // between the sign-in screen and the next step.
  if (loading) return funnel.guest ? <Loading /> : <Saving flushing={funnel.flushing} />;
  // Only a missing payload is fatal. A failed revalidation still has the last
  // good state to render, and unmounting the funnel mid-step over one lost
  // packet would throw away everything typed into it.
  if (!data) return <ErrorState message={error ?? 'Could not load your setup.'} onRetry={refresh} />;

  // One bar across the whole funnel: step 1's five questions, then one screen
  // each for knowledge, appointments, the account and the plan. A guest's plan
  // step is where the account gets created, so it counts as the account
  // screen (8 of 9); the same step signed in is the last one (9 of 9). The
  // bar never reaches the end with a purchase still ahead, and never steps
  // backwards after sign-up.
  const total = sub.total + 4;
  const atPlan = current >= 4;
  const position =
    current === 1 ? sub.index + 1 : sub.total + (current - 1) + (atPlan && !funnel.guest ? 1 : 0);
  // Step 1 names the question you are on rather than the chapter it belongs to:
  // "Voice" says more about where you are than "The basics" five times running.
  const chapter =
    current === 1
      ? sub.chapter
      : atPlan
        ? CHAPTERS[funnel.guest ? 3 : 4]
        : CHAPTERS[Math.min(current - 1, 2)];

  return (
    <KeyboardAvoidingView
      style={[styles.root, { paddingTop: insets.top + spacing.sm }]}
      // Both platforms: app.json turns on edge-to-edge, which stops Android
      // resizing the window for the keyboard, so nothing else lifts the docked
      // actions above it there.
      behavior="padding"
      // `padding` pads THIS view by however much the keyboard covers, and `body`
      // below then pads by the home-indicator inset inside that - so with the
      // keyboard up the funnel reserved the bottom inset underneath a keyboard
      // that was already covering it. A negative offset takes the inset back out
      // of the keyboard's clearance instead of stacking it on top. On hide RN
      // zeroes the padding without consulting the offset, so `body`'s inset
      // still stands.
      keyboardVerticalOffset={-insets.bottom}
    >
      {!showProvisioning && (
        <FunnelHeader
          chapter={chapter}
          position={position}
          total={total}
          onSignIn={funnel.guest ? () => router.push('/(auth)/sign-in') : undefined}
          onAccount={funnel.guest ? undefined : openAccount}
        />
      )}

      {error ? (
        <View style={styles.stale}>
          <StaleNotice
            message={error}
            onRetry={refresh}
            // A guest whose catalogue never arrived has seen no update to show.
            firstLoad={funnel.guest && !funnel.catalog}
          />
        </View>
      ) : null}

      <View style={[styles.body, { paddingBottom: insets.bottom }]}>
        {showProvisioning ? (
          <Provisioning assistantName={data.config.assistantName} />
        ) : current === 1 ? (
          <BasicsStep
            state={data}
            funnel={funnel}
            startAt={basicsEntry ?? funnel.resumeQuestion}
            onSubstep={onSubstep}
            backRef={basicsBack}
            onDone={() => advance(2)}
          />
        ) : current === 2 ? (
          <KnowledgeStep
            state={data}
            funnel={funnel}
            onRefresh={refresh}
            onBack={() => back(1)}
            onDone={() => advance(3)}
          />
        ) : current === 3 ? (
          <CalendarStep
            state={data}
            funnel={funnel}
            onRefresh={refresh}
            onBack={() => back(2)}
            onDone={() => advance(4)}
          />
        ) : (
          <PlanStep state={data} funnel={funnel} onRefresh={refresh} onBack={() => back(3)} />
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

/**
 * The first signed-in load: the account being read, and - `flushing` - a guest
 * draft being replayed onto it. The same character as every other wait in the
 * funnel, so signing in does not look like a relaunch.
 */
function Saving({ flushing }: { flushing: boolean }) {
  return (
    <View style={[styles.root, styles.center]}>
      <Avatar mood="studying" size={104} label="Your receptionist" />
      <ActivityIndicator color={colors.ink} style={styles.spinner} />
      <Text style={styles.savingText} accessibilityLiveRegion="polite">
        {flushing ? 'Saving your setup...' : 'Opening your account...'}
      </Text>
    </View>
  );
}

function BasicsStep({
  state,
  funnel,
  startAt,
  onSubstep,
  backRef,
  onDone,
}: {
  state: OnboardingState;
  funnel: Funnel;
  startAt: number;
  onSubstep: (index: number, total: number, chapter: string) => void;
  backRef: Ref<MeetAssistantHandle>;
  onDone: () => void;
}) {
  const { email } = useAuth();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { saveBasicsPartial } = funnel;

  async function save(values: BasicsValues) {
    setBusy(true);
    setErr(null);
    try {
      await funnel.act({ action: 'basics', ...values });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const onPartial = useCallback(
    (values: DraftBasicsPartial & { question: number }) => saveBasicsPartial(values),
    [saveBasicsPartial],
  );

  return (
    <MeetAssistant
      state={state}
      catalog={funnel.catalog}
      // A guest has no address yet; the replay after sign-up fills in the
      // account's own email as the summaries address.
      defaultEmail={state.config.alertsEmail || email}
      busy={busy}
      error={err}
      startAt={startAt}
      onSubstep={onSubstep}
      onPartial={funnel.guest ? onPartial : undefined}
      onSubmit={(values) => void save(values)}
      backRef={backRef}
    />
  );
}

/**
 * The face the later steps wear: whatever personality the chosen voice implies,
 * so the assistant a caller met on step 1 is recognisably the same one here.
 * Falls back to the warm default before a voice exists.
 */
function moodOf(state: OnboardingState, funnel: Funnel): Mood {
  const voice = funnel.catalog?.voices.find((v) => v.voiceId === state.config.voiceId);
  return voicePersonality(voice?.name, voice?.description).mood;
}

// ── Step 2: what it knows ───────────────────────────────────────────────────

/**
 * The four things callers ring to ask, as openers for the notes box.
 *
 * This step decides how good the answers on a live line are, and it was the one
 * most often skipped - not because people had nothing to say, but because an
 * empty box asking "what should I know?" is an essay prompt. Tapping a topic
 * starts the sentence, which turns the task into finishing it.
 */
const STARTERS = [
  { label: 'Opening hours', seed: 'We are open ' },
  { label: 'Prices', seed: 'A ' },
  { label: 'Where we are', seed: 'We are at ' },
  { label: 'Parking', seed: 'Parking is ' },
] as const;

function KnowledgeStep({
  state,
  funnel,
  onRefresh,
  onBack,
  onDone,
}: {
  state: OnboardingState;
  funnel: Funnel;
  onRefresh: () => Promise<void>;
  onBack: () => void;
  onDone: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const notesRef = useRef<TextInput>(null);
  /**
   * Explicit permission before anything reaches the third-party AI (App Store
   * 5.1.2(i)): what is taught here is summarised by Gemini the moment it is
   * sent. Continuing without teaching sends nothing, so only teaching waits -
   * and it is asked for on the first "Teach me this" tap, not as a block of
   * legal text above an empty box. Once given it is remembered on the device
   * and never asked again (the plan step and the Knowledge screen read the
   * same record).
   */
  const consent = useAiConsent();
  const aiOk = consent.given === true;
  // The consent box is on screen: a Teach tap (or a note waiting since
  // sign-up) asked for it.
  const [askConsent, setAskConsent] = useState(false);
  // A Teach tap that is waiting on the consent box, taught the moment it is ticked.
  const [queued, setQueued] = useState(false);

  const sources = state.config.sources;
  const pendingNotes = funnel.pendingNotes;

  /**
   * What the caller has TAUGHT it, not what it knows. `nudge` is a bump: the
   * avatar plays the same approving forward tilt on any change to it, so it is
   * fed the one event it actually means - a removal is already answered by its
   * own haptic and by the row disappearing.
   */
  const [nods, setNods] = useState(0);

  // Notes typed as a guest that the sign-up replay held back for want of
  // consent go the moment it is given.
  const hasPending = pendingNotes.length > 0;
  useEffect(() => {
    if (aiOk && hasPending) void onRefresh();
    else if (!aiOk && hasPending) setAskConsent(true);
    // Only the consent and the queue's existence retrigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiOk, hasPending]);

  async function teach(typed: string) {
    await funnel.act({ action: 'add-text', text: typed });
    setText('');
    await onRefresh();
    setNods((n) => n + 1);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }

  async function add() {
    const typed = text.trim();
    if (!typed) return;
    if (!aiOk) {
      // Asked here, at the moment it matters, and the tap is kept: ticking the
      // box teaches what was typed without a second press.
      setAskConsent(true);
      setQueued(true);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await teach(typed);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (aiOk && queued) {
      setQueued(false);
      void add();
    }
    // Only the consent landing releases the queued tap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiOk, queued]);

  // Deleting knowledge is destructive and the target is a small icon, so it is
  // confirmed the way the Knowledge tab does it. The request must be awaited
  // inside a handler that catches: an unhandled rejection here is invisible and
  // the row simply stays put, which reads as a dead button.
  function confirmRemove(id: string, title: string) {
    Alert.alert('Remove this?', `"${title}" stops informing my answers.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          setErr(null);
          try {
            await funnel.act({ action: 'remove-source', id });
            await onRefresh();
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          } catch (e) {
            setErr((e as Error).message);
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          }
        },
      },
    ]);
  }

  async function leave(typed: string) {
    setBusy(true);
    setErr(null);
    try {
      // Whatever is still in the box goes with them. The big dark Continue is
      // the button people press, and a note typed and then lost to it is the
      // one thing this step must not do.
      if (typed) await teach(typed);
      await funnel.act({ action: 'knowledge-done' });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function next() {
    const typed = text.trim();
    if (typed && !aiOk) {
      // It cannot be taught without consent, and it must not vanish silently.
      Alert.alert('Save what you typed?', 'Agree to AI processing to keep it, or continue without it.', [
        { text: 'Keep editing', style: 'cancel', onPress: () => setAskConsent(true) },
        { text: 'Continue without it', style: 'destructive', onPress: () => void leave('') },
      ]);
      return;
    }
    void leave(typed);
  }

  const canAdd = Boolean(text.trim()) && !busy;

  return (
    <View style={styles.step}>
      <Ask
        // It is literally reading while this runs, so it wears the reading face
        // - the eyes stop wandering and the mouth narrows. That is the whole
        // difference between a spinner and a character.
        mood={busy ? 'studying' : moodOf(state, funnel)}
        name={state.config.assistantName}
        question="What should I know?"
        sub="Your hours, your prices, where you are - whatever callers ask most."
        nudge={nods}
      />

      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.stepContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        {sources.map((src) => (
          <View key={src.id} style={styles.sourceRow}>
            <Icon
              name={src.kind === 'website' ? 'globe-outline' : 'document-text-outline'}
              size={ICON.row}
              color={colors.textSecondary}
            />
            <View style={styles.flex}>
              <Text style={styles.sourceTitle} numberOfLines={1}>
                {src.title}
              </Text>
              {Boolean(src.summary) && (
                <Text style={styles.sourceSummary} numberOfLines={2}>
                  {src.summary}
                </Text>
              )}
            </View>
            <Pressable
              onPress={() => confirmRemove(src.id, src.title)}
              hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${src.title}`}
            >
              <Icon name="close" size={ICON.row} color={colors.textSecondary} />
            </Pressable>
          </View>
        ))}

        {pendingNotes.map((note, i) => (
          <View key={`pending-${i}`} style={styles.sourceRow}>
            <Icon name="time-outline" size={ICON.row} color={colors.textSecondary} />
            <View style={styles.flex}>
              <Text style={styles.sourceTitle} numberOfLines={1}>
                {note.split('\n').find((l) => l.trim()) ?? note}
              </Text>
              <Text style={styles.sourceSummary}>
                {aiOk ? 'Sending...' : 'Not sent yet - agree below and I learn this.'}
              </Text>
            </View>
          </View>
        ))}

        {/* Above the box, because they are how you start writing in it. */}
        <View style={styles.starters}>
          {STARTERS.map((s) => (
            <Pill
              key={s.label}
              label={s.label}
              onPress={() => {
                // Appended, so tapping three topics builds one note rather than
                // replacing the last. The caret is left at the end either way.
                setText((cur) => (cur.trim() ? `${cur.replace(/\s+$/, '')}\n${s.seed}` : s.seed));
                notesRef.current?.focus();
              }}
            />
          ))}
        </View>

        <TextInput
          ref={notesRef}
          style={styles.notes}
          value={text}
          onChangeText={setText}
          placeholder={'We are open 8-6 Monday to Friday.\nA checkup is €45.\nParking is free out back.'}
          placeholderTextColor={colors.textMuted}
          accessibilityLabel="What your receptionist should know"
          multiline
          textAlignVertical="top"
        />
        <Pressable
          onPress={() => void add()}
          disabled={!canAdd}
          accessibilityRole="button"
          accessibilityLabel="Teach me this"
          accessibilityState={{ disabled: !canAdd, busy }}
          style={({ pressed: down }) => [
            styles.addRow,
            down && pressed,
            !canAdd && styles.addRowOff,
          ]}
        >
          <Icon name="add" size={ICON.row} color={canAdd ? colors.ink : colors.textSecondary} />
          <Text style={[styles.addText, !canAdd && styles.addTextOff]}>Teach me this</Text>
        </Pressable>

        {/* The consent, asked once and only when something is about to be
            sent. Given, it collapses to one line with the policy a tap away. */}
        {aiOk ? (
          <AiProcessingNotice compact />
        ) : askConsent ? (
          <View style={styles.consent}>
            <AiConsent
              accepted={false}
              onChange={(next) => {
                if (next) void consent.give();
              }}
            />
          </View>
        ) : null}

        {state.config.companyWebsite ? (
          <Text style={styles.hint}>
            I will also read {state.config.companyWebsite} before your first call.
          </Text>
        ) : null}
        {/* Says the step is optional without putting "skip" on the button. */}
        {sources.length === 0 && (
          <Text style={styles.hint}>
            Nothing to hand? Carry on - you can teach me any time from Knowledge.
          </Text>
        )}
        {err ? <Text style={styles.error}>{err}</Text> : null}
      </ScrollView>

      <Actions
        primary={{
          // Never "Skip" on the primary. A step this decisive for answer
          // quality should not have the biggest, darkest control on screen
          // telling you to leave it - and one label throughout, so it does
          // not re-word itself under a thumb after the first note.
          label: 'Continue',
          onPress: next,
          busy,
        }}
        onBack={onBack}
      />
    </View>
  );
}

// ── Step 3: the calendar ────────────────────────────────────────────────────

function CalendarStep({
  state,
  funnel,
  onRefresh,
  onBack,
  onDone,
}: {
  state: OnboardingState;
  funnel: Funnel;
  onRefresh: () => Promise<void>;
  onBack: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Skipped entirely for a guest: calendar consent is granted to an account, so
  // the request would 401 and the buttons would have nothing to open.
  const connections = useQuery<CalendarConnections>(
    () =>
      funnel.guest
        ? Promise.resolve({ connected: [], connectable: [] })
        : api.calendarConnections(),
    [funnel.guest],
  );

  /**
   * Calendar consent is the one thing a phone cannot do in-process. The link is
   * minted at tap time (it is a one-time credential) and the browser comes back
   * to the app's own URL with `connected=1` or `error=<reason>`.
   */
  async function connect(provider: { id: string; name: string }) {
    setErr(null);
    setConnecting(provider.id);
    try {
      const returnUrl = ExpoLinking.createURL('handoff');
      const { url } = await api.webLink({ target: 'calendar', provider: provider.id, returnUrl });
      const result = await WebBrowser.openAuthSessionAsync(url, returnUrl);
      if (result.type === 'success') {
        const failed = ExpoLinking.parse(result.url).queryParams?.error;
        if (failed) {
          setErr(`${provider.name} did not connect. Try again, or add it later from Settings.`);
        }
      }
      // A cancelled browser can still have connected before it was closed.
      await connections.refresh();
      await onRefresh();
    } catch (e) {
      // openAuthSessionAsync rejects if another auth session is already open,
      // and the link or the refreshes can fail on a bad network. Swallowed,
      // that is a button that does nothing with no explanation.
      setErr((e as Error).message);
    } finally {
      setConnecting(null);
    }
  }

  async function next() {
    setBusy(true);
    try {
      await funnel.act({ action: 'calendar-done' });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const connected = state.calendarsConnected > 0;
  const connectable = connections.data?.connectable ?? [];

  return (
    <View style={styles.step}>
      <Ask
        mood={moodOf(state, funnel)}
        name={state.config.assistantName}
        question="Should I book appointments?"
        sub="Give me a calendar and I check when you are free, then book the caller straight in."
      />

      <ScrollView style={styles.flex} contentContainerStyle={styles.stepContent}>
        {connected ? (
          <View style={styles.doneCard}>
            <Icon name="checkmark-circle" size={22} color={colors.successText} />
            <Text style={styles.doneCardText}>
              {state.calendarsConnected} calendar{state.calendarsConnected === 1 ? '' : 's'}{' '}
              connected. I can book from your first call.
            </Text>
          </View>
        ) : funnel.guest ? (
          <>
            {/* A guest cannot connect anything here - consent needs an
                account - so the screen shows the thing being described, which
                answers "why would I bother" on the way past. */}
            <Text style={styles.previewLabel}>What I put in your calendar</Text>
            <View
              style={styles.preview}
              accessible
              accessibilityLabel={`Example booking: Tuesday 10:30, Checkup - Sarah Doyle, booked by ${state.config.assistantName || 'me'} on a call`}
            >
              <View style={styles.previewStripe} />
              <View style={styles.flex}>
                <Text style={styles.previewWhen}>Tuesday 10:30</Text>
                <Text style={styles.previewWhat} numberOfLines={1}>
                  Checkup - Sarah Doyle
                </Text>
                <View style={styles.previewByRow}>
                  <Icon name="call-outline" size={13} color={colors.textSecondary} />
                  <Text style={styles.previewBy} numberOfLines={1}>
                    Booked by {state.config.assistantName || 'me'} on a call
                  </Text>
                </View>
              </View>
            </View>

            <View style={styles.doneCard}>
              <Icon name="calendar-outline" size={22} color={colors.textSecondary} />
              <Text style={styles.doneCardText}>
                Connect Google or Outlook once your account exists - Home reminds you. I take
                messages until then.
              </Text>
            </View>
          </>
        ) : connections.loading ? (
          <ActivityIndicator
            color={colors.textSecondary}
            style={styles.spinner}
            accessibilityLabel="Loading calendars"
          />
        ) : connections.error && !connections.data ? (
          <StaleNotice message={connections.error} onRetry={() => void connections.refresh()} />
        ) : connectable.length === 0 ? (
          <Text style={styles.hint}>
            Calendar connections aren&apos;t available right now - you can add one later.
          </Text>
        ) : (
          connectable.map((provider) => (
            <Pressable
              key={provider.id}
              onPress={() => void connect(provider)}
              disabled={connecting !== null}
              accessibilityRole="button"
              accessibilityLabel={`Connect ${provider.name}`}
              accessibilityState={{ busy: connecting === provider.id, disabled: connecting !== null }}
              style={({ pressed: down }) => [styles.connectRow, down && pressed]}
            >
              <Icon name="calendar-outline" size={ICON.action} color={colors.ink} />
              <Text style={styles.connectText}>Connect {provider.name}</Text>
              {connecting === provider.id ? (
                <ActivityIndicator size="small" color={colors.textSecondary} />
              ) : (
                <Icon name="open-outline" size={ICON.chevron} color={colors.textSecondary} />
              )}
            </Pressable>
          ))
        )}

        {err ? <Text style={styles.error}>{err}</Text> : null}
      </ScrollView>

      <Actions
        primary={{
          // A guest is not declining anything here - there is no account to
          // hang consent on yet - so offering them "Just take messages" framed
          // a missing capability as a choice they had made.
          label: connected || funnel.guest ? 'Continue' : 'Just take messages',
          onPress: next,
          busy,
        }}
        onBack={onBack}
      />
    </View>
  );
}

// ── Step 4: the plan ────────────────────────────────────────────────────────

/** How often a purchase waiting on the store (Ask to Buy, a slow verify) is re-checked. */
const PENDING_POLL_MS = 10_000;

function PlanStep({
  state,
  funnel,
  onRefresh,
  onBack,
}: {
  state: OnboardingState;
  funnel: Funnel;
  onRefresh: () => Promise<void>;
  onBack: () => void;
}) {
  const router = useRouter();
  const purchases = usePurchases();
  const guest = funnel.guest;
  // Solo and monthly unless the guest plan step already chose: the pick made
  // before signing up is the one the account should be offered after.
  const paywall = usePaywall({
    plans: state.plans,
    context: 'onboarding',
    signedIn: !guest,
    initialPlan: funnel.plan?.id ?? 'solo',
    initialCycle: funnel.plan?.cycle ?? 'monthly',
  });
  const [aiAccepted, setAiAccepted] = useState(false);
  const [countryOpen, setCountryOpen] = useState(false);
  const [countryBusy, setCountryBusy] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const { mode, cycle, picked, pendingMessage } = paywall;
  const pickedPlan = state.plans.find((p) => p.id === picked) ?? null;
  // Billed already (here, on the other store, on the web, or complimentary).
  // A paid account is shown provisioning instead of this step, so this is the
  // rare race where billing knows before the funnel does.
  const owned = mode === 'current' || mode === 'change' || mode === 'managed-elsewhere';
  const selling = mode === 'buy';

  // A purchase the store has not finished (Ask to Buy, a verify that timed
  // out) completes on its own; the server marks the account paid and the next
  // refresh swaps this step for provisioning.
  useEffect(() => {
    if (!pendingMessage) return;
    const timer = setInterval(() => void onRefresh(), PENDING_POLL_MS);
    return () => clearInterval(timer);
  }, [pendingMessage, onRefresh]);

  /**
   * Where the funnel asks for an account.
   *
   * This is the whole reason the questions run signed out: by here the caller
   * has named their business, taught it something and decided about bookings,
   * so the ask is "finish this", not "prove yourself before we start". The
   * pick is saved with the draft so the signed-in plan step opens on it.
   */
  async function signUp() {
    await funnel.savePlan({ id: picked, cycle });
    router.push('/(auth)/sign-in?next=/onboarding');
  }

  async function subscribe() {
    setErr(null);
    const result = await paywall.buy();
    if (result.outcome === 'purchased') {
      // The server has verified the purchase, marked the account paid and
      // started provisioning; the refresh flips this screen to it.
      await funnel.clearPlan();
      await onRefresh();
    } else if (result.outcome === 'blocked' && result.message) {
      setErr(result.message);
    }
    // 'cancelled' is silent, 'failed' was alerted by the purchase layer, and
    // 'pending' / 'confirming' show the hook's message under the button.
  }

  async function restore() {
    setErr(null);
    const result = await paywall.restore();
    if (result.restored) {
      await funnel.clearPlan();
      await onRefresh();
    }
  }

  async function continueOwned() {
    setContinuing(true);
    try {
      await onRefresh();
    } finally {
      setContinuing(false);
    }
  }

  // A purchase still waiting on the store (Ask to Buy) or on the server: the
  // CTA is off while the note is up, and this is the way forward - once
  // billing reports it active the refresh swaps this step for provisioning.
  async function checkAgain() {
    setErr(null);
    if (await paywall.checkAgain()) {
      await funnel.clearPlan();
      await onRefresh();
    }
  }

  async function pickCountry(code: string) {
    setCountryOpen(false);
    if (code === state.config.country) return;
    setCountryBusy(true);
    setErr(null);
    try {
      await funnel.act({ action: 'country', country: code });
      await onRefresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setCountryBusy(false);
    }
  }

  const country = state.countries.find((c) => c.code === state.config.country);
  const facts = [
    state.config.companyName && { label: 'Answering for', value: state.config.companyName },
    state.config.assistantName && { label: 'Called', value: state.config.assistantName },
  ].filter(Boolean) as { label: string; value: string }[];

  // The Terms box is what the purchase records (decision 1d); the AI box is the
  // processing the new number starts (5.1.2(i)). Both before any money moves -
  // and only there: a guest has no account to agree on behalf of and nothing
  // to buy yet, so the guest plan step shows the cards and nothing legal.
  const needsConsent = selling && paywall.priceSource === 'store';
  // The AI box is gone once it has been given (the notice stays), so the hint
  // counts only the boxes still on screen and unticked.
  const unticked = needsConsent ? Number(!paywall.accepted) + Number(!aiAccepted) : 0;

  const primary = guest
    ? { label: 'Create my account', onPress: () => void signUp() }
    : owned
      ? { label: 'Continue', onPress: () => void continueOwned(), busy: continuing }
      : {
          label: paywall.ctaLabel,
          onPress: () => void subscribe(),
          disabled: paywall.ctaDisabled || (needsConsent && !aiAccepted),
          busy: paywall.busy === 'purchase',
        };

  const note = guest
    ? 'Next: create your account, then subscribe to put me on a real number.'
    : owned
      ? paywall.statusText
      : (pendingMessage ??
        err ??
        (unticked === 2
          ? 'Tick both boxes above to subscribe.'
          : unticked === 1
            ? 'Tick the box above to subscribe.'
            : null));

  return (
    <View style={styles.step}>
      <Ask
        mood="celebrate"
        name={state.config.assistantName}
        question={guest ? 'Ready when you are.' : 'Pick a plan and I go live.'}
        sub={
          guest
            ? 'Create your account to put me on a real number. Everything you set up is saved.'
            : 'Your number is bought the moment this goes through.'
        }
      />

      <ScrollView style={styles.flex} contentContainerStyle={styles.stepContent}>
        {/* What they configured, so the commitment is made against something
            concrete rather than from memory. The web shows the same review. */}
        <View style={styles.summary}>
          {facts.map((row) => (
            <View key={row.label} style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>{row.label}</Text>
              <Text style={styles.summaryValue} numberOfLines={1}>
                {row.value}
              </Text>
            </View>
          ))}
          <Pressable
            onPress={() => setCountryOpen(true)}
            disabled={countryBusy}
            accessibilityRole="button"
            accessibilityLabel={`Number in ${country?.name ?? 'no country chosen'}`}
            accessibilityHint="Changes the country your new number is created in."
            accessibilityState={{ busy: countryBusy }}
            style={({ pressed: down }) => [styles.summaryRow, styles.countryRow, down && pressed]}
          >
            <Text style={styles.summaryLabel}>Number in</Text>
            <Text style={styles.summaryValue} numberOfLines={1}>
              {country ? `${country.flag} ${country.name}` : 'Choose a country'}
            </Text>
            {countryBusy ? (
              <ActivityIndicator size="small" color={colors.textSecondary} />
            ) : (
              <Icon name="chevron-forward" size={16} color={colors.textSecondary} />
            )}
          </Pressable>
        </View>
        <Text style={styles.hint}>
          Your new number is created from this country - change it here if it&apos;s wrong.
        </Text>

        {state.planTerms && (
          <View style={styles.toggle}>
            <CycleToggle
              cycle={cycle}
              onChange={paywall.setCycle}
              terms={state.planTerms}
              disabledCycles={paywall.disabledCycles}
              products={{
                monthly: purchases.productFor(picked, 'monthly'),
                annual: purchases.productFor(picked, 'annual'),
              }}
            />
          </View>
        )}

        {/* Consent ABOVE the cards, like the web: the button stays disabled
            until it is given, and a box under three tall cards is one nobody
            scrolls to before wondering why the button is dead. */}
        {!guest && !owned ? (
          <>
            <TermsConsent accepted={paywall.accepted} onChange={paywall.setAccepted} />
            <AiConsent accepted={aiAccepted} onChange={setAiAccepted} />
          </>
        ) : null}

        {/* Selecting a plan is separate from paying for it: the CTA is docked
            at the bottom with everything else in the funnel, so the cards choose
            and the bar commits. */}
        <View style={styles.plans} accessibilityRole="radiogroup" accessibilityLabel="Plans">
          {state.plans.map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              cycle={cycle}
              product={purchases.productFor(plan.id as PlanKey, cycle)}
              priceSource={paywall.priceSourceFor(plan.id as PlanKey, cycle)}
              selected={picked === plan.id}
              onPress={() => paywall.setPicked(plan.id as PlanKey)}
            />
          ))}
        </View>

        {mode === 'unavailable' ? (
          <PurchasesUnavailableNotice reason={purchases.unavailableReason} />
        ) : null}

        {/* The subscription terms and the legal links belong where money moves;
            for a guest that is a screen or two away. */}
        {pickedPlan && !owned && !guest ? (
          <SubscriptionDisclosure plan={pickedPlan} cycle={cycle} product={paywall.product} />
        ) : null}

        {!guest ? (
          <PaywallLegalLinks onRestore={() => void restore()} restoreBusy={paywall.busy === 'restore'} />
        ) : null}
      </ScrollView>

      <Actions
        primary={primary}
        onBack={onBack}
        note={note}
        tertiary={
          pendingMessage && !guest && !owned
            ? { label: 'Check again', onPress: () => void checkAgain(), busy: paywall.checking, disabled: paywall.checking }
            : undefined
        }
      />

      <Sheet visible={countryOpen} title="Number country" onClose={() => setCountryOpen(false)}>
        <Text style={styles.sheetHint}>
          Your new number is created in this country. Pick where your customers ring from.
        </Text>
        <CountryPicker
          countries={state.countries}
          value={state.config.country}
          onPick={(code) => void pickCountry(code)}
        />
      </Sheet>
    </View>
  );
}

// ── Provisioning ────────────────────────────────────────────────────────────

const POLL_MS = 2500;
/** After this long the wait says so, and keeps going. The web's threshold. */
const SLOW_MS = 60_000;
/** Consecutive requests that failed outright before the wait is called failed. */
const MAX_FAILURES = 3;

/**
 * The wait while the number is bought and the agent is built.
 *
 * Polls rather than streams: the work happens in a server background task and
 * there is nothing to hold a socket open for. One request at a time - the next
 * poll is scheduled only once the last has settled, since a provision request
 * can take the better part of a minute - and paused while the app is in the
 * background. 'done' and 'error' end it; nothing that arrives after 'done' can
 * put the spinner back.
 */
function Provisioning({ assistantName }: { assistantName: string }) {
  const router = useRouter();
  const { markSetupDone } = useSetupGate();
  const name = assistantName.trim() || 'Your receptionist';
  const [poll, setPoll] = useState<ProvisionPoll>({ status: 'provisioning' });
  const [slow, setSlow] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [active, setActive] = useState(AppState.currentState === 'active');

  const finished = useRef(false);
  const inFlight = useRef(false);
  const failures = useRef(0);
  const startedAt = useRef(Date.now());

  // Time in the background is not time spent waiting on screen: shift the
  // start by the pause, so the slow hint does not show the moment the app is back.
  const pausedAt = useRef<number | null>(null);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      const nowActive = next === 'active';
      if (!nowActive && pausedAt.current === null) pausedAt.current = Date.now();
      if (nowActive && pausedAt.current !== null) {
        startedAt.current += Date.now() - pausedAt.current;
        pausedAt.current = null;
      }
      setActive(nowActive);
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!active || finished.current) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick() {
      if (!alive || finished.current) return;
      // A request from before a pause is still out: wait for it rather than
      // stacking a second one on top.
      if (inFlight.current) {
        timer = setTimeout(tick, 500);
        return;
      }
      inFlight.current = true;
      let next: ProvisionPoll | null = null;
      let failure: string | null = null;
      try {
        next = await api.provision();
      } catch (e) {
        failure = (e as Error).message;
      } finally {
        inFlight.current = false;
      }
      if (!alive || finished.current) return;

      // 'nothing' (no setup on the server) and 'guest' never turn into anything
      // else by waiting, so polling them is a spinner that never ends. They
      // take the failed path, whose Retry and "Open the app anyway" still work.
      if (next && (next.status === 'nothing' || next.status === 'guest')) {
        finished.current = true;
        setPoll({ status: 'error', error: 'Your setup could not be found on the server.' });
        return;
      }

      if (next) {
        failures.current = 0;
        setPoll(next);
        if (next.status === 'done' || next.status === 'error') {
          finished.current = true;
          if (next.status === 'done') {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }
          return;
        }
      } else {
        failures.current += 1;
        // A blip is retried quietly; a request that keeps failing is a failed
        // step, with the same way forward as one the server reported.
        if (failures.current >= MAX_FAILURES) {
          finished.current = true;
          setPoll({ status: 'error', error: failure ?? undefined });
          return;
        }
      }
      setSlow(Date.now() - startedAt.current > SLOW_MS);
      timer = setTimeout(tick, next ? POLL_MS : POLL_MS * 2);
    }

    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [active, attempt]);

  function retry() {
    finished.current = false;
    failures.current = 0;
    startedAt.current = Date.now();
    setSlow(false);
    setPoll({ status: 'provisioning' });
    setAttempt((a) => a + 1);
  }

  function openApp() {
    markSetupDone();
    router.replace('/(tabs)');
  }

  if (poll.status === 'done') {
    return (
      <ScrollView contentContainerStyle={styles.doneWrap}>
        {/* The character's payoff: the same face from step 1, celebrating. */}
        <Avatar mood="celebrate" celebrate size={120} label={name} />
        {poll.sandbox ? (
          <>
            <Text style={styles.stepTitle} accessibilityRole="header">
              {name} is set up
            </Text>
            <Text style={styles.stepBody}>
              This was a test purchase, so no live phone number was bought. Everything else is
              ready - you can hear your receptionist with &quot;Have it call me&quot; on the
              Receptionist tab.
            </Text>
          </>
        ) : (
          <>
            <Text style={styles.stepTitle} accessibilityRole="header">
              {name} is answering
            </Text>
            {poll.e164 ? (
              <Pressable
                onPress={() => void dial(poll.e164 as string)}
                accessibilityRole="button"
                accessibilityLabel={`Call ${formatPhone(poll.e164)}`}
                style={({ pressed: down }) => [styles.numberButton, down && pressed]}
              >
                <Icon name="call" size={18} color={colors.ink} />
                <Text style={styles.doneNumber}>{formatPhone(poll.e164)}</Text>
              </Pressable>
            ) : null}
            <Text style={styles.stepBody}>
              {poll.e164
                ? 'Ring that number and hear it for yourself. Forward your business line to it when you are happy.'
                : 'Everything is ready. Your number and settings are in the app.'}
            </Text>
          </>
        )}

        <PushPrimer />

        <Button label="Open the app" size="lg" onPress={openApp} style={styles.cta} />
      </ScrollView>
    );
  }

  if (poll.status === 'error') {
    return (
      <ScrollView contentContainerStyle={styles.waitWrap}>
        <View style={styles.errorIcon}>
          <Icon name="alert-circle-outline" size={26} color={colors.errorText} />
        </View>
        <Text style={styles.stepTitle} accessibilityRole="header">
          Setup didn&apos;t finish
        </Text>
        {poll.error ? (
          <Notice tone="error" icon={null} live style={styles.errorNotice}>
            {poll.error}
          </Notice>
        ) : null}
        <Text style={styles.stepBody}>
          Your payment is fine - this step just failed. Try again, or open the app and we&apos;ll
          keep working on it.
        </Text>
        <Button label="Retry" size="lg" onPress={retry} style={styles.cta} />
        <Button
          label="Open the app anyway"
          size="lg"
          variant="secondary"
          onPress={openApp}
          style={styles.ctaSecond}
        />
      </ScrollView>
    );
  }

  const waitingForStore = poll.status === 'waiting-payment';
  return (
    <View style={styles.waitWrap} accessibilityLiveRegion="polite">
      {/* `studying` rather than a bare spinner: it is reading your website and
          your notes while this runs, and the wait is easier to sit through when
          the thing you are waiting for is visibly doing it. */}
      <Avatar mood="studying" size={104} label={name} />
      <ActivityIndicator color={colors.ink} style={styles.spinner} />
      <Text style={styles.stepTitle} accessibilityRole="header">
        {waitingForStore
          ? `Confirming your purchase with ${STORE_NAME === 'App Store' ? 'the App Store' : 'Google Play'}`
          : `Setting up ${assistantName.trim() || 'your receptionist'}`}
      </Text>
      <Text style={styles.stepBody}>
        {waitingForStore
          ? 'Setup starts on its own the moment it is confirmed.'
          : 'Buying your number, teaching it your business, and putting it on the line. About a minute.'}
      </Text>
      {slow ? (
        <Text style={styles.slow}>This is taking longer than usual - we&apos;ll keep trying.</Text>
      ) : null}
    </View>
  );
}

/**
 * Asked once, at the moment alerts start to mean something: the number is
 * live, so the next thing that happens is a call. The OS prompt only ever
 * follows a tap on "Turn on alerts".
 */
function PushPrimer() {
  const [show, setShow] = useState(false);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void primerAnswered().then((answered) => {
      if (alive && !answered) setShow(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function turnOn() {
    setAsking(true);
    const result = await requestAndRegister().catch(() => null);
    await markPrimerAnswered();
    setAsking(false);
    setShow(false);
    if (!result) setNote('Alerts could not be turned on. You can try again from Settings.');
    else if (result.status === 'denied') {
      setNote('Alerts are off. You can turn them on any time in your phone settings.');
    } else if (result.status === 'unsupported' || result.status === 'error') setNote(result.reason);
  }

  async function notNow() {
    await markPrimerAnswered();
    setShow(false);
  }

  if (!show) return note ? <Text style={styles.primerNote}>{note}</Text> : null;
  return (
    <View style={styles.primer}>
      <View style={styles.primerHead}>
        <Icon name="notifications-outline" size={ICON.action} color={colors.ink} />
        <Text style={styles.primerTitle} accessibilityRole="header">
          Know the moment a call ends
        </Text>
      </View>
      <Text style={styles.primerBody}>
        Get an alert with who called and what your receptionist did: bookings, messages, and
        anything that needs you.
      </Text>
      <View style={styles.primerActions}>
        <Button
          label="Turn on alerts"
          size="pill"
          onPress={() => void turnOn()}
          busy={asking}
          style={styles.flex}
        />
        <Button
          label="Not now"
          size="pill"
          variant="secondary"
          onPress={() => void notNow()}
          disabled={asking}
          style={styles.flex}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  center: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl },
  flex: { flex: 1 },
  spinner: { marginTop: spacing.lg },
  // The step owns the space under the header and splits it itself: question
  // pinned, answer scrolling, actions docked. Nothing here reflows when the
  // answer grows.
  body: { flex: 1 },
  step: { flex: 1 },
  stepContent: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xl },
  stale: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },

  savingText: { ...type.body, marginTop: spacing.md, color: colors.textSecondary },
  hint: { ...type.footnote, marginTop: spacing.xs },
  error: { ...type.bodySm, marginTop: spacing.sm, color: colors.errorText },

  // ── Knowledge ────────────────────────────────────────────────────────────
  sourceRow: {
    ...cardStyle,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    padding: spacing.lg,
  },
  sourceTitle: { ...type.body, fontFamily: fonts.semibold },
  sourceSummary: { ...type.footnote, marginTop: 2 },
  starters: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginVertical: spacing.xs },
  notes: {
    ...inputStyleLg,
    minHeight: 132,
    padding: spacing.lg,
    lineHeight: 24,
  },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: 48,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  addRowOff: { backgroundColor: colors.surfaceSubtle, borderColor: colors.border },
  addText: { ...type.button, color: colors.ink },
  addTextOff: { color: colors.textSecondary },
  consent: { marginTop: spacing.xs },

  // ── Calendar ─────────────────────────────────────────────────────────────
  doneCard: {
    ...cardStyle,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
  },
  doneCardText: { ...type.bodySm, flex: 1 },
  previewLabel: { ...type.micro, marginBottom: spacing.xs },
  preview: {
    ...cardStyle,
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.lg,
    marginBottom: spacing.sm,
  },
  // The calendar-event tab every calendar app draws down the left of an entry.
  previewStripe: { width: 3, borderRadius: 2, backgroundColor: colors.ink },
  previewWhen: { ...type.label, fontFamily: fonts.semibold, color: colors.textSecondary },
  previewWhat: { ...type.title, marginTop: 1 },
  previewByRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: spacing.xs },
  previewBy: { ...type.caption, flex: 1 },
  connectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 56,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  connectText: { ...type.body, flex: 1, fontFamily: fonts.semibold },

  // ── Plan ─────────────────────────────────────────────────────────────────
  summary: {
    ...cardStyle,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    minHeight: 36,
  },
  countryRow: { minHeight: control.md },
  summaryLabel: { ...type.footnote },
  summaryValue: { ...type.labelLg, flex: 1, fontFamily: fonts.semibold, textAlign: 'right' },
  toggle: { marginTop: spacing.md },
  plans: { marginTop: spacing.sm },
  sheetHint: { ...type.bodySm, color: colors.textSecondary, marginBottom: spacing.md },

  // ── Provisioning ─────────────────────────────────────────────────────────
  waitWrap: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xl,
  },
  stepTitle: { ...type.display, marginTop: spacing.lg, textAlign: 'center' },
  stepBody: { ...type.body, marginTop: spacing.sm, color: colors.textSecondary, textAlign: 'center' },
  slow: { ...type.caption, marginTop: spacing.lg, textAlign: 'center' },
  errorIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.errorSoft,
  },
  errorNotice: { alignSelf: 'stretch', marginTop: spacing.md },
  cta: { marginTop: spacing.xl, alignSelf: 'stretch' },
  ctaSecond: { marginTop: spacing.sm, alignSelf: 'stretch' },
  doneWrap: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xl,
  },
  numberButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: control.md,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  doneNumber: { ...type.stat },

  primer: {
    ...cardStyle,
    alignSelf: 'stretch',
    marginTop: spacing.xl,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  primerHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  primerTitle: { ...type.title, flex: 1 },
  primerBody: { ...type.bodySm, color: colors.textSecondary },
  primerActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  primerNote: { ...type.caption, marginTop: spacing.lg, textAlign: 'center' },
});
