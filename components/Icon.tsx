import { Ionicons } from '@expo/vector-icons';
import type { StyleProp, TextStyle } from 'react-native';

import { colors, MAX_FONT_SCALE } from '@/constants/theme';

export type IconName = keyof typeof Ionicons.glyphMap;

/**
 * Every icon in the app goes through this.
 *
 * An Ionicon is a `<Text>` holding a private-use glyph, and nothing in
 * @expo/vector-icons hides it from assistive tech. VoiceOver then reads the
 * glyph as a stray character, and worse, iOS builds a pressable's label by
 * joining its children's labels - so a button with an icon announced
 * ", Get a number". Without `label` an icon is decorative and hidden on both
 * platforms (`accessibilityElementsHidden` is iOS, `importantForAccessibility`
 * is Android). Hiding is not enough on its own for a pressable: the container
 * still needs its own `accessibilityLabel`, which the primitives set.
 *
 * With `label` the icon stands alone as an image (an icon-only status, say).
 */
export function Icon({
  name,
  size = 18,
  color = colors.textSecondary,
  style,
  label,
}: {
  name: IconName;
  size?: number;
  color?: string;
  style?: StyleProp<TextStyle>;
  label?: string;
}) {
  if (label) {
    return (
      <Ionicons
        name={name}
        size={size}
        color={color}
        style={style}
        maxFontSizeMultiplier={MAX_FONT_SCALE}
        accessible
        accessibilityRole="image"
        accessibilityLabel={label}
      />
    );
  }
  return (
    <Ionicons
      name={name}
      size={size}
      color={color}
      style={style}
      maxFontSizeMultiplier={MAX_FONT_SCALE}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
}
