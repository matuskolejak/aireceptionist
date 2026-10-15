import { useLocalSearchParams, useRouter } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native';

import { SearchField } from '@/components/form';
import { Screen } from '@/components/Screen';
import {
  CallRow,
  Chip,
  EmptyState,
  ErrorState,
  SkeletonRows,
  StaleNotice,
  TextLink,
} from '@/components/ui';
import { colors, spacing, type } from '@/constants/theme';
import { api } from '@/lib/api';
import {
  callerLabel,
  callHeadline,
  dayKey,
  dayLabel,
  statusBucket,
  timeLabel,
  type StatusBucket,
} from '@/lib/format';
import type { CallLog, CallLogRow } from '@/lib/types';
import { useQuery } from '@/lib/use-query';

/** Rows per request. The server's default; it caps at 100. */
const PAGE_SIZE = 50;

/** The web's three status buckets plus All, with the web's words (en.ts status*). */
const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'completed', label: 'Answered' },
  { key: 'unanswered', label: 'Missed' },
  { key: 'active', label: 'In progress' },
] as const;

/**
 * The search box, turned into what the server can match.
 *
 * The server compares the raw text against the stored fields: E.164 numbers and
 * the outcome enum. So "(353) 1 592" has to become "3531592", and "booked an
 * appointment" has to become "booked" - typed as a person would, neither ever
 * matched anything.
 */
function serverQuery(raw: string): string {
  const q = raw.trim();
  if (!q) return '';
  if (/^[\d\s()+.-]+$/.test(q)) {
    const digits = q.replace(/\D/g, '');
    if (!digits) return '';
    return q.startsWith('+') ? `+${digits}` : digits;
  }
  const words = q.toLowerCase();
  if (/appointment|booked/.test(words)) return 'booked';
  if (/message/.test(words)) return 'message';
  if (/transfer|passed/.test(words)) return 'transferred';
  if (/hung up|hangup/.test(words)) return 'abandoned';
  // Word start, so "unanswered" is not read as "answered".
  if (/\banswered/.test(words)) return 'resolved';
  return q;
}

/** A page of the log, tagged with the filter and search it answers. */
type TaggedLog = CallLog & { status: string; q: string };

/** Older pages loaded past the first, for one filter and search. */
interface OlderPages {
  /** `${status}|${q}` - pages from a different filter never mix in. */
  key: string;
  /** Every row loaded so far, page one included, newest first. */
  rows: CallLogRow[];
  nextCursor: string | null;
}

const keyOf = (status: string, q: string) => `${status}|${q}`;

/**
 * Page one, plus the older pages already loaded for the same filter.
 *
 * Page one is refetched on its own (on focus, on a pull), and new calls push
 * it forward. The older rows still line up as long as the refreshed page one
 * reaches back into them; the rows it now covers are taken from it, the rest
 * from what was loaded. If more calls arrived than a page holds there is a
 * hole between the two, and the list falls back to page one alone rather than
 * skip calls silently.
 */
function mergePages(
  data: TaggedLog | null,
  older: OlderPages | null,
): { rows: CallLogRow[]; nextCursor: string | null } {
  if (!data) return { rows: [], nextCursor: null };
  const last = data.rows[data.rows.length - 1];
  if (!older || older.key !== keyOf(data.status, data.q) || !last || !data.nextCursor) {
    return { rows: data.rows, nextCursor: data.nextCursor };
  }
  const lastMs = Date.parse(last.date);
  const newestOlderMs = Date.parse(older.rows[0]?.date ?? '');
  if (!Number.isFinite(lastMs) || !(newestOlderMs >= lastMs)) {
    return { rows: data.rows, nextCursor: data.nextCursor };
  }
  const seen = new Set(data.rows.map((r) => r.key));
  const rest = older.rows.filter((r) => !seen.has(r.key) && Date.parse(r.date) <= lastMs);
  return { rows: [...data.rows, ...rest], nextCursor: older.nextCursor };
}

