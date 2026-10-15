import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AvatarRing } from '@/components/avatar';
import {
  ChipGroup,
  SaveBar,
  SelectRow,
  Sheet,
  StepPicker,
  SwitchRow,
  TextField,
  TopicRow,
} from '@/components/form';
import { Icon } from '@/components/Icon';
import {
  HeroSkeleton,
  NumberLine,
  PowerSwitch,
  RowsSkeleton,
  SetupProgress,
  statusOf,
  usePower,
} from '@/components/receptionist';
import {
  Badge,
  Button,
  Card,
  cardStyle,
  ErrorState,
  ICON,
  IconButton,
  Notice,
  pressed,
  ripple,
  StaleNotice,
} from '@/components/ui';
import { colors, fonts, MAX_FONT_SCALE, radius, spacing, type } from '@/constants/theme';
import { api, ApiError } from '@/lib/api';
import { formatPhone } from '@/lib/format';

import { countryForLocale, deviceTimeZone } from '@/lib/locale';
import {
  SECTION,
  type AssistantDetail,
  type AssistantPatch,
  type VoiceCatalog,
  type VoiceOption,
} from '@/lib/types';
import { useQuery } from '@/lib/use-query';

/**
 * One receptionist, editable.
 *
 * Structured as topic sheets rather than one long form, mirroring the web
 * page's TopicModal: each sheet submits only its own section, and the server's
 * patch layer leaves every section it did not carry alone. That is what makes
 * partial editing on a phone safe - see the SECTION note in lib/types.ts.
 *
 * Custom actions are shown read-only. Editing them means typing an HTTPS
 * endpoint and an auth header on a phone keyboard, and a typo there is a
 * receptionist calling the wrong system on a live call. The pager, moving a
 * number to another receptionist, per-language voices and per-destination
 * transfer hours are web-only for now as well.
 */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * What the call engine accepts as a destination, matching E164 in
 * lib/call-engine/escalation.ts. A number stored in any other shape is written
 * happily and then dropped on the way back out, so the destination vanishes
 * after a save that reported success. It has to be caught here, while the
 * operator can still see the field.
 */
const E164 = /^\+[1-9]\d{6,15}$/;
const dialable = (n: string) => n.replace(/[\s().-]/g, '');

/** The number the last test call rang, so the next one is a single tap. Keychain, not AsyncStorage: it is a phone number. */
const LAST_TEST_NUMBER_KEY = 'testcall.last';

type SheetKey =
  | 'basics'
  | 'voice'
  | 'role'
  | 'escalation'
  | 'hours'
  | 'guardrails'
  | 'alerts'
  | 'calendar'
  | null;

export default function AssistantDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const navigation = useNavigation();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const { data, error, loading, refresh } = useQuery<AssistantDetail>(
    () => api.assistant(String(id)),
    [id],
  );
  const voices = useQuery(() => api.voices(), []);

  const [sheet, setSheet] = useState<SheetKey>(null);
  // Only a pull the user made spins the RefreshControl; the refetch after
  // every save and the one after the paywall run without it.
  const [pulling, setPulling] = useState(false);

  useEffect(() => {
    if (data) navigation.setOptions({ title: data.name });
  }, [data, navigation]);

  // Back from the paywall: the plan may have just changed, and with it
  // `planActive`, the number countries' talk time and whether a number can be
  // had. `useQuery`'s own focus refetch skips a payload this fresh.
  const fromPaywall = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!fromPaywall.current) return;
      fromPaywall.current = false;
      void refresh();
    }, [refresh]),
  );
  const openPaywall = useCallback(() => {
    fromPaywall.current = true;
    router.push({ pathname: '/paywall', params: { reason: 'number' } });
  }, [router]);

  const refreshVoices = voices.refresh;
  const pull = useCallback(async () => {
    setPulling(true);
    try {
      await Promise.all([refresh(), refreshVoices()]);
    } finally {
      setPulling(false);
    }
  }, [refresh, refreshVoices]);

  const save = useCallback(
    async (patch: AssistantPatch) => {
      const res = await api.saveAssistant(String(id), patch);
      await refresh();
      return res.warning ?? null;
    },
    [id, refresh],
  );

  // The same optimistic switch as the hub's, with the same "could not pause"
  // explanation when the server refuses.
  const power = usePower(
    { id: String(id), name: data?.name ?? 'Your receptionist', enabled: data?.enabled ?? false },
    refresh,
  );

  function confirmDelete() {
    Alert.alert(
      'Delete this receptionist?',
      'Its number is released and the transcript history stays. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await api.deleteAssistant(String(id));
              router.back();
            } catch (err) {
              Alert.alert('Could not delete', (err as Error).message);
            }
          },
        },
      ],
    );
  }

  // `useQuery` keeps the last good payload but sets `error` on every failed
  // revalidate, including the focus and foreground refetches. Unmounting on
  // `error` would throw away a screen of settings - and any sheet open over it -
  // on one lost packet, so only a load that never landed takes the whole screen.
  if (loading && !data) {
    return (
      <View style={[styles.root, styles.content]}>
        <HeroSkeleton />
        <RowsSkeleton count={3} />
        <RowsSkeleton count={5} />
      </View>
    );
  }
  if (!data) {
    return <ErrorState message={error ?? 'Not found.'} onRetry={refresh} />;
  }

  const status = statusOf(power.enabled, data.number);
  const isDone = (key: string) => data.setup.items.find((i) => i.key === key)?.done ?? false;
  const setupDone = data.setup.items.filter((i) => i.done).length;
  const setupTotal = data.setup.items.length;

  const languageName =
    voices.data?.languages.find((l) => l.code === data.language)?.name ?? data.language;
  const catalogVoiceName = voices.data?.voices.find((v) => v.voiceId === data.voiceId)?.name;
  // A voice picked from the web's full library is not in the app's catalog and
  // may come back without a name. It is still a deliberate choice, not the
  // default.
  const voiceLabel =
    data.voiceName || catalogVoiceName || (data.voiceId ? 'Custom voice' : 'Default voice');
  const primaryTransfer = data.escalation.targets[0];

  return (
    <>
      <ScrollView
        style={styles.root}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]}
        refreshControl={
          <RefreshControl
            refreshing={pulling}
            onRefresh={pull}
            tintColor={colors.textSecondary}
            colors={[colors.ink]}
          />
        }
      >
        {error ? <StaleNotice message={error} onRetry={refresh} /> : null}

        {data.multilingual === false && (
          <Notice tone="warning" icon="language-outline">
            This receptionist answers in English only. Change it on the web dashboard to answer in
            the caller&apos;s language.
          </Notice>
        )}

        <Card>
          <View style={styles.heroHead}>
            <AvatarRing size={56} mood={status.live ? 'friendly' : 'greeting'} status={status.ring} />
            <View style={styles.flex}>
              <Text style={styles.heroName} numberOfLines={2} accessibilityRole="header">
                {data.name}
              </Text>
              <View style={styles.statusLine}>
                <Text style={[styles.statusText, { color: status.color }]}>{status.text}</Text>
                {!data.connected && <Badge label="Not synced" tone="warning" />}
              </View>
            </View>
            <PowerSwitch
              name={data.name}
              value={power.enabled}
              busy={power.busy}
              onChange={power.toggle}
            />
          </View>

          <NumberBlock detail={data} onChanged={refresh} onSubscribe={openPaywall} />

          {setupTotal > 0 && setupDone < setupTotal ? (
            <SetupProgress done={setupDone} total={setupTotal} />
          ) : null}
        </Card>

        <Text style={styles.groupTitle} accessibilityRole="header">
          How it sounds
        </Text>
        <Card style={styles.topics}>
          <TopicRow
            icon="chatbubble-ellipses-outline"
            title="Name and opening line"
            value={data.greeting || 'No opening line yet'}
            done={isDone('greeting')}
            onPress={() => setSheet('basics')}
          />
          <TopicRow
            icon="mic-outline"
            title="Voice and language"
            value={`${voiceLabel} · ${languageName}`}
            done={isDone('voice')}
            onPress={() => setSheet('voice')}
            style={styles.divided}
          />
          <TopicRow
            icon="school-outline"
            title="How it behaves"
            value={data.systemPrompt ? 'Custom instructions set' : 'Using the default behaviour'}
            done={isDone('behaviour')}
            onPress={() => setSheet('role')}
            style={styles.divided}
          />
        </Card>

        <Text style={styles.groupTitle} accessibilityRole="header">
          What it does
        </Text>
        <Card style={styles.topics}>
          <TopicRow
            icon="git-branch-outline"
            title="Who it hands calls to"
            value={
              primaryTransfer
                ? `${formatPhone(primaryTransfer.number)}${data.escalation.targets.length > 1 ? ` +${data.escalation.targets.length - 1} more` : ''}`
                : 'Nobody - it takes a message instead'
            }
            done={isDone('transfer')}
            onPress={() => setSheet('escalation')}
          />
          <TopicRow
            icon="time-outline"
            title="When transfers are allowed"
            value={describeHours(primaryTransfer?.hours ?? null)}
            done={Boolean(primaryTransfer?.hours)}
            onPress={() => setSheet('hours')}
            style={styles.divided}
          />
          <TopicRow
            icon="calendar-outline"
            title="Booking"
            value={
              data.calendars.length === 0
                ? 'No calendar connected'
                : describeCalendars(data.calendars)
            }
            done={isDone('calendar')}
            onPress={() => setSheet('calendar')}
            style={styles.divided}
          />
          <TopicRow
            icon="shield-outline"
            title="What it must not do"
            value={describeGuardrails(data)}
            done={
              data.guardrails.neverDiscuss.length > 0 || data.guardrails.alwaysEscalate.length > 0
            }
            onPress={() => setSheet('guardrails')}
            style={styles.divided}
          />
          <TopicRow
            icon="notifications-outline"
            title="Alerts and recaps"
            value={describeAlerts(data)}
            done={data.smsAlerts || data.emailTranscripts.enabled}
            onPress={() => setSheet('alerts')}
            style={styles.divided}
          />
        </Card>

        {data.customTools.length > 0 && (
          <>
            <Text style={styles.groupTitle} accessibilityRole="header">
              Your own actions
            </Text>
            <Card style={styles.topics}>
              {data.customTools.map((t, i) => (
                <View
                  key={t.id}
                  style={[styles.toolRow, i > 0 && styles.divided]}
                  accessible
                  accessibilityLabel={`${t.name}, ${t.method} ${t.url}, ${t.enabled ? 'On' : 'Off'}`}
                >
                  <View style={styles.flex}>
                    <Text style={styles.toolName}>{t.name}</Text>
                    <Text style={styles.toolUrl} numberOfLines={1}>
                      {t.method} {t.url}
                    </Text>
                  </View>
                  <Badge
                    label={t.enabled ? 'On' : 'Off'}
                    tone={t.enabled ? 'success' : 'neutral'}
                  />
                </View>
              ))}
              <Text style={styles.footnote}>
                Endpoints and credentials are edited on the web dashboard.
              </Text>
            </Card>
          </>
        )}

        <Button
          label="Delete this receptionist"
          variant="danger"
          onPress={confirmDelete}
          style={styles.delete}
        />
      </ScrollView>

      <BasicsSheet
        visible={sheet === 'basics'}
        detail={data}
        onClose={() => setSheet(null)}
        onSave={save}
      />
      <VoiceSheet
        visible={sheet === 'voice'}
        detail={data}
        catalog={voices.data}
        onClose={() => setSheet(null)}
        onSave={save}
      />
      <RoleSheet
        visible={sheet === 'role'}
        detail={data}
        onClose={() => setSheet(null)}
        onSave={save}
      />
      <EscalationSheet
        visible={sheet === 'escalation'}
        detail={data}
        onClose={() => setSheet(null)}
        onSave={save}
      />
      <HoursSheet
        visible={sheet === 'hours'}
        detail={data}
        onClose={() => setSheet(null)}
        onSave={save}
      />
      <GuardrailsSheet
        visible={sheet === 'guardrails'}
        detail={data}
        onClose={() => setSheet(null)}
        onSave={save}
      />
      <AlertsSheet
        visible={sheet === 'alerts'}
        detail={data}
        onClose={() => setSheet(null)}
        onSave={save}
      />
      <CalendarSheet
        visible={sheet === 'calendar'}
        detail={data}
        onClose={() => setSheet(null)}
        onSave={save}
      />
    </>
  );
}

