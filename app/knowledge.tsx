import * as Haptics from 'expo-haptics';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AvatarRing } from '@/components/avatar';
import { ChipGroup, inputStyle, SaveBar, Sheet, TextField } from '@/components/form';
import { Icon } from '@/components/Icon';
import { AiConsent } from '@/components/paywall';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  ICON,
  ListRow,
  Loading,
  pressed,
  SectionCard,
  Skeleton,
  SkeletonCard,
  StaleNotice,
} from '@/components/ui';
import { colors, fonts, MAX_FONT_SCALE, radius, spacing, type } from '@/constants/theme';
import { api, ApiError } from '@/lib/api';
import { relTimeOf } from '@/lib/format';
import type { KnowledgeGap, KnowledgeSourceRow } from '@/lib/types';
import { useQuery } from '@/lib/use-query';

/**
 * What the receptionist knows - reached from the Receptionist tab's "What it
 * knows" row (the web's sixth nav item, folded under Receptionist so the tab
 * bar keeps five).
 *
 * Mirrors /dashboard/knowledge minus PDF upload: a 15 MB file pushed over a
 * cellular link and parsed synchronously fails far more often than it works, and
 * "add a website" plus "type it out" reach the same place from a phone. The
 * upload stays on the web for now and the footnote says so.
 */
