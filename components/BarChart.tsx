import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View, type GestureResponderEvent } from 'react-native';

import { colors, fonts, MAX_FONT_SCALE, shadow, spacing, type } from '@/constants/theme';
import type { Bar } from '@/lib/types';

/**
 * Call volume, drawn with plain Views.
 *
 * These are rectangles; pulling in react-native-svg to draw rectangles would
 * add work for no gain. Every bar is scaled against the tallest one, and an
 * all-zero series renders flat rather than dividing by zero.
 *
 * Matches the web's BarChart: the last bar (today) is ink and the rest a light
 * grey, so "today" reads at a glance. The web shows a count on hover; a phone
 * has no hover, so a tap or a sideways drag across the plot picks a bar and a
 * small callout above it says the day and the count.
 *
 * The chart sits in a scrolling page, so a touch commits nothing until it is
 * clearly a tap (released without travelling) or a scrub (travelled sideways).
 * A vertical drag belongs to the page: the ScrollView cancels the touch and
 * the selection is left as it was.
 */

// Keep a visible stub for a zero bar so the axis reads as a row of days rather
// than as gaps where data is missing.
const MIN_BAR = 3;
const GAP = 4;
const LABEL_WIDTH = 32;
// Wide enough for "Wed 28 \u00B7 12 calls" at the largest capped text size.
const CALLOUT_WIDTH = 160;
/** Label every 5th bar, counted back from today so today is always labelled. */
const LABEL_EVERY = 5;
/** Travel (pt) before a touch stops being a tap and picks a direction. */
const SLOP = 8;

function callsText(n: number): string {
  return `${n} ${n === 1 ? 'call' : 'calls'}`;
}