interface DaySection {
  key: string;
  title: string;
  data: CallLogRow[];
}

/**
 * Rows cut into days - in the OWNER's timezone, the one the web groups by. On
 * the phone's own calendar a call at 00:30 in Dublin sat under "Yesterday" for
 * an owner travelling in New York, beside a web log that said Today.
 * Server order is preserved; this only inserts the breaks.
 */
function groupByDay(rows: CallLogRow[], timezone: string): DaySection[] {
  const out: DaySection[] = [];
  const now = new Date();
  for (const row of rows) {
    const key = dayKey(row.date, timezone) || 'undated';
    const last = out[out.length - 1];
    if (last && last.key === key) {
      last.data.push(row);
    } else {
      out.push({ key, title: dayLabel(row.date, timezone, now) || 'Earlier', data: [row] });
    }
  }
  return out;
}

export default function CallsScreen() {
  const router = useRouter();
  // The Home tab's Missed tile deep-links here with ?status=unanswered.
  const params = useLocalSearchParams<{ status?: string }>();
  // `||` and not `??`: the effect below consumes the deep link by writing an
  // empty status back to the route, so on a remount the param is present but
  // empty, which matches no filter chip and no server-side filter either.
  const [status, setStatus] = useState<string>(params.status || 'all');
  const [q, setQ] = useState('');

  // The tab stays mounted, so useState's initial value only ever reflects the
  // FIRST deep link. Without this, tapping Missed a second time would land on
  // an unfiltered list.
  useEffect(() => {
    if (!params.status) return;
    setStatus(params.status);
    // The param has to be consumed, not just read. Home pushes the same literal
    // `?status=unanswered` every time, so a second tap of the Missed tile leaves
    // `params.status` byte-identical and this effect never re-runs - the user
    // would land on whatever filter they last picked by hand.
    router.setParams({ status: '' });
  }, [params.status, router]);

  // Search runs server-side - it scans deeper there than one page does, so
  // filtering in memory here would silently miss older calls. Debounced
  // because otherwise every keystroke is a request over a cellular connection.
  const [debouncedQ, setDebouncedQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(serverQuery(q)), 300);
    return () => clearTimeout(timer);
  }, [q]);

  const { data, error, loading, refreshing, refresh } = useQuery<TaggedLog>(async () => {
    const page = await api.calls({ status, q: debouncedQ || undefined, limit: PAGE_SIZE });
    // Tagged, because the hook keeps the LAST GOOD payload when a request
    // fails: after a failed filter change `data` is still the old filter's
    // rows, and the screen has to know that to say so.
    return { ...page, status, q: debouncedQ };
  }, [status, debouncedQ]);

  const [older, setOlder] = useState<OlderPages | null>(null);
  const [more, setMore] = useState<{ key: string; busy: boolean; error: string | null } | null>(
    null,
  );

  // A new filter or search starts again from its first page.
  useEffect(() => {
    setOlder(null);
    setMore(null);
  }, [status, debouncedQ]);

  const dataKey = data ? keyOf(data.status, data.q) : '';
  const { rows, nextCursor } = useMemo(() => mergePages(data, older), [data, older]);
  const timezone = data?.timezone ?? '';
  const sections = useMemo(() => groupByDay(rows, timezone), [rows, timezone]);

  const moreState = more && more.key === dataKey ? more : null;

  // Read by `loadMore` at call time: `onEndReached` can fire twice for one
  // scroll, and a second page request for the same cursor would duplicate it.
  const inFlight = useRef<string | null>(null);
  const latestKey = useRef(dataKey);
  latestKey.current = dataKey;

  const loadMore = useCallback(async () => {
    if (!data || !nextCursor || loading) return;
    const key = dataKey;
    const flightId = `${key}@${nextCursor}`;
    if (inFlight.current === flightId) return;
    inFlight.current = flightId;
    setMore({ key, busy: true, error: null });
    try {
      const page = await api.calls({
        status: data.status,
        q: data.q || undefined,
        before: nextCursor,
        limit: PAGE_SIZE,
      });
      // A filter change while this was in flight: its rows belong to nobody.
      if (latestKey.current !== key) return;
      const seen = new Set(rows.map((r) => r.key));
      setOlder({
        key,
        rows: [...rows, ...page.rows.filter((r) => !seen.has(r.key))],
        nextCursor: page.nextCursor,
      });
      setMore(null);
    } catch (err) {
      if (latestKey.current !== key) return;
      setMore({
        key,
        busy: false,
        error: err instanceof Error ? err.message : 'Could not load more calls.',
      });
    } finally {
      if (inFlight.current === flightId) inFlight.current = null;
    }
  }, [data, dataKey, loading, nextCursor, rows]);

  // `useQuery` raises `loading` again whenever its deps change - every filter
  // tap and every settled keystroke. Only the very first load takes the whole
  // view; after that the previous rows stay put and a spinner in the search
  // field says a query is in flight.
  const firstLoad = loading && !data;
  const querying = loading && Boolean(data);

  // The chip that is lit is the one the ROWS belong to, except while a new
  // filter loads, when it is the one just tapped. After a failed filter change
  // the rows are still the previous filter's, so that chip stays lit too.
  const shownStatus = loading || !data ? status : data.status;
  const mismatched = Boolean(data) && (data?.status !== status || data?.q !== debouncedQ);
  const staleMessage =
    !data || loading || !error
      ? null
      : data.status !== status
        ? 'Could not apply the filter.'
        : data.q !== debouncedQ
          ? 'Could not run the search.'
          : error;

  const pickFilter = useCallback(
    (key: string) => {
      // Tapping the chip that failed to apply retries it rather than doing
      // nothing because the state already says that filter.
      if (key === status) {
        if (mismatched) void refresh();
        return;
      }
      setStatus(key);
    },
    [mismatched, refresh, status],
  );

  const open = useCallback((id: string) => router.push(`/call/${id}`), [router]);

  const renderRow = useCallback(
    ({ item, section }: { item: CallLogRow; section: DaySection }) => (
      <LogRow row={item} timezone={timezone} day={section.title} onOpen={open} />
    ),
    [open, timezone],
  );

  const filtered = Boolean(data && (data.status !== 'all' || data.q));

  return (
    <Screen title="Calls" scroll={false}>
      <View style={styles.controls}>
        <SearchField
          value={q}
          onChangeText={setQ}
          placeholder="Search by number or outcome"
          accessibilityLabel="Search calls by number or outcome"
          busy={querying}
        />
        <View style={styles.filters}>
          {FILTERS.map((f) => (
            <Chip
              key={f.key}
              label={f.label}
              selected={shownStatus === f.key}
              onPress={() => pickFilter(f.key)}
            />
          ))}
        </View>
      </View>

      {staleMessage ? <StaleNotice message={staleMessage} onRetry={refresh} /> : null}

      {firstLoad ? (
        <View style={styles.list}>
          <SkeletonRows count={8} height={56} />
        </View>
      ) : !data ? (
        <ErrorState message={error ?? 'Could not load your calls.'} onRetry={refresh} />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(r) => r.key}
          renderItem={renderRow}
          stickySectionHeadersEnabled
          renderSectionHeader={({ section }) => (
            <View style={styles.sectionHead}>
              <Text
                style={styles.sectionTitle}
                accessibilityRole="header"
                // The eyebrow style upper-cases it; spoken, "SEP" is spelled out.
                accessibilityLabel={section.title}
              >
                {section.title}
              </Text>
            </View>
          )}
          contentContainerStyle={rows.length === 0 ? styles.emptyWrap : styles.list}
          onEndReached={() => {
            // An error waits for its Retry: re-firing on every scroll to the
            // bottom would hammer a network that just failed.
            if (!moreState?.error) void loadMore();
          }}
          onEndReachedThreshold={0.5}
          ListFooterComponent={
            rows.length === 0 ? null : (
              <ListFooter
                busy={Boolean(moreState?.busy)}
                error={moreState?.error ?? null}
                done={nextCursor === null}
                onRetry={() => void loadMore()}
              />
            )
          }
          // The search field sits directly above this list, so without these a
          // tap on a row while the keyboard is up is swallowed by the dismiss
          // and the user has to tap the same row twice.
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={refresh}
              tintColor={colors.textSecondary}
              colors={[colors.ink]}
            />
          }
          ListEmptyComponent={
            filtered ? (
              <EmptyState
                icon="search"
                title="No matching calls"
                body="Try a different filter or search."
              />
            ) : (
              <EmptyState
                mood="greeting"
                title="No calls yet"
                body="Calls appear here as soon as your receptionist answers one."
              />
            )
          }
        />
      )}
    </Screen>
  );
}