export default function KnowledgeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [business, setBusiness] = useState<string | undefined>(undefined);
  const { data, error, loading, refresh } = useQuery(
    () => api.knowledge(business),
    [business],
  );

  const [teachOpen, setTeachOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  // The pull spinner is driven from here rather than by `useQuery`'s
  // `refreshing`, because this screen also refetches on its own (the digest
  // retry below, and after every save) and a spinner nobody pulled reads as
  // the app doing something unasked.
  const [pulling, setPulling] = useState(false);
  // Answered and dismissed questions leave the list the moment the server
  // accepts them; the refetch behind confirms it.
  const [cleared, setCleared] = useState<Set<number>>(() => new Set());

  // A digest that is still being written: refetch once, a few seconds on. A
  // later save that makes it pending again flips this back and retries again.
  const pending = data?.digestPending ?? false;
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => void refresh(), 5000);
    return () => clearTimeout(timer);
  }, [pending, refresh]);

  async function pull() {
    setPulling(true);
    try {
      await refresh();
    } finally {
      setPulling(false);
    }
  }

  function clearGap(id: number) {
    setCleared((prev) => new Set(prev).add(id));
    void refresh();
  }

  const title = <Stack.Screen options={{ title: 'Knowledge' }} />;

  // Switching business re-runs the query with loading=true. Blanking the screen
  // then would take the chip row away the moment it was tapped, and the GET can
  // wait on an LLM digest, so the last payload stays up until the new one lands.
  if (loading && !data) {
    return (
      <View style={[styles.root, styles.body]}>
        {title}
        {/* The shape of what is coming: the digest card, the button row, a sources card. */}
        <View accessible accessibilityLabel="Loading" style={styles.body}>
          <Card>
            <View style={styles.digestHead}>
              <Skeleton width={44} height={44} radius={22} />
              <Skeleton width="45%" height={16} />
            </View>
            <View style={styles.skeletonLines}>
              <Skeleton width="92%" height={10} />
              <Skeleton width="78%" height={10} />
              <Skeleton width="60%" height={10} />
            </View>
          </Card>
          <View style={styles.teachRow}>
            <View style={styles.flex}>
              <Skeleton height={44} radius={radius.md} />
            </View>
            <Skeleton width={96} height={44} radius={radius.md} />
          </View>
          <SkeletonCard lines={3} />
        </View>
      </View>
    );
  }

  // A failed focus refetch or foreground revalidate still sets `error` while the
  // last good payload is intact. Unmounting on `error` here would throw a full
  // screen of knowledge away over one lost packet; the notice below says it is
  // stale instead.
  if (!data) {
    return (
      <View style={styles.root}>
        {title}
        <ErrorState message={error ?? 'Could not load what it knows.'} onRetry={refresh} />
      </View>
    );
  }

  // A load with a payload already on screen is a business switch. The chip
  // highlights the new pick the instant it is tapped, so everything that pick
  // controls has to say it is busy: leaving the previous business's digest,
  // sources and notes up under the new highlight invites an edit that saves
  // straight back into the business the user just left.
  const switching = loading;

  const isEmpty = data.sources.length === 0 && !data.notes && !data.verified;
  const gaps = data.gaps.filter((g) => !cleared.has(g.id));

  return (
    <>
      {title}
      {/* The answer fields below sit in the page itself, not in a sheet, so
          the page has to make room for the keyboard - one mechanism per
          platform, never both. iOS: the ScrollView's own
          `automaticallyAdjustKeyboardInsets`; stacking KAV padding on top would
          leave a second keyboard height of blank inset. Android: KAV `padding`,
          for the reason the Sheet gives - edge-to-edge Android no longer
          resizes the window for the keyboard. */}
      <KeyboardAvoidingView
        style={styles.root}
        behavior={Platform.OS === 'android' ? 'padding' : undefined}
      >
        <ScrollView
          style={styles.root}
          contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + spacing.xxl }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          automaticallyAdjustKeyboardInsets
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

          {data.businesses.length > 1 && (
            <ChipGroup
              // The local pick, not the payload's, so the tapped chip highlights
              // immediately instead of waiting for the round trip.
              value={business ?? data.activeBusinessId}
              options={data.businesses.map((b) => ({ value: b.id, label: b.name }))}
              onChange={setBusiness}
            />
          )}

          {switching ? (
            <View style={styles.bodyBusy}>
              <Loading />
            </View>
          ) : (
            <>
              <Card>
                <View style={styles.digestHead}>
                  <AvatarRing size={44} mood="studying" />
                  <Text style={styles.digestTitle} accessibilityRole="header">
                    What it can answer
                  </Text>
                </View>
                <Text style={styles.digestBody} accessibilityLiveRegion="polite">
                  {data.digestPending
                    ? 'Summarizing what it learned...'
                    : data.digest ||
                      'Nothing yet. Add your website or type what callers ask about, and it learns.'}
                </Text>
              </Card>

              <View style={styles.teachRow}>
                <Button
                  label="Teach it something"
                  icon="add"
                  onPress={() => setTeachOpen(true)}
                  style={styles.flex}
                />
                {/* Sized to its label, so the main action keeps one line. */}
                <Button
                  label="Exact answers"
                  icon="document-text-outline"
                  variant="secondary"
                  onPress={() => setNotesOpen(true)}
                />
              </View>
              {/* Two ways in, and the difference said once: taught material is
                  summarized, exact answers are repeated word for word. */}
              <Text style={styles.teachHint}>
                Teach it a website or notes and it learns from them. Exact answers are said back
                word for word.
              </Text>

              {gaps.length > 0 && (
                <GapsCard
                  gaps={gaps}
                  businessId={data.activeBusinessId}
                  onCleared={clearGap}
                  onOpenCall={(callId) => router.push(`/call/${callId}`)}
                />
              )}

              {isEmpty ? (
                // Among other cards, so it sits in one rather than floating between them.
                <Card>
                  <EmptyState
                    mood="studying"
                    title="It has not learned anything yet"
                    body="Add your website and it reads the whole thing, or type the answers callers ask for most."
                  />
                </Card>
              ) : (
                <SectionCard title={`Sources (${data.sources.length})`}>
                  {data.sources.length === 0 ? (
                    <Text style={styles.muted}>
                      Only your notes so far. Add a website to give it more to work with.
                    </Text>
                  ) : (
                    data.sources.map((s, i) => (
                      <SourceRow
                        key={s.id}
                        source={s}
                        divided={i > 0}
                        onRemove={async () => {
                          await api.removeKnowledgeSource(data.activeBusinessId, s.id);
                          await refresh();
                        }}
                      />
                    ))
                  )}
                </SectionCard>
              )}

              <SectionCard title="What else it uses">
                <ListRow
                  icon="person-outline"
                  label="Your details"
                  value={data.ownerNotesShared ? 'Shared with callers' : 'Not shared with callers'}
                  onPress={() => router.push('/settings/profile')}
                />
                <ListRow
                  icon="calendar-outline"
                  label="Appointment booking"
                  value={
                    data.calendarsConnected > 0
                      ? 'Can book appointments'
                      : "Can't book yet - no calendar connected"
                  }
                  onPress={() => router.push('/calendar/connections')}
                  divided
                />
              </SectionCard>
            </>
          )}

          <Text style={styles.footnote}>
            PDF upload is coming to the app. You can add a PDF from the website dashboard for now.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>

      <TeachSheet
        visible={teachOpen}
        businessId={data.activeBusinessId}
        onClose={() => setTeachOpen(false)}
        onSaved={refresh}
      />
      <NotesSheet
        visible={notesOpen}
        businessId={data.activeBusinessId}
        notes={data.notes}
        verified={data.verified}
        onClose={() => setNotesOpen(false)}
        onSaved={refresh}
      />
    </>
  );
}

