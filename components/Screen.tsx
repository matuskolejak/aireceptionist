import type { ReactNode } from 'react';
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, spacing, type } from '@/constants/theme';

/**
 * The shell every tab sits in: safe-area padding, the page title (the web's
 * PageHeader h1: 24/600, tight tracking), and pull to refresh, on the web's
 * `.dash-bg` page colour.
 *
 * `header` replaces the default title block when a screen has its own (Home's
 * brand header). `scroll={false}` hands the scrolling to a child list instead -
 * a FlatList inside a ScrollView renders every row and loses virtualization,
 * which the Calls tab (up to 100 rows) would feel.
 */
export function Screen({
  title,
  subtitle,
  right,
  header,
  children,
  onRefresh,
  refreshing,
  scroll = true,
  contentStyle,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  header?: ReactNode;
  children: ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
  scroll?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  const insets = useSafeAreaInsets();

  const head = header ?? (
    <View style={styles.header}>
      <View style={styles.headerText}>
        <Text style={type.display} accessibilityRole="header">
          {title}
        </Text>
        {subtitle ? (
          // Two lines: "Times in America/New York (this phone)" wraps at larger text sizes.
          <Text style={styles.subtitle} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
    </View>
  );

  if (!scroll) {
    return (
      <View style={[styles.root, { paddingTop: insets.top }, contentStyle]}>
        {head}
        {children}
      </View>
    );
  }

  return (
    <ScrollView
      style={[styles.root, { paddingTop: insets.top }]}
      contentContainerStyle={[styles.content, contentStyle]}
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={Boolean(refreshing)}
            onRefresh={onRefresh}
            tintColor={colors.textSecondary}
            colors={[colors.ink]}
          />
        ) : undefined
      }
    >
      {head}
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    paddingBottom: spacing.xxl,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  headerText: {
    flex: 1,
  },
  subtitle: {
    ...type.caption,
    marginTop: 2,
  },
});