function ListFooter({
  busy,
  error,
  done,
  onRetry,
}: {
  busy: boolean;
  error: string | null;
  done: boolean;
  onRetry: () => void;
}) {
  if (busy) {
    return (
      <View style={styles.footer}>
        <ActivityIndicator color={colors.textSecondary} accessibilityLabel="Loading more calls" />
      </View>
    );
  }
  if (error) {
    return (
      <View style={[styles.footer, styles.footerRow]} accessibilityLiveRegion="polite">
        <Text style={styles.footerText}>Could not load more calls.</Text>
        <TextLink label="Retry" accessibilityLabel="Retry loading more calls" onPress={onRetry} />
      </View>
    );
  }
  if (done) {
    return (
      <View style={styles.footer}>
        <Text style={styles.footerText}>That&apos;s every call</Text>
      </View>
    );
  }
  return null;
}

/** One log row, mapped onto the shared CallRow. Memoised: the list is long and refetches often. */
const LogRow = memo(function LogRow({
  row,
  timezone,
  day,
  onOpen,
}: {
  row: CallLogRow;
  timezone: string;
  /** The section heading this row sits under, for the spoken label. */
  day: string;
  onOpen: (id: string) => void;
}) {
  // Only DB-backed calls have a detail page. A Twilio-only row (a call that
  // never reached the agent) has no transcript to open, so it does not pretend
  // to be tappable.
  const openable = Boolean(row.dbId);

  // The bucket decides the look, never the carrier's raw status words ("No
  // Answer", "Busy") - the web shows three states and so does this. A row
  // still "in progress" hours later lost its end webhook and reads as missed.
  const bucket: StatusBucket = statusBucket(row.status, row.date);
  const headline =
    bucket === 'unanswered'
      ? 'Missed call'
      : bucket === 'active'
        ? 'In progress'
        : callHeadline({ outcome: row.outcome, status: row.status, date: row.date });
  const caller = callerLabel(row.from);
  const time = timeLabel(row.date, timezone) || row.dateLabel;

  return (
    <CallRow
      headline={headline}
      caller={caller}
      meta={row.durationLabel}
      when={time}
      bucket={bucket}
      outcome={row.outcome}
      flagged={row.needsReview}
      divided
      onPress={openable ? () => onOpen(row.dbId as string) : undefined}
      // One sentence from exactly what is on screen. Without it VoiceOver reads
      // four fragments and the number digit by digit.
      accessibilityLabel={`${headline}. ${caller}, ${row.durationLabel}, ${day} ${time}${
        row.needsReview ? ', flagged for review' : ''
      }`}
    />
  );
});

const styles = StyleSheet.create({
  controls: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    gap: spacing.md,
  },
  filters: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  list: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  // Sticky, so the day a row belongs to is still on screen after scrolling
  // past its heading. Opaque for the same reason - rows slide under it.
  sectionHead: {
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
    backgroundColor: colors.background,
  },
  sectionTitle: {
    ...type.eyebrow,
  },
  emptyWrap: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  footer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xl,
  },
  footerRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  footerText: {
    ...type.caption,
  },
});