// ── Questions it could not answer ───────────────────────────────────────────

/**
 * The web's GapList. Two kinds, deliberately different: an `unanswered` row is
 * a gap with a fix (type a sentence, it becomes an exact answer); a
 * `not_offered` row has none - the caller wanted something the business does
 * not do - so it can only be noted and dismissed.
 */
function GapsCard({
  gaps,
  businessId,
  onCleared,
  onOpenCall,
}: {
  gaps: KnowledgeGap[];
  businessId: string;
  onCleared: (id: number) => void;
  onOpenCall: (callId: string) => void;
}) {
  const answerable = gaps.filter((g) => g.kind === 'unanswered');
  const market = gaps.filter((g) => g.kind === 'not_offered');
  return (
    <SectionCard
      title="Questions it could not answer"
      subtitle="Callers asked these and got a message taken instead. Answer one and your receptionist uses your exact words from the next call on."
    >
      {answerable.map((g, i) => (
        <GapRow
          key={g.id}
          gap={g}
          businessId={businessId}
          divided={i > 0}
          onCleared={onCleared}
          onOpenCall={onOpenCall}
        />
      ))}
      {market.length > 0 && (
        <View style={[styles.market, answerable.length > 0 && { marginTop: spacing.md }]}>
          <Text style={styles.marketTitle} accessibilityRole="header">
            Asked for, but not something you offer
          </Text>
          {market.map((g) => (
            <MarketRow key={g.id} gap={g} businessId={businessId} onCleared={onCleared} />
          ))}
        </View>
      )}
    </SectionCard>
  );
}

/**
 * Both gap actions answer 404 when the question is already gone (answered on
 * the web, or a second tap), which is the outcome that was wanted - so a 404
 * clears the row like a success does.
 */