// ── Hero ────────────────────────────────────────────────────────────────────

function NumberBlock({
  detail,
  onChanged,
  onSubscribe,
}: {
  detail: AssistantDetail;
  onChanged: () => Promise<void>;
  onSubscribe: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // The phone's region first, the way the web preselects by locale - never
  // simply the first country in the list. Resolved against the list on every
  // payload rather than once on mount: this block stays mounted across the
  // paywall round trip, and the list that comes back after a purchase can
  // differ from the one it was first seeded from.
  const [choice, setCountry] = useState<string | null>(null);
  const fallback = useMemo(() => countryForLocale(detail.numberCountries), [detail.numberCountries]);
  const chosen = choice ? detail.numberCountries.find((c) => c.code === choice) : undefined;
  const country = chosen ? chosen.code : fallback;
  const picked = chosen ?? detail.numberCountries.find((c) => c.code === country);

  async function getNumber() {
    setBusy(true);
    try {
      await api.getAssistantNumber(detail.id, country);
      await onChanged();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      const message = (err as Error).message;
      const code = err instanceof ApiError ? err.code : undefined;
      // The plan gate is not a failure to report but a step to take: the
      // paywall, which comes back here and refetches.
      if (code === 'plan_required') onSubscribe();
      else if (code === 'sandbox') {
        Alert.alert('No live number on a test purchase', 'Test purchases do not include a live phone number.');
      } else if (code === 'limit_reached') Alert.alert('Number limit reached', message);
      else Alert.alert('Could not get a number', message);
    } finally {
      setBusy(false);
    }
  }

  function confirmUnlink() {
    Alert.alert('Unlink this number?', 'Calls to it stop being answered immediately.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Unlink',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          try {
            await api.unlinkAssistantNumber(detail.id);
            await onChanged();
          } catch (err) {
            Alert.alert('Could not unlink', (err as Error).message);
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  }

  if (!detail.number) {
    return (
      <View style={styles.numberBlock}>
        <Text style={styles.numberWarn}>
          No number points at this receptionist, so nothing reaches it yet.
        </Text>
        {detail.planActive ? (
          <>
            <View>
              <SelectRow
                label="Where should the number be from?"
                value={country}
                options={detail.numberCountries.map((c) => ({
                  value: c.code,
                  label: `${c.flag} ${c.name}`,
                }))}
                onChange={setCountry}
                searchable
              />
              {picked ? (
                <Text style={styles.rate}>
                  Rate: {picked.creditsPerMinute} credit{picked.creditsPerMinute === 1 ? '' : 's'}
                  /min
                  {picked.estMinutes != null ? ` · Talk time: about ${picked.estMinutes} min` : ''}
                </Text>
              ) : null}
            </View>
            <Button label="Get a number" icon="call-outline" onPress={getNumber} busy={busy} />
          </>
        ) : (
          <Button label="Subscribe to get a number" icon="call-outline" onPress={onSubscribe} />
        )}
        <TestCall detail={detail} />
      </View>
    );
  }

  return (
    <View style={styles.numberBlock}>
      <NumberLine number={detail.number} />
      <TestCall detail={detail}>
        <Button
          label="Unlink this number"
          size="pill"
          variant="ghost"
          onPress={confirmUnlink}
          busy={busy}
        />
      </TestCall>
    </View>
  );
}

/**
 * "Have it call me", with or without a number: without one the server rings
 * from its demo line. One tap when there is a number to ring - the first
 * person it hands calls to, else whichever number the last test rang.
 * `children` joins "Use another number" in the row of small actions, so the
 * block does not stack one text button under another.
 */
function TestCall({ detail, children }: { detail: AssistantDetail; children?: ReactNode }) {
  const [last, setLast] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    let alive = true;
    SecureStore.getItemAsync(LAST_TEST_NUMBER_KEY)
      .then((value) => {
        if (alive && value) setLast(value);
      })
      .catch(() => {
        // Nothing remembered; the sheet asks.
      });
    return () => {
      alive = false;
    };
  }, []);

  const remember = useCallback((to: string) => {
    setLast(to);
    void SecureStore.setItemAsync(LAST_TEST_NUMBER_KEY, to).catch(() => {});
  }, []);

  const target = detail.escalation.targets[0]?.number || last || '';

  async function callTarget() {
    setBusy(true);
    setState(null);
    try {
      await api.testCall(detail.id, target);
      remember(target);
      setState({ ok: true, message: 'Calling you now.' });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      setState({ ok: false, message: (err as Error).message });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setBusy(false);
    }
  }

  const sheet = (
    <TestCallSheet
      visible={sheetOpen}
      assistantId={detail.id}
      onPlaced={remember}
      onClose={() => setSheetOpen(false)}
    />
  );

  // The sheet sits at one stable position in both branches: placing a test
  // call from it remembers the number, which flips `target` and with it the
  // branch. Were the sheet inside each branch, that flip would remount the
  // open Modal and drop its "Calling you now." confirmation.
  const body = !target ? (
    <>
      <Button
        label="Have it call me"
        variant="secondary"
        icon="call-outline"
        onPress={() => setSheetOpen(true)}
      />
      {children ? <View style={styles.linkRow}>{children}</View> : null}
    </>
  ) : (
    <View style={styles.testCall}>
      <Text style={styles.testLabel}>Have it call me</Text>
      <Button
        label={`Call ${formatPhone(target)}`}
        variant="secondary"
        icon="call-outline"
        onPress={callTarget}
        busy={busy}
        accessibilityHint="The receptionist rings this number and answers as it would a caller."
      />
      {state ? (
        <Text
          style={[styles.testState, { color: state.ok ? colors.successText : colors.errorText }]}
          accessibilityLiveRegion="polite"
        >
          {state.message}
        </Text>
      ) : null}
      <View style={styles.linkRow}>
        <Button
          label="Use another number"
          size="pill"
          variant="ghost"
          onPress={() => setSheetOpen(true)}
        />
        {children}
      </View>
    </View>
  );

  return (
    <>
      {body}
      {sheet}
    </>
  );
}

function TestCallSheet({
  visible,
  assistantId,
  onPlaced,
  onClose,
}: {
  visible: boolean;
  assistantId: string;
  onPlaced: (to: string) => void;
  onClose: () => void;
}) {
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (visible) setState(null);
  }, [visible]);

  async function place() {
    const number = dialable(to.trim());
    setBusy(true);
    setState(null);
    try {
      await api.testCall(assistantId, number);
      onPlaced(number);
      setState({ ok: true, message: 'Calling you now.' });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      setState({ ok: false, message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      visible={visible}
      title="Hear it for yourself"
      onClose={onClose}
      footer={
        <SaveBar
          onSave={place}
          busy={busy}
          dirty={to.trim().length > 0}
          state={state}
          label="Call me"
        />
      }
    >
      <TextField
        label="Your number"
        value={to}
        onChangeText={setTo}
        placeholder="+1 555 123 4567"
        keyboardType="phone-pad"
        autoCapitalize="none"
        autoComplete="tel"
        textContentType="telephoneNumber"
        hint="Include the country code. The receptionist rings you and answers as it would a caller."
      />
    </Sheet>
  );
}

// ── Topic sheets ────────────────────────────────────────────────────────────

/**
 * Shared save plumbing for every sheet: the busy flag, the confirmation a sheet
 * shows before throwing an unsaved draft away, and the one thing that must
 * never be swallowed - the warning a save returns when the database write
 * succeeded but the live agent did not update.
 */
function useSheetSave(
  visible: boolean,
  onSave: (patch: AssistantPatch) => Promise<string | null>,
  onClose: () => void,
) {
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<{ ok: boolean; message: string } | null>(null);

  // Clearing here rather than in each sheet's reset effect is what keeps the
  // agent-sync warning on screen: a successful-with-warning save refreshes
  // `detail`, and an effect keyed on that would wipe the message in the same
  // render that set it.
  useEffect(() => {
    if (visible) setState(null);
  }, [visible]);

  const submit = useCallback(
    async (patch: AssistantPatch) => {
      setBusy(true);
      setState(null);
      try {
        const warning = await onSave(patch);
        if (warning) {
          setState({ ok: false, message: warning });
        } else {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          onClose();
        }
      } catch (err) {
        setState({ ok: false, message: (err as Error).message });
      } finally {
        setBusy(false);
      }
    },
    [onSave, onClose],
  );

  const confirmClose = useCallback(
    (dirty: boolean) => {
      if (!dirty) return onClose();
      Alert.alert('Discard changes?', 'Your edits to this section have not been saved.', [
        { text: 'Keep editing', style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: onClose },
      ]);
    },
    [onClose],
  );

  // A save that came back with an agent-sync warning has already refreshed
  // `detail`, so every sheet's `dirty` is false again and the Save button beside
  // the "Try again" message would be greyed out. While a failure is showing, the
  // same payload has to stay submittable.
  const canSave = useCallback(
    (dirty: boolean) => dirty || (state !== null && !state.ok),
    [state],
  );

  return { busy, state, submit, confirmClose, canSave };
}

/**
 * The section-level escalation fields.
 *
 * The server rebuilds `routing.escalation` from scratch every time this section
 * is submitted, so a sheet that sends only what it edits deletes the rest: the
 * triggers, the callback promise and the owner's pager all live on the same
 * object. Every sheet that touches the section sends all of it, overriding only
 * the parts it owns.
 */
function escalationFields(
  detail: AssistantDetail,
  over: { keys: string; triggers?: string; sla?: string },
): AssistantPatch['fields'] {
  return {
    esc_keys: over.keys,
    esc_triggers: over.triggers ?? detail.escalation.triggers.join('\n'),
    esc_sla:
      over.sla ??
      (detail.escalation.callbackSlaMinutes != null
        ? String(detail.escalation.callbackSlaMinutes)
        : ''),
    // Paging has no UI on the phone, but it is part of the same object - it can
    // only be preserved by being re-sent.
    esc_page: detail.escalation.page?.enabled === true,
    esc_page_number: detail.escalation.page?.number ?? '',
  };
}

interface SheetProps {
  visible: boolean;
  detail: AssistantDetail;
  onClose: () => void;
  onSave: (patch: AssistantPatch) => Promise<string | null>;
}

function BasicsSheet({ visible, detail, onClose, onSave }: SheetProps) {
  const [name, setName] = useState(detail.name);
  const [greeting, setGreeting] = useState(detail.greeting);
  const { busy, state, submit, confirmClose, canSave } = useSheetSave(visible, onSave, onClose);

  // Seeded on the open, never on the payload: `useQuery` hands back a brand new
  // object on every focus and foreground revalidate, so an effect keyed on
  // `detail` would re-seed mid-edit and throw away what is being typed.
  const wasVisible = useRef(false);
  useEffect(() => {
    if (visible && !wasVisible.current) {
      setName(detail.name);
      setGreeting(detail.greeting);
    }
    wasVisible.current = visible;
  }, [visible, detail.name, detail.greeting]);

  const dirty = name !== detail.name || greeting !== detail.greeting;

  return (
    <Sheet
      visible={visible}
      title="Name and opening line"
      onClose={() => confirmClose(dirty)}
      footer={
        <SaveBar
          onSave={() =>
            // Only the basics section: voice_id and language are absent here on
            // purpose, so this save cannot touch them.
            submit({ sections: [SECTION.basics], fields: { name, greeting } })
          }
          busy={busy}
          dirty={canSave(dirty)}
          state={state}
        />
      }
    >
      <TextField
        label="Its name"
        value={name}
        onChangeText={setName}
        placeholder="Receptionist"
        // The same truth the setup funnel tells: the name is a label for you.
        hint="Only you see this name - callers hear your business name."
      />
      <TextField
        label="Opening line"
        value={greeting}
        onChangeText={setGreeting}
        placeholder="Thanks for calling Bright Dental, how can I help?"
        multiline
        hint="The first thing every caller hears. Short works better than clever."
      />
    </Sheet>
  );
}

/**
 * Plays one preview and reports whether audio is actually coming out - the
 * pattern from the setup funnel's voice step (components/meet-assistant.tsx).
 * One player for the whole list: a new URL replaces (and releases) the last
 * one, and leaving the screen releases it too.
 *
 * `playsInSilentMode` because a phone on a desk is very often on silent, and a
 * voice picker that is mute on half the devices that open it is worse than none.
 */
function usePreviewPlayer(url: string | null, onEnd: () => void): boolean {
  const player = useAudioPlayer(url ? { uri: url } : null);
  const status = useAudioPlayerStatus(player);

  useEffect(() => {
    void setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: false });
  }, []);

  useEffect(() => {
    if (!url) return;
    player.seekTo(0);
    player.play();
  }, [player, url]);

  // Clearing the URL on finish is what lets the same voice be replayed.
  const ended = status.didJustFinish;
  useEffect(() => {
    if (ended) onEnd();
    // `onEnd` is a fresh closure each render; depending on it would fire this
    // on every status tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ended]);

  return Boolean(url) && status.playing;
}

/** "American · expressive" plus the gender, as short tags. */
function voiceTags(v: VoiceOption): string[] {
  const tags: string[] = [];
  if (v.gender === 'f') tags.push('Female');
  if (v.gender === 'm') tags.push('Male');
  for (const part of v.description.split('·')) {
    const tag = part.trim();
    if (tag) tags.push(tag.charAt(0).toUpperCase() + tag.slice(1));
  }
  return tags;
}

function VoiceRow({
  name,
  tags,
  selected,
  playing,
  canPlay,
  onSelect,
  onTogglePlay,
  divided,
}: {
  name: string;
  tags: string[];
  selected: boolean;
  playing: boolean;
  canPlay: boolean;
  onSelect: () => void;
  onTogglePlay: () => void;
  divided: boolean;
}) {
  return (
    <View style={[styles.voiceRow, divided && styles.divided]}>
      <Pressable
        onPress={onSelect}
        accessibilityRole="radio"
        accessibilityState={{ checked: selected }}
        accessibilityLabel={[name, ...tags].join(', ')}
        android_ripple={ripple}
        style={({ pressed: down }) => [styles.voiceMain, down && pressed]}
      >
        <View style={[styles.radio, selected && styles.radioOn]}>
          {selected ? <View style={styles.radioDot} /> : null}
        </View>
        <View style={styles.flex}>
          <Text style={styles.voiceName}>{name}</Text>
          {tags.length > 0 ? (
            <View style={styles.voiceTags}>
              {tags.map((t) => (
                <Badge key={t} label={t} />
              ))}
            </View>
          ) : null}
        </View>
      </Pressable>
      {canPlay ? (
        <IconButton
          icon={playing ? 'stop' : 'play'}
          label={playing ? `Stop ${name}` : `Hear ${name}`}
          tone={playing ? 'ink' : 'subtle'}
          onPress={onTogglePlay}
        />
      ) : null}
    </View>
  );
}

function VoiceSheet({
  visible,
  detail,
  catalog,
  onClose,
  onSave,
}: SheetProps & { catalog: VoiceCatalog | null }) {
  const [voiceId, setVoiceId] = useState(detail.voiceId);
  const [language, setLanguage] = useState(detail.language);
  const [tier, setTier] = useState(detail.voice.tier);
  const [speed, setSpeed] = useState(detail.voice.speed);
  const [stability, setStability] = useState(detail.voice.stability);
  const [preview, setPreview] = useState<string | null>(null);
  const { busy, state, submit, confirmClose, canSave } = useSheetSave(visible, onSave, onClose);
  const talking = usePreviewPlayer(preview, () => setPreview(null));

  // Seeded on the open, never on the payload: `useQuery` hands back a brand new
  // object on every focus and foreground revalidate, so an effect keyed on
  // `detail` would re-seed mid-edit and throw away what is being typed.
  const wasVisible = useRef(false);
  useEffect(() => {
    if (visible && !wasVisible.current) {
      setVoiceId(detail.voiceId);
      setLanguage(detail.language);
      setTier(detail.voice.tier);
      setSpeed(detail.voice.speed);
      setStability(detail.voice.stability);
    }
    wasVisible.current = visible;
  }, [visible, detail]);

  // A sample must not keep talking over the screen behind a closed sheet -
  // whether it closed by Save, by X, or by the Android back gesture.
  useEffect(() => {
    if (!visible) setPreview(null);
  }, [visible]);

  const dirty =
    voiceId !== detail.voiceId ||
    language !== detail.language ||
    tier !== detail.voice.tier ||
    speed !== detail.voice.speed ||
    stability !== detail.voice.stability;

  const voices = catalog?.voices ?? [];
  // A voice picked on the web from the full library is not in this catalog.
  // It stays choosable, so a look through the list is not a silent swap.
  const custom = Boolean(detail.voiceId) && catalog !== null && !voices.some((v) => v.voiceId === detail.voiceId);

  const languageOptions = useMemo(
    () =>
      (catalog?.languages ?? []).map((l) => ({
        value: l.code,
        label: `${l.flag} ${l.name}`,
      })),
    [catalog],
  );

  return (
    <Sheet
      visible={visible}
      title="Voice and language"
      onClose={() => {
        setPreview(null);
        confirmClose(dirty);
      }}
      footer={
        <SaveBar
          onSave={() =>
            submit({
              // Two sections, because voice_id and language live in basics while
              // the tier and the sliders live in voice. Name and greeting are
              // absent from `fields`, so basics leaves them alone.
              sections: [SECTION.basics, SECTION.voice],
              fields: {
                voice_id: voiceId,
                language,
                voice_tier: tier,
                voice_speed: speed,
                voice_stability: stability,
              },
            })
          }
          busy={busy}
          dirty={canSave(dirty)}
          state={state}
        />
      }
    >
      <Text style={styles.fieldLabel} accessibilityRole="header">
        Voice
      </Text>
      <View style={styles.voiceList} accessibilityRole="radiogroup">
        {catalog === null ? (
          <Text style={styles.sheetHint}>Loading voices...</Text>
        ) : (
          <>
            {custom && (
              <VoiceRow
                name={detail.voiceName || 'Custom voice'}
                tags={['Chosen on the web']}
                selected={voiceId === detail.voiceId}
                playing={false}
                canPlay={false}
                onSelect={() => setVoiceId(detail.voiceId)}
                onTogglePlay={() => {}}
                divided={false}
              />
            )}
            {voices.map((v, i) => (
              <VoiceRow
                key={v.voiceId}
                name={v.name}
                tags={voiceTags(v)}
                selected={voiceId === v.voiceId}
                playing={talking && preview === v.previewUrl}
                canPlay={Boolean(v.previewUrl)}
                onSelect={() => setVoiceId(v.voiceId)}
                onTogglePlay={() =>
                  setPreview((cur) => (cur === v.previewUrl ? null : (v.previewUrl ?? null)))
                }
                divided={custom || i > 0}
              />
            ))}
            {voices.length === 0 && !custom ? (
              <Text style={styles.sheetHint}>Nothing to choose from yet.</Text>
            ) : null}
          </>
        )}
      </View>
      <SelectRow
        label="Language"
        value={language}
        options={languageOptions}
        onChange={setLanguage}
        placeholder="Choose a language"
        searchable
      />
      <ChipGroup
        label="Quality"
        value={tier}
        options={[
          { value: 'fast', label: 'Fast' },
          { value: 'natural', label: 'Natural' },
        ]}
        onChange={(v) => setTier(v as 'fast' | 'natural')}
      />
      <Text style={styles.sheetHint}>
        Natural sounds better and replies a little slower. Fast is the default.
      </Text>
      <View style={{ height: spacing.lg }} />
      <StepPicker
        label="Speaking speed"
        value={speed}
        stops={[0.8, 0.9, 1, 1.1, 1.2]}
        format={(v) => `${v.toFixed(1)}x`}
        onChange={setSpeed}
      />
      <StepPicker
        label="Steadiness"
        value={stability}
        stops={[0, 0.25, 0.5, 0.75, 1]}
        format={(v) => (v === 0 ? 'Loose' : v === 1 ? 'Flat' : v.toFixed(2))}
        onChange={setStability}
        hint="Higher is steadier and flatter. Lower is more expressive but drifts."
      />
    </Sheet>
  );
}

function RoleSheet({ visible, detail, onClose, onSave }: SheetProps) {
  const [prompt, setPrompt] = useState(detail.systemPrompt);
  const { busy, state, submit, confirmClose, canSave } = useSheetSave(visible, onSave, onClose);

  // Seeded on the open, never on the payload: `useQuery` hands back a brand new
  // object on every focus and foreground revalidate, so an effect keyed on
  // `detail` would re-seed mid-edit and throw away what is being typed.
  const wasVisible = useRef(false);
  useEffect(() => {
    if (visible && !wasVisible.current) setPrompt(detail.systemPrompt);
    wasVisible.current = visible;
  }, [visible, detail.systemPrompt]);

  const dirty = prompt !== detail.systemPrompt;

  return (
    <Sheet
      visible={visible}
      title="How it behaves"
      onClose={() => confirmClose(dirty)}
      footer={
        <SaveBar
          onSave={() => submit({ sections: [SECTION.role], fields: { system_prompt: prompt } })}
          busy={busy}
          dirty={canSave(dirty)}
          state={state}
        />
      }
    >
      <TextField
        label="Instructions"
        value={prompt}
        onChangeText={setPrompt}
        placeholder={"Be brief and warm. Always confirm the caller's name and number before booking."}
        multiline
        hint="Written into the receptionist's brief. Leave it blank to use the default behaviour."
      />
    </Sheet>
  );
}

function EscalationSheet({ visible, detail, onClose, onSave }: SheetProps) {
  const [targets, setTargets] = useState(detail.escalation.targets);
  const [triggers, setTriggers] = useState(detail.escalation.triggers.join('\n'));
  const [sla, setSla] = useState(
    detail.escalation.callbackSlaMinutes ? String(detail.escalation.callbackSlaMinutes) : '',
  );
  const { busy, state, submit, confirmClose, canSave } = useSheetSave(visible, onSave, onClose);

  // Seeded on the open, never on the payload: `useQuery` hands back a brand new
  // object on every focus and foreground revalidate, so an effect keyed on
  // `detail.escalation` would re-seed mid-edit and discard a destination the
  // operator is halfway through typing.
  const wasVisible = useRef(false);
  useEffect(() => {
    if (visible && !wasVisible.current) {
      setTargets(detail.escalation.targets);
      setTriggers(detail.escalation.triggers.join('\n'));
      setSla(
        detail.escalation.callbackSlaMinutes ? String(detail.escalation.callbackSlaMinutes) : '',
      );
    }
    wasVisible.current = visible;
  }, [visible, detail.escalation]);

  // A row with anything in it is one the operator meant; a wholly blank one is
  // an "Add another" they walked away from. Blank rows are dropped on save
  // (the server drops them too), so blocking the save on them would be a dead
  // end with nothing to fix.
  const started = (t: (typeof targets)[number]) =>
    Boolean(t.label.trim() || dialable(t.number) || t.when.trim() || t.hours);
  const filled = targets.filter(started);
  const badTarget = filled.some((t) => !E164.test(dialable(t.number)));
  const storedSla = detail.escalation.callbackSlaMinutes
    ? String(detail.escalation.callbackSlaMinutes)
    : '';
  const dirty =
    triggers !== detail.escalation.triggers.join('\n') ||
    sla !== storedSla ||
    // By value, not identity: `detail` is a fresh object after every refetch.
    JSON.stringify(filled) !== JSON.stringify(detail.escalation.targets);

  function addTarget() {
    // The key is interpolated into field names on the server, which only accepts
    // /^[a-z0-9]{1,16}$/ - so generate one in exactly that shape.
    const key = `t${Math.random().toString(36).slice(2, 8)}`;
    setTargets([...targets, { id: key, label: '', number: '', when: '', warm: null, hours: null }]);
  }

  function patch(index: number, next: Partial<(typeof targets)[number]>) {
    setTargets(targets.map((t, i) => (i === index ? { ...t, ...next } : t)));
  }

  function build(): AssistantPatch {
    const fields = escalationFields(detail, {
      keys: filled.map((t) => t.id).join(','),
      triggers,
      sla: sla.trim(),
    });
    for (const t of filled) {
      fields[`esc_${t.id}_label`] = t.label;
      fields[`esc_${t.id}_number`] = dialable(t.number);
      fields[`esc_${t.id}_when`] = t.when;
      // "" is meaningful: it means the operator has not chosen, which must stay
      // distinct from an explicit cold transfer.
      fields[`esc_${t.id}_warm`] = t.warm === true ? 'warm' : t.warm === false ? 'cold' : '';
      // The schedule lives in its own sheet. Not sending esc_<key>_tz here means
      // the server keeps whatever is stored - see buildHours in assistant-patch.
      if (t.hours) {
        fields[`esc_${t.id}_tz`] = t.hours.timezone;
        t.hours.days.forEach((d, i) => {
          if (!d) return;
          fields[`esc_${t.id}_day_${i}`] = true;
          fields[`esc_${t.id}_start_${i}`] = d.start;
          fields[`esc_${t.id}_end_${i}`] = d.end;
        });
      }
    }
    return { sections: [SECTION.escalation], fields };
  }

  return (
    <Sheet
      visible={visible}
      title="Who it hands calls to"
      onClose={() => confirmClose(dirty)}
      footer={
        <SaveBar
          onSave={() => submit(build())}
          busy={busy}
          // A number the call engine cannot dial is stored and then dropped on
          // read, so the save has to be blocked while one is on screen.
          dirty={canSave(dirty) && !badTarget}
          state={state}
        />
      }
    >
      {targets.length === 0 && (
        <Text style={styles.sheetHint}>
          Nobody yet. Without a destination the receptionist takes a message instead of
          transferring.
        </Text>
      )}
      {targets.map((t, i) => (
        <View key={t.id} style={styles.targetCard}>
          <View style={styles.targetHead}>
            <Text style={styles.targetIndex}>
              {i === 0 ? 'First choice' : `Then, if that fails (${i + 1})`}
            </Text>
            <Pressable
              onPress={() => setTargets(targets.filter((x) => x.id !== t.id))}
              // 18pt glyph + 13 each side = 44pt.
              hitSlop={13}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${t.label.trim() || (i === 0 ? 'the first choice' : `destination ${i + 1}`)}`}
              style={({ pressed: down }) => down && pressed}
            >
              <Icon name="trash-outline" size={ICON.row} color={colors.errorText} />
            </Pressable>
          </View>
          <TextField
            label="Who is it"
            value={t.label}
            onChangeText={(v) => patch(i, { label: v })}
            placeholder="Billing"
          />
          <TextField
            label="Number"
            value={t.number}
            onChangeText={(v) => patch(i, { number: v })}
            placeholder="+1 555 123 4567"
            keyboardType="phone-pad"
            autoCapitalize="none"
            error={
              started(t) && !E164.test(dialable(t.number))
                ? 'Include the country code, like +1 555 123 4567.'
                : undefined
            }
          />
          <TextField
            label="When to use it"
            value={t.when}
            onChangeText={(v) => patch(i, { when: v })}
            placeholder="Anything about an invoice or a payment"
          />
          <ChipGroup
            label="How to transfer"
            value={t.warm === true ? 'warm' : t.warm === false ? 'cold' : ''}
            options={[
              { value: '', label: 'Default' },
              { value: 'warm', label: 'Introduce first' },
              { value: 'cold', label: 'Straight through' },
            ]}
            onChange={(v) => patch(i, { warm: v === 'warm' ? true : v === 'cold' ? false : null })}
          />
        </View>
      ))}

      <Button
        label="Add another"
        icon="add"
        variant="secondary"
        onPress={addTarget}
        style={{ marginBottom: spacing.lg }}
      />

      <TextField
        label="Always escalate when"
        value={triggers}
        onChangeText={setTriggers}
        placeholder={'Someone says it is an emergency\nA caller asks for the owner by name'}
        multiline
        hint="One per line."
      />
      <TextField
        label="Call back within (minutes)"
        value={sla}
        onChangeText={setSla}
        placeholder="30"
        keyboardType="number-pad"
        hint="What the receptionist promises when it takes a message. Leave blank to promise nothing."
      />
    </Sheet>
  );
}

function HoursSheet({ visible, detail, onClose, onSave }: SheetProps) {
  const primary = detail.escalation.targets[0];
  const stored = primary?.hours;
  // The schedule keeps the zone it was written in. Writing the account zone
  // over it (or 'UTC' when the account has none) would shift the live
  // transfer window by the difference - web TransferHoursFields does the same.
  const tz = stored?.timezone || detail.timezone || deviceTimeZone();
  const [on, setOn] = useState(Boolean(stored));
  const [days, setDays] = useState(
    () => stored?.days ?? Array.from({ length: 7 }, () => null),
  );
  const { busy, state, submit, confirmClose, canSave } = useSheetSave(visible, onSave, onClose);

  // Seeded on the open, never on the payload: `useQuery` hands back a brand new
  // object on every focus and foreground revalidate, so an effect keyed on
  // `detail` would re-seed the week mid-edit.
  const wasVisible = useRef(false);
  useEffect(() => {
    if (visible && !wasVisible.current) {
      const hours = detail.escalation.targets[0]?.hours;
      setOn(Boolean(hours));
      setDays(hours?.days ?? Array.from({ length: 7 }, () => null));
    }
    wasVisible.current = visible;
  }, [visible, detail]);

  const dirty =
    on !== Boolean(stored) ||
    // The days only reach the server while the switch is on, so a stale week
    // behind an off switch is not an unsaved edit.
    (on && JSON.stringify(days) !== JSON.stringify(stored?.days ?? []));

  if (!primary) {
    return (
      <Sheet visible={visible} title="When transfers are allowed" onClose={onClose}>
        <Text style={styles.sheetHint}>
          Add someone to hand calls to first - a schedule only means something once there is a
          destination to gate.
        </Text>
      </Sheet>
    );
  }

  function toggleDay(i: number) {
    setDays(days.map((d, x) => (x === i ? (d ? null : { start: '09:00', end: '17:00' }) : d)));
  }

  function setTime(i: number, key: 'start' | 'end', value: string) {
    setDays(days.map((d, x) => (x === i && d ? { ...d, [key]: value } : d)));
  }

  function build(): AssistantPatch {
    // Nothing on this sheet edits the destinations, the triggers, the callback
    // promise or the pager - and all of them are rebuilt from this payload, so
    // all of them have to be re-sent.
    const fields = escalationFields(detail, {
      keys: detail.escalation.targets.map((t) => t.id).join(','),
    });
    for (const t of detail.escalation.targets) {
      fields[`esc_${t.id}_label`] = t.label;
      fields[`esc_${t.id}_number`] = t.number;
      fields[`esc_${t.id}_when`] = t.when;
      fields[`esc_${t.id}_warm`] = t.warm === true ? 'warm' : t.warm === false ? 'cold' : '';

      // Only the first destination's week is edited here; the others keep the
      // schedule they have, zone and all.
      const isPrimary = t.id === primary.id;
      const hours = isPrimary ? (on ? { timezone: tz, days } : null) : t.hours;
      // Sending an empty timezone with no open day is how "no restriction" is
      // expressed - buildHours drops the schedule rather than storing "never".
      fields[`esc_${t.id}_tz`] = hours?.timezone ?? '';
      (hours?.days ?? []).forEach((d, i) => {
        if (!d) return;
        fields[`esc_${t.id}_day_${i}`] = true;
        fields[`esc_${t.id}_start_${i}`] = d.start;
        fields[`esc_${t.id}_end_${i}`] = d.end;
      });
    }
    return { sections: [SECTION.escalation], fields };
  }

  return (
    <Sheet
      visible={visible}
      title="When transfers are allowed"
      onClose={() => confirmClose(dirty)}
      footer={<SaveBar onSave={() => submit(build())} busy={busy} dirty={canSave(dirty)} state={state} />}
    >
      <SwitchRow
        title="Only transfer at certain hours"
        body={`Outside these hours it takes a message. Times are in ${tz.replace(/_/g, ' ')}.`}
        value={on}
        onValueChange={setOn}
      />
      {on && (
        <View style={{ marginTop: spacing.sm }}>
          {DAYS.map((label, i) => {
            const day = days[i];
            return (
              <View key={label} style={styles.dayRow}>
                <Pressable
                  onPress={() => toggleDay(i)}
                  accessibilityRole="checkbox"
                  accessibilityLabel={DAY_NAMES[i]}
                  accessibilityState={{ checked: Boolean(day) }}
                  style={styles.dayToggle}
                >
                  <Icon
                    name={day ? 'checkbox' : 'square-outline'}
                    size={22}
                    color={day ? colors.ink : colors.textSecondary}
                  />
                  <Text style={styles.dayLabel}>{label}</Text>
                </Pressable>
                {day ? (
                  <View style={styles.dayTimes}>
                    <TimeField
                      value={day.start}
                      label={`${DAY_NAMES[i]} start`}
                      onChange={(v) => setTime(i, 'start', v)}
                    />
                    <Text style={styles.dayDash}>to</Text>
                    <TimeField
                      value={day.end}
                      label={`${DAY_NAMES[i]} end`}
                      onChange={(v) => setTime(i, 'end', v)}
                    />
                  </View>
                ) : (
                  <Text style={styles.dayClosed}>Closed</Text>
                )}
              </View>
            );
          })}
        </View>
      )}
      {detail.escalation.targets.length > 1 ? (
        <Text style={styles.sheetNote}>Other destinations keep the hours set on the web.</Text>
      ) : null}
    </Sheet>
  );
}

/** 'HH:mm' as a Date today - only the wall-clock hours and minutes matter. */
function timeToDate(value: string): Date {
  const [h, m] = value.split(':').map((part) => Number(part));
  const d = new Date();
  d.setHours(Number.isFinite(h) ? h : 9, Number.isFinite(m) ? m : 0, 0, 0);
  return d;
}

function dateToTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Any time, like the web's `<input type="time">`; a time stored from there is
 * kept until it is changed. Android opens its dialog on quarter hours. iOS
 * shows the system's compact picker in place, which ignores `minuteInterval`
 * (the library honours it only for the spinner), so any minute is offered.
 * The value is always 'HH:mm', 24-hour, which is what the server parses.
 */
function TimeField({
  value,
  label,
  onChange,
}: {
  value: string;
  label: string;
  onChange: (v: string) => void;
}) {
  const date = useMemo(() => timeToDate(value), [value]);

  if (Platform.OS === 'ios') {
    return (
      <DateTimePicker
        value={date}
        mode="time"
        display="compact"
        minuteInterval={15}
        accentColor={colors.ink}
        themeVariant="light"
        accessibilityLabel={label}
        onChange={(event, next) => {
          if (event.type === 'set' && next) onChange(dateToTime(next));
        }}
      />
    );
  }

  return (
    <Pressable
      onPress={() =>
        DateTimePickerAndroid.open({
          value: date,
          mode: 'time',
          is24Hour: true,
          minuteInterval: 15,
          onChange: (event, next) => {
            if (event.type === 'set' && next) onChange(dateToTime(next));
          },
        })
      }
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${value}`}
      android_ripple={ripple}
      style={({ pressed: down }) => [styles.timeBox, down && pressed]}
    >
      <Text style={styles.timeText} maxFontSizeMultiplier={MAX_FONT_SCALE}>
        {value}
      </Text>
    </Pressable>
  );
}

function GuardrailsSheet({ visible, detail, onClose, onSave }: SheetProps) {
  const [never, setNever] = useState(detail.guardrails.neverDiscuss.join('\n'));
  const [escalate, setEscalate] = useState(detail.guardrails.alwaysEscalate.join('\n'));
  const [disclosure, setDisclosure] = useState(detail.guardrails.disclosure);
  const { busy, state, submit, confirmClose, canSave } = useSheetSave(visible, onSave, onClose);

  // Seeded on the open, never on the payload: `useQuery` hands back a brand new
  // object on every focus and foreground revalidate, so an effect keyed on
  // `detail.guardrails` would wipe a half-typed list.
  const wasVisible = useRef(false);
  useEffect(() => {
    if (visible && !wasVisible.current) {
      setNever(detail.guardrails.neverDiscuss.join('\n'));
      setEscalate(detail.guardrails.alwaysEscalate.join('\n'));
      setDisclosure(detail.guardrails.disclosure);
    }
    wasVisible.current = visible;
  }, [visible, detail.guardrails]);

  const dirty =
    never !== detail.guardrails.neverDiscuss.join('\n') ||
    escalate !== detail.guardrails.alwaysEscalate.join('\n') ||
    disclosure !== detail.guardrails.disclosure;

  return (
    <Sheet
      visible={visible}
      title="What it must not do"
      onClose={() => confirmClose(dirty)}
      footer={
        <SaveBar
          onSave={() =>
            submit({
              sections: [SECTION.guardrails],
              fields: {
                guardrail_never: never,
                guardrail_escalate: escalate,
                disclosure,
              },
            })
          }
          busy={busy}
          dirty={canSave(dirty)}
          state={state}
        />
      }
    >
      <TextField
        label="Never answer from its own knowledge"
        value={never}
        onChangeText={setNever}
        placeholder={'Legal advice\nAnything about a specific medical case'}
        multiline
        hint="One per line. It says it cannot help with these and offers a person instead."
      />
      <TextField
        label="Always send straight to a person"
        value={escalate}
        onChangeText={setEscalate}
        placeholder={'A complaint\nAnything urgent'}
        multiline
        hint="One per line."
      />
      <ChipGroup
        label="Saying it is an AI"
        value={disclosure}
        options={[
          { value: 'if_asked', label: 'If asked' },
          { value: 'upfront', label: 'Up front' },
          // No "Deflect": the server retired that value and stores it as
          // "if_asked", so offering it would report a save that never happened.
        ]}
        onChange={(v) => setDisclosure(v as typeof disclosure)}
      />
      <Text style={styles.sheetHint}>
        Some places require disclosure up front. Check what applies to you.
      </Text>
    </Sheet>
  );
}

/**
 * Where a message alert goes: the pager number, else the first person calls
 * are handed to - lib/call-engine/escalation.ts on the web. With neither,
 * nothing is sent at all.
 */
function alertNumberOf(detail: AssistantDetail): string {
  return detail.escalation.page?.number || detail.escalation.targets[0]?.number || '';
}

function AlertsSheet({ visible, detail, onClose, onSave }: SheetProps) {
  const [sms, setSms] = useState(detail.smsAlerts);
  const [emailOn, setEmailOn] = useState(detail.emailTranscripts.enabled);
  const [emailTo, setEmailTo] = useState(detail.emailTranscripts.to);
  const { busy, state, submit, confirmClose, canSave } = useSheetSave(visible, onSave, onClose);

  // Seeded on the open, never on the payload: `useQuery` hands back a brand new
  // object on every focus and foreground revalidate, so an effect keyed on
  // `detail.emailTranscripts` would reset a half-typed address.
  const wasVisible = useRef(false);
  useEffect(() => {
    if (visible && !wasVisible.current) {
      setSms(detail.smsAlerts);
      setEmailOn(detail.emailTranscripts.enabled);
      setEmailTo(detail.emailTranscripts.to);
    }
    wasVisible.current = visible;
  }, [visible, detail.smsAlerts, detail.emailTranscripts]);

  const dirty =
    sms !== detail.smsAlerts ||
    emailOn !== detail.emailTranscripts.enabled ||
    emailTo !== detail.emailTranscripts.to;

  const alertNumber = alertNumberOf(detail);

  return (
    <Sheet
      visible={visible}
      title="Alerts and recaps"
      onClose={() => confirmClose(dirty)}
      footer={
        <SaveBar
          onSave={() =>
            submit({
              // Two sections. Note what is NOT in `fields`: transfer_to and
              // transfer_hours_tz. Sending the alerts section without them is
              // exactly what stops this sheet from wiping the transfer setup.
              sections: [SECTION.alerts, SECTION.email],
              fields: {
                sms_alerts: sms,
                email_enabled: emailOn,
                email_to: emailTo.trim(),
              },
            })
          }
          busy={busy}
          dirty={canSave(dirty)}
          state={state}
        />
      }
    >
      {/* The server texts only when a message is taken (or a booking needs a
          person), and only to the alert number - so that is what this says.
          Disabled while there is nowhere to send it, except that a switch
          already on can always be turned off. */}
      <SwitchRow
        title="Text me when it takes a message"
        body={alertNumber ? `Sent to ${formatPhone(alertNumber)}` : 'Add someone to hand calls to first.'}
        value={sms}
        onValueChange={setSms}
        disabled={!alertNumber && !sms}
      />
      <View style={{ height: spacing.lg }} />
      <SwitchRow
        title="Email the transcript"
        body="The full conversation, sent after every call."
        value={emailOn}
        onValueChange={setEmailOn}
      />
      <View style={{ height: spacing.lg }} />
      <TextField
        label="Send transcripts to"
        value={emailTo}
        onChangeText={setEmailTo}
        placeholder="you@company.com"
        keyboardType="email-address"
        autoCapitalize="none"
        hint="Leave blank to turn transcript emails off entirely."
      />
    </Sheet>
  );
}

/** Legacy 'busy' is 'read' everywhere now; the server maps it too. */
const levelOf = (level: string) => (level === 'busy' ? 'read' : level);

function CalendarSheet({ visible, detail, onClose, onSave }: SheetProps) {
  const [levels, setLevels] = useState<Record<string, string>>({});
  const { busy, state, submit, confirmClose, canSave } = useSheetSave(visible, onSave, onClose);

  // Seeded on the open, never on the payload: `useQuery` hands back a brand new
  // object on every focus and foreground revalidate, so an effect keyed on
  // `detail.calendars` would undo a chip the operator just tapped.
  const wasVisible = useRef(false);
  useEffect(() => {
    if (visible && !wasVisible.current) {
      setLevels(Object.fromEntries(detail.calendars.map((c) => [c.id, levelOf(c.level)])));
    }
    wasVisible.current = visible;
  }, [visible, detail.calendars]);

  // `levels` starts empty and is filled by the effect above, so fall back to the
  // stored level rather than reading an unseeded id as a change.
  const dirty = detail.calendars.some(
    (c) => (levels[c.id] ?? levelOf(c.level)) !== levelOf(c.level),
  );

  const router = useRouter();

  return (
    <Sheet
      visible={visible}
      title="Booking"
      onClose={() => confirmClose(dirty)}
      footer={
        detail.calendars.length > 0 ? (
          <SaveBar
            onSave={() =>
              submit({
                sections: [SECTION.calendar],
                fields: Object.fromEntries(
                  detail.calendars.map((c) => [`cal_access_${c.id}`, levels[c.id] ?? 'none']),
                ),
              })
            }
            busy={busy}
            dirty={canSave(dirty)}
            state={state}
          />
        ) : undefined
      }
    >
      {detail.calendars.length === 0 ? (
        <>
          <Text style={styles.sheetHint}>
            No calendar is connected, so the receptionist can only take a message. Connect one and
            it books appointments straight into it.
          </Text>
          <Button
            label="Connect a calendar"
            onPress={() => {
              onClose();
              router.push('/calendar/connections');
            }}
            style={{ marginTop: spacing.lg }}
          />
        </>
      ) : (
        detail.calendars.map((c) => (
          <View key={c.id} style={{ marginBottom: spacing.lg }}>
            <ChipGroup
              label={c.name}
              value={levels[c.id] ?? 'none'}
              options={[
                { value: 'none', label: 'No access' },
                { value: 'read', label: 'Check availability' },
                { value: 'write', label: 'Book into it' },
              ]}
              onChange={(v) => setLevels({ ...levels, [c.id]: v })}
            />
          </View>
        ))
      )}
    </Sheet>
  );
}

// ── Summaries ───────────────────────────────────────────────────────────────

function describeHours(hours: AssistantDetail['escalation']['targets'][number]['hours']): string {
  if (!hours) return 'Any time';
  const open = hours.days
    .map((d, i) => (d ? DAYS[i] : null))
    .filter(Boolean)
    .join(', ');
  return open ? `${open}` : 'Any time';
}

function describeCalendars(calendars: AssistantDetail['calendars']): string {
  const using = calendars.filter((c) => c.level !== 'none');
  if (using.length === 0) return 'Connected, but it cannot use it yet';
  return using.map((c) => c.name).join(', ');
}

function describeGuardrails(detail: AssistantDetail): string {
  const n = detail.guardrails.neverDiscuss.length;
  const e = detail.guardrails.alwaysEscalate.length;
  if (!n && !e) return 'No limits set';
  const parts: string[] = [];
  if (n) parts.push(`${n} off-limits`);
  if (e) parts.push(`${e} always escalated`);
  return parts.join(' · ');
}

function describeAlerts(detail: AssistantDetail): string {
  const parts: string[] = [];
  if (detail.smsAlerts) parts.push('Texts messages');
  if (detail.emailTranscripts.enabled && detail.emailTranscripts.to) parts.push('Emails transcripts');
  return parts.length ? parts.join(' · ') : 'Nothing sent after a call';
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md },
  flex: { flex: 1 },
  heroHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  heroName: { ...type.heading },
  statusLine: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: 2,
  },
  statusText: { ...type.labelLg },
  // The NumberLine carries its own top margin; the block only spaces what follows it.
  numberBlock: { gap: spacing.md },
  numberWarn: { ...type.bodySm, marginTop: spacing.lg, color: colors.warningText },
  // Pulled up under the picker: SelectRow keeps a field's bottom margin.
  rate: { ...type.caption, marginTop: -spacing.sm, fontVariant: ['tabular-nums'] },
  testCall: { gap: spacing.sm },
  testLabel: { ...type.label, color: colors.inkSoft },
  testState: { ...type.caption },
  // Text buttons at both ends, their labels lined up with the content edges
  // (a pill pads its label by 14).
  linkRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginHorizontal: -14,
  },
  groupTitle: { ...type.eyebrow, marginTop: spacing.sm },
  topics: { paddingVertical: spacing.xs },
  divided: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  toolRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  toolName: { ...type.bodySm, fontFamily: fonts.semibold },
  toolUrl: { ...type.caption, marginTop: 2 },
  footnote: { ...type.caption, marginTop: spacing.sm },
  delete: { marginTop: spacing.lg },
  fieldLabel: { ...type.label, marginBottom: 6, color: colors.inkSoft },
  sheetHint: { ...type.footnote },
  sheetNote: { ...type.footnote, marginTop: spacing.lg },
  voiceList: { marginBottom: spacing.lg },
  voiceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  voiceMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 56,
    paddingVertical: spacing.sm,
  },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOn: { borderColor: colors.ink },
  radioDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: colors.ink },
  voiceName: { ...type.body, fontFamily: fonts.medium },
  voiceTags: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: 4 },
  // The one card in the app that sits inside a sheet: the same surface as
  // every other, a little less padding because it is a nested form.
  targetCard: {
    ...cardStyle,
    padding: spacing.lg,
    marginBottom: spacing.lg,
  },
  targetHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  targetIndex: { ...type.caption, fontFamily: fonts.medium },
  dayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    minHeight: 52,
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  dayToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 44,
    paddingRight: spacing.sm,
  },
  // A minimum, not a width: "Wed" at a large text size must not clip.
  dayLabel: { ...type.body, minWidth: 40 },
  dayTimes: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dayDash: { ...type.footnote },
  dayClosed: { ...type.footnote },
  timeBox: {
    paddingHorizontal: spacing.md,
    // 44 is the platform minimum tap target, and these two sit 8pt apart in a
    // dense seven-row list where a mis-tap edits the wrong day.
    minHeight: 44,
    minWidth: 64,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSubtle,
  },
  timeText: {
    ...type.bodySm,
    fontFamily: fonts.medium,
    fontVariant: ['tabular-nums'],
  },
});