export function BarChart({ data, height = 120 }: { data: Bar[]; height?: number }) {
  const [width, setWidth] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  // One touch on the plot. `mode` starts 'pending' and becomes 'scrub' on a
  // sideways drag or 'none' on a vertical one; `prev` is what to put back if
  // the page takes the touch away mid-scrub.
  const touch = useRef<{
    x: number;
    y: number;
    start: number | null;
    prev: number | null;
    mode: 'pending' | 'scrub' | 'none';
  }>({ x: 0, y: 0, start: null, prev: null, mode: 'none' });

  // A different series (the range switch) invalidates the picked index. Keyed
  // on the shape rather than the array, so a background refetch of the same
  // days does not drop what the owner is reading.
  const seriesKey = `${data.length}:${data[0]?.label ?? ''}`;
  useEffect(() => {
    setSelected(null);
  }, [seriesKey]);

  if (data.length === 0) {
    return <Text style={styles.empty}>No calls yet.</Text>;
  }

  const n = data.length;
  const max = Math.max(...data.map((d) => d.value), 0);
  const total = data.reduce((sum, d) => sum + d.value, 0);
  // `max` is clamped to 0 above, so an all-zero series would otherwise
  // announce a peak on whichever day happened to come first.
  const peak = total > 0 ? data.find((d) => d.value === max) : undefined;
  const summary = peak
    ? `Calls per day, last ${n} days, total ${total}, busiest day ${peak.label} with ${max}.`
    : `Calls per day, last ${n} days, no calls in this period.`;

  const col = width > 0 ? (width - GAP * (n - 1)) / n : 0;
  const centerOf = (i: number) => i * (col + GAP) + col / 2;
  const indexAt = (x: number) =>
    width > 0 ? Math.max(0, Math.min(n - 1, Math.floor((x / width) * n))) : null;

  const pick = (i: number | null) => {
    if (i === null || i === selected) return;
    setSelected(i);
    void Haptics.selectionAsync().catch(() => {});
  };

  const onGrant = (e: GestureResponderEvent) => {
    const { pageX, pageY, locationX } = e.nativeEvent;
    touch.current = {
      x: pageX,
      y: pageY,
      start: indexAt(locationX),
      prev: selected,
      mode: 'pending',
    };
  };
  const onMove = (e: GestureResponderEvent) => {
    const t = touch.current;
    if (t.mode === 'none') return;
    if (t.mode === 'pending') {
      const dx = Math.abs(e.nativeEvent.pageX - t.x);
      const dy = Math.abs(e.nativeEvent.pageY - t.y);
      if (dx < SLOP && dy < SLOP) return;
      t.mode = dx > dy ? 'scrub' : 'none';
      if (t.mode === 'none') return;
    }
    pick(indexAt(e.nativeEvent.locationX));
  };
  const onRelease = () => {
    const t = touch.current;
    if (t.mode !== 'pending') return;
    // A tap: pick the bar, or clear it when it was already the picked one.
    if (t.start !== null && t.start === selected) setSelected(null);
    else pick(t.start);
  };
  const onTerminate = () => {
    if (touch.current.mode === 'scrub') setSelected(touch.current.prev);
    touch.current.mode = 'none';
  };

  const active = selected ?? n - 1;
  const calloutLeft =
    selected === null
      ? 0
      : Math.max(0, Math.min(width - CALLOUT_WIDTH, centerOf(selected) - CALLOUT_WIDTH / 2));

  return (
    <View accessible accessibilityRole="image" accessibilityLabel={summary}>
      {/* A row reserved for the callout, so it never covers the tallest bar.
          The invisible sizer gives it the callout's height at any text size. */}
      <View style={styles.calloutRow}>
        <View style={styles.calloutSizer}>
          <Text style={styles.calloutText} maxFontSizeMultiplier={MAX_FONT_SCALE}>
            {' '}
          </Text>
        </View>
        {selected !== null && width > 0 ? (
          <View style={[styles.calloutBox, { left: calloutLeft }]}>
            <View style={styles.callout}>
              <Text style={styles.calloutText} numberOfLines={1} maxFontSizeMultiplier={MAX_FONT_SCALE}>
                {`${data[selected].label} \u00B7 ${callsText(data[selected].value)}`}
              </Text>
            </View>
          </View>
        ) : null}
      </View>

      <View
        style={[styles.plot, { height }]}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={onGrant}
        onResponderMove={onMove}
        onResponderRelease={onRelease}
        onResponderTerminate={onTerminate}
        // Another JS responder may not take over a scrub in progress.
        onResponderTerminationRequest={() => touch.current.mode !== 'scrub'}
      >
        {/* No touch targets inside, so every `locationX` above is relative to
            the plot itself rather than to whichever bar was under the finger. */}
        {data.map((d, i) => (
          <View key={`${d.label}-${i}`} style={styles.column} pointerEvents="none">
            <View
              style={[
                styles.bar,
                {
                  height: max > 0 ? Math.max(MIN_BAR, (d.value / max) * height) : MIN_BAR,
                  backgroundColor:
                    d.value === 0
                      ? colors.border
                      : i === active
                        ? colors.ink
                        : colors.borderStrong,
                },
              ]}
            />
          </View>
        ))}
      </View>

      <View style={styles.axis}>
        {/* Sizes the row to the labels' scaled line height; they are absolute. */}
        <Text style={[styles.axisLabel, styles.axisSizer]} maxFontSizeMultiplier={MAX_FONT_SCALE}>
          {' '}
        </Text>
        {width > 0 &&
          data.map((d, i) =>
            (n - 1 - i) % LABEL_EVERY === 0 ? (
              <Text
                key={`${d.label}-label-${i}`}
                style={[
                  styles.axisLabel,
                  {
                    left: Math.max(0, Math.min(width - LABEL_WIDTH, centerOf(i) - LABEL_WIDTH / 2)),
                  },
                  i === n - 1 && styles.axisLabelToday,
                ]}
                numberOfLines={1}
                maxFontSizeMultiplier={MAX_FONT_SCALE}
              >
                {d.label}
              </Text>
            ) : null,
          )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  calloutRow: {
    marginBottom: spacing.xs,
  },
  calloutSizer: {
    paddingVertical: 4,
    opacity: 0,
  },
  calloutBox: {
    position: 'absolute',
    top: 0,
    width: CALLOUT_WIDTH,
    alignItems: 'center',
  },
  callout: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: colors.ink,
    ...shadow.pop,
  },
  calloutText: {
    ...type.caption,
    fontFamily: fonts.medium,
    color: colors.white,
    fontVariant: ['tabular-nums'],
  },
  plot: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: GAP,
  },
  column: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  bar: {
    width: '100%',
    maxWidth: 16,
    borderRadius: 4,
    minHeight: MIN_BAR,
  },
  axis: {
    marginTop: spacing.sm,
  },
  axisSizer: {
    position: 'relative',
    opacity: 0,
  },
  axisLabel: {
    position: 'absolute',
    top: 0,
    width: LABEL_WIDTH,
    fontFamily: fonts.regular,
    fontSize: 11,
    lineHeight: 14,
    color: colors.textSecondary,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  axisLabelToday: {
    fontFamily: fonts.semibold,
    color: colors.text,
  },
  empty: {
    ...type.bodySm,
    color: colors.textSecondary,
  },
});
