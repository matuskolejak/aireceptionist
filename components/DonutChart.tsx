import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, G } from 'react-native-svg';

import { colors, fonts, MAX_FONT_SCALE, radius, spacing, type } from '@/constants/theme';
import type { Segment } from '@/lib/types';

/**
 * The sentiment split, drawn the same way the web draws it.
 *
 * Ported arc-for-arc from `app/(main)/dashboard/components/DonutChart.tsx`: one
 * circle per segment, `strokeDasharray` sized to its share of the total and
 * `strokeDashoffset` walking the running sum, on a -90deg rotation so the first
 * slice starts at twelve o'clock. Matching the construction rather than
 * re-deriving it is what keeps the same account's donut looking identical on
 * both surfaces.
 *
 * This is the one chart worth a native module. `BarChart` deliberately avoids
 * react-native-svg because bars are rectangles and Views draw rectangles; arcs
 * are not, and faking them with rotated half-circles falls apart past two
 * segments - sentiment has five.
 */

/** Same geometry as the web's viewBox: r chosen so the circumference is 100. */
const SIZE = 36;
const RADIUS = 15.915;
const STROKE = 3.5;

export function DonutChart({
  segments,
  centerLabel,
  centerSub,
}: {
  segments: Segment[];
  centerLabel: string;
  centerSub: string;
}) {
  const total = segments.reduce((sum, s) => sum + s.value, 0) || 1;

  // Running-sum offsets computed up front, so nothing is reassigned mid-render.
  const arcs: { seg: Segment; dash: number; offset: number }[] = [];
  let acc = 0;
  for (const s of segments) {
    const dash = (s.value / total) * 100;
    arcs.push({ seg: s, dash, offset: acc });
    acc += dash;
  }

  // The arcs are unlabelled SVG, so the whole chart is one element that reads
  // the legend out: "Positive 62%, Neutral 30%, Negative 8%".
  const summary = segments.length
    ? segments.map((s) => `${s.label} ${s.value}%`).join(', ')
    : 'No data yet';

  return (
    <View
      style={styles.root}
      accessible
      accessibilityRole="image"
      accessibilityLabel={summary}
    >
      <View style={styles.ring}>
        <Svg width={128} height={128} viewBox={`0 0 ${SIZE} ${SIZE}`}>
          {/* -90deg about the centre. RN-SVG has no CSS transform, so the
              rotation is an SVG one on a wrapping group. */}
          <G rotation={-90} origin={`${SIZE / 2}, ${SIZE / 2}`}>
            <Circle
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={RADIUS}
              fill="none"
              stroke={colors.surfaceSubtle}
              strokeWidth={STROKE}
            />
            {arcs.map(({ seg, dash, offset }) => (
              <Circle
                key={seg.key ?? seg.label}
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={RADIUS}
                fill="none"
                stroke={seg.color}
                strokeWidth={STROKE}
                strokeDasharray={`${dash} ${100 - dash}`}
                strokeDashoffset={-offset}
              />
            ))}
          </G>
        </Svg>
        <View style={styles.center} pointerEvents="none">
          {/* Capped: the ring is a fixed 128pt and the centre has to fit in it. */}
          <Text style={styles.centerLabel} maxFontSizeMultiplier={MAX_FONT_SCALE}>
            {centerLabel}
          </Text>
          <Text style={styles.centerSub} maxFontSizeMultiplier={MAX_FONT_SCALE}>
            {centerSub}
          </Text>
        </View>
      </View>

      <View style={styles.legend}>
        {segments.map((s) => (
          <View key={s.key ?? s.label} style={styles.legendRow}>
            <View style={styles.legendLeft}>
              <View style={[styles.swatch, { backgroundColor: s.color }]} />
              <Text style={styles.legendLabel} numberOfLines={1}>
                {s.label}
              </Text>
            </View>
            <Text style={styles.legendValue}>{s.value}%</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flexDirection: 'row', alignItems: 'center', gap: spacing.xl },
  ring: { width: 128, height: 128, alignItems: 'center', justifyContent: 'center' },
  center: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerLabel: { ...type.heading, fontFamily: fonts.medium },
  centerSub: { ...type.caption },
  legend: { flex: 1, gap: spacing.md },
  legendRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  legendLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flex: 1 },
  swatch: { width: 10, height: 10, borderRadius: radius.pill },
  legendLabel: { ...type.bodySm, color: colors.textSecondary, flexShrink: 1 },
  legendValue: { ...type.bodySm, fontFamily: fonts.medium, fontVariant: ['tabular-nums'] },
});
