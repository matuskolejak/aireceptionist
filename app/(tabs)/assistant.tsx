import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { AvatarRing } from '@/components/avatar';
import { SaveBar, Sheet, TextField } from '@/components/form';
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
import { Screen } from '@/components/Screen';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  ICON,
  IconButton,
  ListRow,
  pressed,
  ripple,
  StaleNotice,
} from '@/components/ui';
import { colors, radius, spacing, type } from '@/constants/theme';
import { api } from '@/lib/api';
import type { AssistantDetail, AssistantSummary, KnowledgeState } from '@/lib/types';
import { useQuery } from '@/lib/use-query';

/**
 * The Receptionist tab.
 *
 * Most accounts have exactly one receptionist, and the web sends them straight
 * to it - so with one, this is a hub for it rather than a one-card list: who it
 * is and whether it is answering, the power switch, then the ways in (its
 * settings, its knowledge, adding another). With several it is the list, each
 * card with its own switch.
 *
 * Knowledge lives here too (the web's sixth nav item), which is what keeps the
 * tab bar at five.
 */
export default function ReceptionistScreen() {
  const router = useRouter();
  const { data, error, loading, refresh } = useQuery(() => api.assistants(), []);
  const [createOpen, setCreateOpen] = useState(false);
  // Only a pull the user made spins the RefreshControl; the refetch after a
  // power toggle or a create runs without it.
  const [pulling, setPulling] = useState(false);

  const count = data?.assistants.length ?? 0;
  const only = count === 1 ? data?.assistants[0] ?? null : null;
  const onlyId = only?.id ?? null;
  const hasAny = count > 0;

  // The hub's setup progress comes from the detail, which the list does not
  // carry. Only fetched for the one-receptionist hub.
  const detail = useQuery<AssistantDetail | null>(
    () => (onlyId ? api.assistant(onlyId) : Promise.resolve(null)),
    [onlyId],
  );
  // For the Knowledge row. Can be slow (the server may be writing the
  // digest), so it never holds the rest of the screen up.
  const knowledge = useQuery<KnowledgeState | null>(
    () => (hasAny ? api.knowledge() : Promise.resolve(null)),
    [hasAny],
  );

  const refreshDetail = detail.refresh;
  const refreshKnowledge = knowledge.refresh;
  // After a switch toggle or a create: the list and the hub's detail are
  // awaited, the knowledge row is not, so a slow digest never holds the switch
  // disabled or the Create button spinning.
  const refreshAfterChange = useCallback(async () => {
    void refreshKnowledge();
    await Promise.all([refresh(), refreshDetail()]);
  }, [refresh, refreshDetail, refreshKnowledge]);
  const pull = useCallback(async () => {
    setPulling(true);
    try {
      await Promise.all([refresh(), refreshDetail(), refreshKnowledge()]);
    } finally {
      setPulling(false);
    }
  }, [refresh, refreshDetail, refreshKnowledge]);

  const title = count > 1 ? 'Receptionists' : 'Receptionist';

  if (loading && !data) {
    return (
      <Screen title={title}>
        <View style={styles.body}>
          <HeroSkeleton />
          <RowsSkeleton count={3} />
        </View>
      </Screen>
    );
  }

  // `useQuery` keeps the last good payload but sets `error` on every failed
  // revalidate, including the focus and foreground refetches. Unmounting on
  // `error` would throw the cards - and the power switch - away over one lost
  // packet, so only a load that never landed takes the whole screen.
  if (!data) {
    return (
      <Screen title={title}>
        <ErrorState message={error ?? 'Could not load your receptionists.'} onRetry={refresh} />
      </Screen>
    );
  }

  const openKnowledge = () => router.push('/knowledge');

  return (
    <>
      <Screen
        title={title}
        onRefresh={pull}
        refreshing={pulling}
        // A whole-screen empty sits in the middle of the page, like Calls.
        contentStyle={count === 0 ? styles.emptyContent : undefined}
        right={
          count > 1 ? (
            <IconButton icon="add" label="Add a receptionist" onPress={() => setCreateOpen(true)} />
          ) : undefined
        }
      >
        <View style={[styles.body, count === 0 && styles.emptyBody]}>
          {error ? <StaleNotice message={error} onRetry={refresh} /> : null}

          {count === 0 ? (
            <EmptyState
              mood="greeting"
              title="Set up your receptionist"
              body="Name it, give it a number, and it starts taking calls."
            >
              <Button
                label="Create one"
                onPress={() => setCreateOpen(true)}
                style={styles.emptyAction}
              />
            </EmptyState>
          ) : only ? (
            <Hub
              assistant={only}
              detail={detail.data}
              knowledge={knowledge.data}
              onChanged={refreshAfterChange}
              onOpen={() => router.push(`/assistant/${only.id}`)}
              onOpenKnowledge={openKnowledge}
              onAdd={() => setCreateOpen(true)}
            />
          ) : (
            <>
              <Card style={styles.rowsCard}>
                <KnowledgeRow knowledge={knowledge.data} onPress={openKnowledge} />
              </Card>
              {data.assistants.map((a) => (
                <AssistantCard
                  key={a.id}
                  assistant={a}
                  onChanged={refreshAfterChange}
                  onOpen={() => router.push(`/assistant/${a.id}`)}
                />
              ))}
            </>
          )}
        </View>
      </Screen>

      <CreateSheet
        visible={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={async (id, warning) => {
          setCreateOpen(false);
          await refreshAfterChange();
          if (warning) Alert.alert('Created, with a problem', warning);
          router.push(`/assistant/${id}`);
        }}
      />
    </>
  );
}

function StatusLine({ status, connected }: { status: { text: string; color: string }; connected: boolean }) {
  return (
    <View style={styles.statusLine}>
      <Text style={[styles.statusText, { color: status.color }]}>{status.text}</Text>
      {!connected && <Badge label="Not synced" tone="warning" />}
    </View>
  );
}

// ── One receptionist: the hub ───────────────────────────────────────────────

function Hub({
  assistant,
  detail,
  knowledge,
  onChanged,
  onOpen,
  onOpenKnowledge,
  onAdd,
}: {
  assistant: AssistantSummary;
  detail: AssistantDetail | null;
  knowledge: KnowledgeState | null;
  onChanged: () => Promise<void>;
  onOpen: () => void;
  onOpenKnowledge: () => void;
  onAdd: () => void;
}) {
  const power = usePower(assistant, onChanged);
  const status = statusOf(power.enabled, assistant.number);
  const done = detail?.setup.items.filter((i) => i.done).length ?? 0;
  const total = detail?.setup.items.length ?? 0;

  return (
    <>
      <Card>
        <View style={styles.hubHead}>
          <AvatarRing size={56} mood={status.live ? 'friendly' : 'greeting'} status={status.ring} />
          <View style={styles.flex}>
            <Text style={styles.hubName} numberOfLines={2} accessibilityRole="header">
              {assistant.name}
            </Text>
            <StatusLine status={status} connected={assistant.connected} />
          </View>
          <PowerSwitch
            name={assistant.name}
            value={power.enabled}
            busy={power.busy}
            onChange={power.toggle}
          />
        </View>

        {assistant.number ? (
          <NumberLine number={assistant.number} />
        ) : (
          <Text style={styles.warn}>
            No number points at this receptionist, so nothing reaches it yet. Get one in its
            settings.
          </Text>
        )}

        {detail && total > 0 && done < total ? <SetupProgress done={done} total={total} /> : null}
      </Card>

      <Card style={styles.rowsCard}>
        <ListRow
          icon="options-outline"
          label="Receptionist settings"
          value="Voice, greeting, transfers, booking and alerts"
          onPress={onOpen}
        />
        <KnowledgeRow knowledge={knowledge} onPress={onOpenKnowledge} divided />
        <ListRow
          icon="add-circle-outline"
          label="Add another receptionist"
          onPress={onAdd}
          divided
        />
      </Card>
    </>
  );
}

/** Knowledge: how much it has to go on, and the start of the digest. */
function KnowledgeRow({
  knowledge,
  onPress,
  divided,
}: {
  knowledge: KnowledgeState | null;
  onPress: () => void;
  divided?: boolean;
}) {
  const sources = knowledge?.sources.length ?? 0;
  // Only the ones with a fix: a "not something you offer" row can be dismissed
  // but not answered, so counting it here would promise work that is not there.
  const gaps = knowledge?.gaps.filter((g) => g.kind === 'unanswered').length ?? 0;
  const meta = knowledge
    ? [
        `${sources} source${sources === 1 ? '' : 's'}`,
        gaps > 0 ? `${gaps} question${gaps === 1 ? '' : 's'} to answer` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : 'What your receptionist can answer';
  const preview = knowledge
    ? knowledge.digestPending
      ? 'Summarizing what it learned...'
      : knowledge.digest || 'Nothing yet. Teach it your website or a few notes.'
    : '';

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      // The preview is two clipped lines on screen, but a label would read the
      // whole digest aloud - often a paragraph - before saying what the row does.
      accessibilityLabel={`Knowledge, ${meta}`}
      accessibilityHint="Opens what your receptionist knows"
      android_ripple={ripple}
      style={({ pressed: down }) => [styles.knowRow, divided && styles.divided, down && pressed]}
    >
      <Icon name="sparkles-outline" size={ICON.row} color={colors.textSecondary} style={styles.knowIcon} />
      <View style={styles.flex}>
        <Text style={styles.knowTitle}>Knowledge</Text>
        <Text style={styles.knowMeta}>{meta}</Text>
        {preview ? (
          <Text style={styles.knowPreview} numberOfLines={2}>
            {preview}
          </Text>
        ) : null}
      </View>
      <Icon name="chevron-forward" size={ICON.chevron} color={colors.textMuted} />
    </Pressable>
  );
}

// ── Several receptionists: the list ─────────────────────────────────────────

function AssistantCard({
  assistant,
  onChanged,
  onOpen,
}: {
  assistant: AssistantSummary;
  onChanged: () => Promise<void>;
  onOpen: () => void;
}) {
  const power = usePower(assistant, onChanged);
  const status = statusOf(power.enabled, assistant.number);

  return (
    <Card>
      <View style={styles.cardHead}>
        {/* The switch sits beside this Pressable, not inside it: a Switch
            inside a pressable group is unreachable for VoiceOver. */}
        <Pressable
          onPress={onOpen}
          accessibilityRole="button"
          accessibilityLabel={`${assistant.name}, ${status.text}${assistant.connected ? '' : ', not synced'}`}
          accessibilityHint="Opens its settings"
          android_ripple={ripple}
          style={({ pressed: down }) => [styles.cardMain, down && pressed]}
        >
          <View style={styles.cardIdentity}>
            <AvatarRing size={48} mood={status.live ? 'friendly' : 'greeting'} status={status.ring} />
            <View style={styles.flex}>
              <Text style={styles.cardName} numberOfLines={1}>
                {assistant.name}
              </Text>
              <StatusLine status={status} connected={assistant.connected} />
            </View>
            <Icon name="chevron-forward" size={ICON.chevron} color={colors.textMuted} />
          </View>
          {Boolean(assistant.greeting) && (
            <View style={styles.greeting}>
              <Text style={styles.greetingLabel}>Opening line</Text>
              <Text style={styles.greetingText} numberOfLines={3}>
                &quot;{assistant.greeting}&quot;
              </Text>
            </View>
          )}
        </Pressable>
        <PowerSwitch
          name={assistant.name}
          value={power.enabled}
          busy={power.busy}
          onChange={power.toggle}
        />
      </View>

      {assistant.number ? (
        <NumberLine number={assistant.number} />
      ) : (
        <Text style={styles.warn}>
          No number points at this receptionist, so nothing reaches it yet.
        </Text>
      )}
    </Card>
  );
}

// ── Create ──────────────────────────────────────────────────────────────────

/** A name first, as on the web: "My receptionist" for every new one helped nobody. */
function CreateSheet({
  visible,
  onClose,
  onCreated,
}: {
  visible: boolean;
  onClose: () => void;
  onCreated: (id: string, warning: string | null) => Promise<void>;
}) {
  const [name, setName] = useState('Receptionist');
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<{ ok: boolean; message: string } | null>(null);
  // A ref, not `busy`: return pressed twice in one tick would still read the
  // stale state and send a second POST - a duplicate receptionist.
  const inFlight = useRef(false);

  useEffect(() => {
    if (visible) {
      setName('Receptionist');
      setState(null);
    }
  }, [visible]);

  const trimmed = name.trim();

  async function create() {
    if (!trimmed || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setState(null);
    try {
      const res = await api.createAssistant(trimmed);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await onCreated(res.id, res.warning);
    } catch (err) {
      setState({ ok: false, message: (err as Error).message });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <Sheet
      visible={visible}
      title="New receptionist"
      onClose={onClose}
      footer={
        <SaveBar onSave={create} busy={busy} dirty={trimmed.length > 0} state={state} label="Create" />
      }
    >
      <TextField
        label="Its name"
        value={name}
        onChangeText={setName}
        placeholder="Receptionist"
        maxLength={60}
        returnKeyType="done"
        onSubmitEditing={create}
        error={trimmed ? undefined : 'Give it a name first.'}
        // The same truth the setup funnel tells: the name is a label for you.
        hint="Only you see this name - callers hear your business name. Give it a number next, and it starts taking calls."
      />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.lg, gap: spacing.md },
  emptyContent: { flexGrow: 1 },
  emptyBody: { flex: 1, justifyContent: 'center' },
  flex: { flex: 1 },
  emptyAction: { marginTop: spacing.lg },
  divided: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  hubHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  hubName: { ...type.heading },
  statusLine: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: 2,
  },
  statusText: { ...type.labelLg },
  warn: { ...type.bodySm, marginTop: spacing.lg, color: colors.warningText },
  rowsCard: { paddingVertical: spacing.xs },
  knowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 48,
    paddingVertical: spacing.md,
  },
  knowIcon: { alignSelf: 'flex-start', marginTop: 2 },
  knowTitle: { ...type.body },
  knowMeta: { ...type.caption, marginTop: 2 },
  knowPreview: { ...type.caption, marginTop: 4, color: colors.inkSoft },
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  cardMain: { flex: 1 },
  cardIdentity: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  cardName: { ...type.title },
  greeting: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSubtle,
  },
  // inkSoft on the grey fill: textSecondary there is 4.35:1 and fails.
  greetingLabel: { ...type.micro, color: colors.inkSoft },
  greetingText: { ...type.bodySm, marginTop: 4, color: colors.text },
});