function useGapAction(gap: KnowledgeGap, onCleared: (id: number) => void) {
  const [busy, setBusy] = useState<'answer' | 'dismiss' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function run(kind: 'answer' | 'dismiss', call: () => Promise<unknown>) {
    setBusy(kind);
    setFailure(null);
    try {
      await call();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onCleared(gap.id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        onCleared(gap.id);
        return;
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setFailure((err as Error).message || "That didn't save. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  return { busy, failure, run };
}

function GapRow({
  gap,
  businessId,
  divided,
  onCleared,
  onOpenCall,
}: {
  gap: KnowledgeGap;
  businessId: string;
  divided: boolean;
  onCleared: (id: number) => void;
  onOpenCall: (callId: string) => void;
}) {
  const [answer, setAnswer] = useState('');
  const [focused, setFocused] = useState(false);
  const { busy, failure, run } = useGapAction(gap, onCleared);
  const trimmed = answer.trim();

  // Gated on a non-empty answer, as on the web: an empty exact answer is worse
  // than none, because the receptionist believes it has one.
  const save = () => {
    if (!trimmed || busy) return;
    void run('answer', () => api.knowledgeAnswerGap(businessId, gap.id, trimmed));
  };

  return (
    <View style={[styles.gapRow, divided && styles.divided]}>
      <Text style={styles.gapTopic}>{gap.topic}</Text>
      {gap.quote ? <Text style={styles.gapQuote}>&quot;{gap.quote}&quot;</Text> : null}
      {/* No visible label, as on the web: the question right above is the
          label. VoiceOver gets it spelled out, since three fields that all
          announce "Your answer" cannot be told apart from the rotor. */}
      <TextInput
        style={[
          styles.answerInput,
          focused && styles.answerInputFocused,
          failure ? styles.answerInputError : null,
        ]}
        value={answer}
        onChangeText={setAnswer}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder="Type the answer, in your own words"
        placeholderTextColor={colors.textMuted}
        maxLength={600}
        returnKeyType="done"
        submitBehavior="blurAndSubmit"
        onSubmitEditing={save}
        maxFontSizeMultiplier={MAX_FONT_SCALE}
        accessibilityLabel={`Answer: ${gap.topic}`}
        accessibilityHint={failure ?? undefined}
      />
      {failure ? (
        <Text style={styles.gapError} accessibilityLiveRegion="polite">
          {failure}
        </Text>
      ) : null}
      <View style={styles.gapActions}>
        <Button
          label="Save answer"
          size="pill"
          onPress={save}
          busy={busy === 'answer'}
          disabled={!trimmed || busy === 'dismiss'}
        />
        <Button
          label="Dismiss"
          size="pill"
          variant="ghost"
          onPress={() => void run('dismiss', () => api.knowledgeDismissGap(businessId, gap.id))}
          busy={busy === 'dismiss'}
          disabled={busy === 'answer'}
        />
        {gap.callId ? (
          <Button
            label="Open call"
            size="pill"
            variant="ghost"
            icon="call-outline"
            onPress={() => onOpenCall(gap.callId as string)}
            style={styles.gapOpenCall}
          />
        ) : null}
      </View>
    </View>
  );
}

function MarketRow({
  gap,
  businessId,
  onCleared,
}: {
  gap: KnowledgeGap;
  businessId: string;
  onCleared: (id: number) => void;
}) {
  const { busy, failure, run } = useGapAction(gap, onCleared);
  return (
    <View style={styles.marketRow}>
      <View style={styles.flex} accessible>
        <Text style={styles.marketText}>
          <Text style={styles.marketTopic}>{gap.topic}</Text>
          {gap.quote ? ` - "${gap.quote}"` : ''}
        </Text>
        {failure ? (
          <Text style={styles.gapError} accessibilityLiveRegion="polite">
            {failure}
          </Text>
        ) : null}
      </View>
      <Button
        label="Dismiss"
        size="pill"
        variant="ghost"
        onPress={() => void run('dismiss', () => api.knowledgeDismissGap(businessId, gap.id))}
        busy={busy === 'dismiss'}
      />
    </View>
  );
}

// ── Sources ─────────────────────────────────────────────────────────────────

function SourceRow({
  source,
  divided,
  onRemove,
}: {
  source: KnowledgeSourceRow;
  divided: boolean;
  onRemove: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const icon =
    source.kind === 'website' ? 'globe-outline' : source.kind === 'pdf' ? 'document-outline' : 'create-outline';
  const kindLabel = source.kind === 'website' ? 'Website' : source.kind === 'pdf' ? 'PDF' : 'Notes';

  function confirm() {
    Alert.alert('Remove this source?', `"${source.title}" stops informing answers.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          try {
            await onRemove();
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          } catch (err) {
            // The row is still on screen when the delete fails, which reads as a
            // stale list rather than a failure. Without this the user pulls to
            // refresh and sees the source again with no idea why.
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
            Alert.alert('Could not remove', (err as Error).message);
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  }

  const added = source.addedAt ? `Added ${relTimeOf(source.addedAt)}` : '';

  return (
    <View style={[styles.sourceRow, divided && styles.divided]}>
      <Icon name={icon} size={ICON.row} color={colors.textSecondary} style={styles.sourceIcon} />
      <View
        style={styles.flex}
        accessible
        accessibilityLabel={[kindLabel, source.title, source.summary, added].filter(Boolean).join(', ')}
      >
        <Text style={styles.sourceTitle} numberOfLines={1}>
          {source.title}
        </Text>
        {Boolean(source.summary) && (
          <Text style={styles.sourceSummary} numberOfLines={2}>
            {source.summary}
          </Text>
        )}
        {added ? <Text style={styles.sourceMeta}>{added}</Text> : null}
      </View>
      <Pressable
        onPress={confirm}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={`Remove ${source.title}`}
        accessibilityState={{ disabled: busy, busy }}
        // A real 44pt box rather than hitSlop: slop grows the touch region but
        // leaves the screen-reader focus frame at the 18pt glyph, and the
        // negative margin keeps the row's layout close to the glyph's own.
        style={({ pressed: down }) => [styles.removeHit, down && pressed]}
      >
        <Icon name="trash-outline" size={ICON.row} color={busy ? colors.textMuted : colors.errorText} />
      </Pressable>
    </View>
  );
}

// ── Sheets ──────────────────────────────────────────────────────────────────

// Permissive on purpose: this only catches what the server is certain to reject
// (whitespace, or a host with no dot). Anything stricter would refuse ports,
// query-only URLs and every non-ASCII hostname that the importer handles fine.
const URL_SHAPE = /^(?:https?:\/\/)?[^\s/?#:@]+\.[^\s/?#:@]{2,}(?::\d+)?(?:[/?#]\S*)?$/i;

function TeachSheet({
  visible,
  businessId,
  onClose,
  onSaved,
}: {
  visible: boolean;
  businessId: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [mode, setMode] = useState('website');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<{ ok: boolean; message: string } | null>(null);
  // What is typed here goes to Google Gemini to be read and summarized, so
  // nothing is sent before the user has agreed to that (5.1.2(i)). AiConsent
  // reports true on its own when the device already holds the consent.
  const [consent, setConsent] = useState(false);

  // The website add can run for tens of seconds and nothing stops the sheet from
  // being dismissed under it, so the result has to know whether anyone is still
  // looking at the SaveBar.
  const visibleRef = useRef(visible);
  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  // A reopened sheet must not show the previous attempt's result, but it must
  // still explain a request that is still running - otherwise Add is a disabled
  // spinner with no caption until the old request settles.
  useEffect(() => {
    if (visible) setState(busy ? { ok: true, message: 'Still reading that page...' } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `busy` is read, not tracked
  }, [visible]);

  const trimmedUrl = url.trim();
  const urlOk = URL_SHAPE.test(trimmedUrl);
  const filled = mode === 'website' ? urlOk : text.trim().length > 0;
  // Only once what is typed could plausibly be a whole address. Judging every
  // keystroke would flag "https://exa" and, because Field shows either an error
  // or a hint, would swallow the "this takes a few seconds" line while typing.
  const urlError =
    trimmedUrl.includes('.') || trimmedUrl.length > 12
      ? urlOk
        ? undefined
        : 'That does not look like a web address.'
      : undefined;

  async function save() {
    if (!consent) return;
    setBusy(true);
    setState(null);
    try {
      const res =
        mode === 'website'
          ? await api.addKnowledgeWebsite(businessId, trimmedUrl)
          : await api.addKnowledgeText(businessId, text.trim());
      // The refresh and the field reset happen either way, so an add that landed
      // after the sheet was dismissed still shows up in the list.
      await onSaved();
      setUrl('');
      setText('');
      if (res.warning) {
        if (visibleRef.current) setState({ ok: true, message: res.warning });
        else Alert.alert('Added, with a catch', res.warning);
      } else {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        if (visibleRef.current) onClose();
      }
    } catch (err) {
      const message = (err as Error).message;
      if (visibleRef.current) setState({ ok: false, message });
      else Alert.alert('Could not add that page', message);
    } finally {
      setBusy(false);
    }
  }

  // The X and the Android back gesture both dismiss without saving, like every
  // other sheet - and like them, something typed gets a word in first.
  function requestClose() {
    if (!url.trim() && !text.trim()) return onClose();
    Alert.alert('Discard this?', 'What you typed has not been added.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: onClose },
    ]);
  }

  return (
    <Sheet
      visible={visible}
      title="Teach it something"
      onClose={requestClose}
      footer={
        <SaveBar onSave={save} busy={busy} dirty={filled && consent} state={state} label="Add" />
      }
    >
      <AiConsent accepted={consent} onChange={setConsent} />
      <View style={{ height: spacing.lg }} />
      <ChipGroup
        value={mode}
        options={[
          { value: 'website', label: 'A website' },
          { value: 'text', label: 'Type it out' },
        ]}
        onChange={setMode}
      />
      <View style={{ height: spacing.lg }} />
      {mode === 'website' ? (
        <TextField
          label="Web address"
          value={url}
          onChangeText={setUrl}
          placeholder="https://yourbusiness.com/services"
          keyboardType="url"
          autoCapitalize="none"
          error={urlError}
          hint="It reads the page and keeps what a caller might ask about. Reading a long page takes a few seconds."
        />
      ) : (
        <TextField
          label="What should it know?"
          value={text}
          onChangeText={setText}
          placeholder={'Opening hours, what you charge, where you are, what you do not do...'}
          multiline
          hint="Write it the way you would tell a new hire."
        />
      )}
    </Sheet>
  );
}

function NotesSheet({
  visible,
  businessId,
  notes,
  verified,
  onClose,
  onSaved,
}: {
  visible: boolean;
  businessId: string;
  notes: string;
  verified: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [draftNotes, setDraftNotes] = useState(notes);
  const [draftVerified, setDraftVerified] = useState(verified);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<{ ok: boolean; message: string } | null>(null);
  // Notes are summarized by the same third-party model as anything taught, so
  // they are gated by the same consent.
  const [consent, setConsent] = useState(false);

  // Reseed from the server on the open transition only, so a save elsewhere (or
  // a pull-to-refresh behind it) does not leave a stale draft on screen. Keying
  // this off the props instead would let the foreground revalidate behind the
  // open sheet overwrite whatever the user is in the middle of typing.
  const wasOpen = useRef(false);
  const seeded = useRef({ notes, verified });
  useEffect(() => {
    if (visible && !wasOpen.current) {
      seeded.current = { notes, verified };
      setDraftNotes(notes);
      setDraftVerified(verified);
      setState(null);
    }
    wasOpen.current = visible;
  }, [visible, notes, verified]);

  // Measured against what the sheet was seeded with, not the live props: a focus
  // refetch behind the open sheet can change them without the user touching the
  // keyboard, and comparing to those would enable Save on a draft nobody edited
  // and prompt to discard changes that were never made.
  const dirty =
    draftNotes !== seeded.current.notes || draftVerified !== seeded.current.verified;

  async function save() {
    if (!consent) return;
    setBusy(true);
    setState(null);
    try {
      await api.saveKnowledgeNotes(businessId, draftNotes, draftVerified);
      await onSaved();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onClose();
    } catch (err) {
      setState({ ok: false, message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  // The close X and the Android back gesture both dismiss without saving, and the
  // next open reseeds from the server, so an accidental tap silently throws away
  // however much was typed. A successful save closes past this deliberately.
  function requestClose() {
    if (!dirty) return onClose();
    Alert.alert('Discard changes?', 'Your notes have not been saved.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: onClose },
    ]);
  }

  return (
    <Sheet
      visible={visible}
      title="Notes and exact answers"
      onClose={requestClose}
      footer={<SaveBar onSave={save} busy={busy} dirty={dirty && consent} state={state} />}
    >
      <AiConsent accepted={consent} onChange={setConsent} />
      <View style={{ height: spacing.lg }} />
      <TextField
        label="Notes"
        value={draftNotes}
        onChangeText={setDraftNotes}
        placeholder="Anything the receptionist should keep in mind."
        multiline
      />
      <TextField
        label="Exact answers"
        value={draftVerified}
        onChangeText={setDraftVerified}
        // Q:/A: is the only shape the server parses, and it is what the field is
        // seeded with. Anything else is dropped on save without a word, so a hint
        // that suggests another separator quietly deletes the answers.
        placeholder={'Q: Do you take walk-ins?\nA: Yes, before 4pm.\n\nQ: Is there parking?\nA: Free lot behind the building.'}
        multiline
        autoCapitalize="sentences"
        hint="One Q line, one A line, a blank line between pairs. These are said back word for word."
      />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  body: { padding: spacing.lg, gap: spacing.md },
  // Holds roughly the height of the digest card and the button row so a business
  // switch does not collapse the page and bounce the chip row up the screen.
  bodyBusy: { minHeight: 200, justifyContent: 'center' },
  flex: { flex: 1 },
  divided: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  digestHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  digestTitle: { ...type.title, flex: 1 },
  digestBody: {
    ...type.bodySm,
    marginTop: spacing.md,
    color: colors.textSecondary,
  },
  skeletonLines: { gap: spacing.sm, marginTop: spacing.md },
  teachRow: { flexDirection: 'row', gap: spacing.sm },
  teachHint: { ...type.footnote, marginTop: -spacing.xs },
  gapRow: { paddingVertical: spacing.md },
  gapTopic: { ...type.body, fontFamily: fonts.medium },
  gapQuote: { ...type.caption, marginTop: 2 },
  answerInput: {
    ...inputStyle,
    marginTop: spacing.md,
  },
  answerInputFocused: { borderColor: colors.ink },
  answerInputError: { borderColor: colors.errorText },
  gapActions: {
    marginTop: spacing.sm,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm,
  },
  gapOpenCall: { marginLeft: 'auto' },
  gapError: { ...type.caption, marginTop: 4, color: colors.errorText },
  market: {
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSubtle,
    gap: spacing.xs,
  },
  // inkSoft, not textSecondary: grey on the grey fill is 4.35:1 and fails.
  marketTitle: { ...type.label, color: colors.inkSoft },
  marketRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  marketText: { ...type.caption, color: colors.inkSoft },
  marketTopic: { fontFamily: fonts.medium, color: colors.text },
  sourceRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  sourceIcon: { marginTop: 1 },
  sourceTitle: { ...type.bodySm, fontFamily: fonts.semibold },
  sourceSummary: { ...type.footnote, marginTop: 2 },
  sourceMeta: { ...type.caption, marginTop: 4 },
  // Sized outright rather than derived from the 18pt glyph plus padding, which
  // lands 2pt short of the platform minimum.
  removeHit: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    margin: -spacing.md,
  },
  muted: { ...type.bodySm, color: colors.textSecondary },
  footnote: {
    ...type.caption,
    marginTop: spacing.xs,
    textAlign: 'center',
  },
});
