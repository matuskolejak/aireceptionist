import { Tabs } from 'expo-router';
import { Platform, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, type IconName } from '@/components/Icon';
import { colors, fonts } from '@/constants/theme';

/**
 * Five destinations, in the web sidebar's order and wording: Home,
 * Calls, Appointments, Receptionist, Settings.
 *
 * Five is the most a phone tab bar holds (HIG, Material 3). The web's sixth,
 * Knowledge, lives under Receptionist here - the hub's "What it knows" row
 * opens it - and everything else (connected calendars, the profile form,
 * alerts) sits one level down rather than as another tab.
 *
 * The active tab swaps to the filled glyph, the phone's version of the web
 * sidebar's dark pill for the current page.
 */

const TABS: { name: string; title: string; icon: IconName; iconFocused: IconName }[] = [
  { name: 'index', title: 'Home', icon: 'grid-outline', iconFocused: 'grid' },
  { name: 'calls', title: 'Calls', icon: 'call-outline', iconFocused: 'call' },
  { name: 'calendar', title: 'Appointments', icon: 'calendar-outline', iconFocused: 'calendar' },
  // The web's Bot glyph has no Ionicons twin; a headset is the receptionist.
  { name: 'assistant', title: 'Receptionist', icon: 'headset-outline', iconFocused: 'headset' },
  { name: 'settings', title: 'Settings', icon: 'settings-outline', iconFocused: 'settings' },
];

/**
 * Labels grow with the text size, but only this far: the bar has a fixed
 * height, and "Appointments" is the longest word it has to fit five across.
 * iOS also offers the Large Content Viewer on a long press, which shows the
 * full-size label at any setting.
 */
const MAX_LABEL_SCALE = 1.3;

export default function TabLayout() {
  const insets = useSafeAreaInsets();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.ink,
        tabBarInactiveTintColor: colors.textSecondary,
        tabBarAllowFontScaling: true,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          borderTopWidth: StyleSheet.hairlineWidth,
          height: 58 + insets.bottom,
          paddingBottom: insets.bottom + 4,
          paddingTop: 6,
        },
      }}
    >
      {TABS.map((tab, i) => (
        <Tabs.Screen
          key={tab.name}
          name={tab.name}
          options={{
            title: tab.title,
            // A function label, so the cap above can be set on the Text - the
            // bar's own label takes no maxFontSizeMultiplier.
            tabBarLabel: ({ color, children }) => (
              <Text
                style={[styles.label, { color }]}
                numberOfLines={1}
                allowFontScaling
                maxFontSizeMultiplier={MAX_LABEL_SCALE}
              >
                {children}
              </Text>
            ),
            // A function label makes the bar drop its own iOS label, and the
            // button would then read its children. Spelled out the way the
            // bar words it for a string label.
            tabBarAccessibilityLabel:
              Platform.OS === 'ios' ? `${tab.title}, tab, ${i + 1} of ${TABS.length}` : undefined,
            tabBarIcon: ({ color, focused }) => (
              <Icon name={focused ? tab.iconFocused : tab.icon} size={22} color={color} />
            ),
          }}
        />
      ))}
    </Tabs>
  );
}

const styles = StyleSheet.create({
  label: {
    fontFamily: fonts.medium,
    fontSize: 11,
    lineHeight: 14,
    textAlign: 'center',
    marginTop: 2,
  },
});
