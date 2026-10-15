import { useEffect, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type KeyboardTypeOptions,
  type ReturnKeyTypeOptions,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, type IconName } from '@/components/Icon';
import { Button, Chip, ICON, IconButton, pressed, ripple } from '@/components/ui';
import { colors, control, MAX_FONT_SCALE, radius, spacing, type } from '@/constants/theme';

/**
 * The editing primitives. The dashboard's forms are Tailwind classes on native
 * inputs; these are their phone equivalents, kept in one file so a screen never
 * hand-rolls a field and drifts from the rest.
 */

/**
 * The one text input surface, for the rare field that cannot be a `TextField`
 * (an unlabelled answer box). `type.body` without its lineHeight: on iOS a
 * lineHeight on a single-line TextInput pushes the text off centre.
 */
export const inputStyle = {
  minHeight: 48,
  borderRadius: radius.md,
  borderWidth: 1,
  borderColor: colors.borderStrong,
  backgroundColor: colors.surface,
  paddingHorizontal: spacing.md,
  paddingVertical: spacing.sm + 2,
  fontFamily: type.body.fontFamily,
  fontSize: type.body.fontSize,
  color: colors.text,
} as const;

/** The funnel's larger field: the same surface, a 54pt box and 17pt type. */
export const inputStyleLg = {
  ...inputStyle,
  minHeight: 54,
  paddingHorizontal: spacing.lg,
  paddingVertical: spacing.md,
  fontSize: 17,
} as const;

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
      {error ? (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : hint ? (
        <Text style={styles.hint}>{hint}</Text>
      ) : null}
    </View>
  );
}

export function TextField({
  label,
  value,
  onChangeText,
  placeholder,
  hint,
  error,
  multiline,
  keyboardType,
  autoCapitalize = 'sentences',
  editable = true,
  maxLength,
  onSubmitEditing,
  returnKeyType,
  autoComplete,
  textContentType,
  secureTextEntry,
  size = 'md',
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  hint?: string;
  error?: string;
  multiline?: boolean;
  keyboardType?: KeyboardTypeOptions;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  editable?: boolean;
  maxLength?: number;
  onSubmitEditing?: () => void;
  returnKeyType?: ReturnKeyTypeOptions;
  autoComplete?: TextInputProps['autoComplete'];
  textContentType?: TextInputProps['textContentType'];
  secureTextEntry?: boolean;
  /** `lg` is the funnel's field: taller, 17pt. */
  size?: 'md' | 'lg';
}) {
  const [focused, setFocused] = useState(false);
  return (
    <Field label={label} hint={hint} error={error}>
      <TextInput
        style={[
          size === 'lg' ? styles.inputLg : styles.input,
          multiline && styles.inputMultiline,
          focused && styles.inputFocused,
          error ? styles.inputError : null,
          !editable && styles.inputOff,
        ]}
        value={value}
        onChangeText={onChangeText}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        multiline={multiline}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCapitalize !== 'none'}
        editable={editable}
        maxLength={maxLength}
        onSubmitEditing={onSubmitEditing}
        returnKeyType={returnKeyType}
        autoComplete={autoComplete}
        textContentType={textContentType}
        secureTextEntry={secureTextEntry}
        textAlignVertical={multiline ? 'top' : 'center'}
        maxFontSizeMultiplier={MAX_FONT_SCALE}
        // The visible label is a sibling Text, which VoiceOver never ties to
        // the input - without this the field announces only its placeholder.
        accessibilityLabel={label}
        accessibilityHint={error ?? hint}
      />
    </Field>
  );
}

/**
 * A search box: the Calls filter, the country picker, the list pickers. Its
 * own clear button on both platforms (`clearButtonMode` is iOS-only), and a
 * spinner while a query is in flight.
 */
export function SearchField({
  value,
  onChangeText,
  placeholder = 'Search',
  accessibilityLabel,
  busy,
  autoFocus,
  style,
}: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  accessibilityLabel: string;
  busy?: boolean;
  autoFocus?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.search, style]}>
      <Icon name="search" size={ICON.chevron} color={colors.textSecondary} />
      <TextInput
        style={styles.searchInput}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus={autoFocus}
        returnKeyType="search"
        maxFontSizeMultiplier={MAX_FONT_SCALE}
        accessibilityLabel={accessibilityLabel}
      />
      {busy ? (
        <ActivityIndicator size="small" color={colors.textSecondary} accessibilityLabel="Searching" />
      ) : value.length > 0 ? (
        <Pressable
          onPress={() => onChangeText('')}
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          hitSlop={12}
          style={({ pressed: down }) => down && pressed}
        >
          <Icon name="close-circle" size={ICON.row} color={colors.textSecondary} />
        </Pressable>
      ) : null}
    </View>
  );
}

export function SwitchRow({
  title,
  body,
  value,
  onValueChange,
  disabled,
}: {
  title: string;
  body?: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.switchRow}>
      <View style={styles.flex}>
        <Text style={styles.switchTitle}>{title}</Text>
        {body ? <Text style={styles.switchBody}>{body}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        // A Switch is focused on its own by VoiceOver, and React Native never
        // associates it with sibling text - without this the Alerts screen is
        // three consecutive controls that all announce a bare "on, switch".
        accessibilityLabel={title}
        accessibilityHint={body}
        trackColor={{ true: colors.ink, false: colors.borderStrong }}
        thumbColor={colors.white}
        ios_backgroundColor={colors.borderStrong}
      />
    </View>
  );
}

export interface Option {
  value: string;
  label: string;
  hint?: string;
}

/**
 * A tap-to-open list picker.
 *
 * Not a native `<Picker>`: the timezone list is ~400 entries, the language list
 * ~40, and an iOS wheel with that many rows is unusable. A searchable sheet
 * handles both sizes with one component.
 */
export function SelectRow({
  label,
  value,
  options,
  onChange,
  placeholder = 'Choose',
  searchable,
  disabled,
}: {
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  placeholder?: string;
  searchable?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const insets = useSafeAreaInsets();
  // iOS shows the picker as a page sheet: it sits below the status bar on its
  // own, and swiping it down is a fine way to cancel a pick (nothing is lost).
  const pageSheet = Platform.OS === 'ios';

  const selected = options.find((o) => o.value === value);
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? options.filter((o) => o.label.toLowerCase().includes(needle))
    : options;

  const close = () => {
    setQ('');
    setOpen(false);
  };

  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <Pressable
        onPress={() => !disabled && setOpen(true)}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${selected?.label ?? placeholder}`}
        accessibilityState={{ disabled: Boolean(disabled) }}
        style={({ pressed: down }) => [
          styles.input,
          styles.selectRow,
          disabled && styles.inputOff,
          down && !disabled && pressed,
        ]}
      >
        <Text
          style={[styles.selectValue, !selected && { color: colors.textMuted }]}
          numberOfLines={1}
          maxFontSizeMultiplier={MAX_FONT_SCALE}
        >
          {selected?.label ?? placeholder}
        </Text>
        <Icon name="chevron-down" size={16} color={colors.textSecondary} />
      </Pressable>

      <Modal
        visible={open}
        animationType="slide"
        presentationStyle={pageSheet ? 'pageSheet' : undefined}
        // Android: with edge-to-edge on, draw under both system bars so the
        // root insets below are the ones that apply (no double top inset).
        statusBarTranslucent
        navigationBarTranslucent
        onRequestClose={close}
      >
        <View style={styles.sheet} accessibilityViewIsModal>
          {/* The status-bar inset is padded INSIDE the white head, so the band
              above the title is surface rather than a strip of page grey. */}
          <View style={[styles.sheetHead, { paddingTop: pageSheet ? spacing.md : insets.top + spacing.sm }]}>
            <Text style={styles.sheetTitle} accessibilityRole="header">
              {label}
            </Text>
            <IconButton icon="close" label="Close" tone="plain" onPress={close} style={styles.sheetClose} />
          </View>
          {searchable && (
            <SearchField
              value={q}
              onChangeText={setQ}
              accessibilityLabel={`Search ${label}`}
              style={styles.pickerSearch}
            />
          )}
          <ScrollView
            contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xxl }}
            // The search field above keeps the keyboard up while the list is
            // being scanned, and without this the tap that picks an option only
            // dismisses the keyboard - the voice picker is the one people hit.
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
          >
            {shown.map((o) => {
              const isSelected = o.value === value;
              return (
                <Pressable
                  key={o.value}
                  onPress={() => {
                    onChange(o.value);
                    close();
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={o.label}
                  accessibilityHint={o.hint}
                  accessibilityState={{ selected: isSelected }}
                  android_ripple={ripple}
                  style={({ pressed: down }) => [styles.optionRow, down && pressed]}
                >
                  <View style={styles.flex}>
                    <Text style={styles.optionLabel}>{o.label}</Text>
                    {o.hint ? <Text style={styles.optionHint}>{o.hint}</Text> : null}
                  </View>
                  {isSelected && <Icon name="checkmark" size={18} color={colors.ink} />}
                </Pressable>
              );
            })}
            {/* An empty list with an empty search box is not a failed search:
                it is a catalog that has not arrived yet, or one whose request
                failed. Sharing one string with the no-match case renders a
                literal `Nothing matches ""` with empty quotes. */}
            {shown.length === 0 && (
              <Text style={styles.noMatch}>
                {needle ? `Nothing matches "${q}".` : 'Nothing to choose from yet.'}
              </Text>
            )}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

/** Horizontal single-choice chips, for short option sets. */
export function ChipGroup({
  label,
  value,
  options,
  onChange,
}: {
  label?: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
}) {
  return (
    <View style={label ? styles.field : undefined}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <View style={styles.chips}>
        {options.map((o) => (
          <Chip
            key={o.value}
            label={o.label}
            selected={o.value === value}
            onPress={() => onChange(o.value)}
          />
        ))}
      </View>
    </View>
  );
}

/**
 * A stepped numeric control. RN ships no Slider in core, and the two values that
 * need one (speed, stability) have five useful stops each - so this is a row of
 * stops rather than a native module for a 0-1 float.
 */
export function StepPicker({
  label,
  value,
  stops,
  format,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  stops: number[];
  format: (v: number) => string;
  onChange: (v: number) => void;
  hint?: string;
}) {
  // Snap to the nearest stop so a value stored from the web (any float in range)
  // still highlights something rather than nothing.
  const nearest = stops.reduce((best, s) =>
    Math.abs(s - value) < Math.abs(best - value) ? s : best,
  );
  return (
    <Field label={label} hint={hint}>
      <View style={styles.chips}>
        {stops.map((s) => (
          <Chip
            key={s}
            label={format(s)}
            selected={s === nearest}
            onPress={() => onChange(s)}
            style={styles.stop}
          />
        ))}
      </View>
    </Field>
  );
}

/** True while the software keyboard is on screen. */
export function useKeyboardUp(): boolean {
  const [up, setUp] = useState(false);
  useEffect(() => {
    // iOS fires the Will* pair in step with the keyboard animation, so the
    // layout moves with it rather than snapping after it lands. Android only
    // has the Did* pair.
    const ios = Platform.OS === 'ios';
    const show = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', () =>
      setUp(true),
    );
    const hide = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () =>
      setUp(false),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return up;
}

/**
 * A sticky footer with the save button and the result of the last save.
 *
 * The save state lives here rather than in a toast: a toast that vanishes after
 * three seconds is exactly the wrong shape for "saved, but the live receptionist
 * did not update", which is the one message on these screens that matters.
 */
export function SaveBar({
  onSave,
  busy,
  dirty,
  state,
  label = 'Save',
  secondary,
}: {
  onSave: () => void;
  busy: boolean;
  dirty: boolean;
  state: { ok: boolean; message: string } | null;
  label?: string;
  /** A quiet way out beside the primary: "Keep it" next to "Cancel appointment". */
  secondary?: { label: string; onPress: () => void };
}) {
  const insets = useSafeAreaInsets();
  // The bottom inset clears the home indicator - but the keyboard is already
  // covering that strip when it is up, so keeping the inset then just parks the
  // Save button 34pt above the keyboard with nothing in the gap.
  const keyboardUp = useKeyboardUp();
  return (
    <View
      style={[
        styles.saveBar,
        { paddingBottom: keyboardUp ? spacing.md : Math.max(insets.bottom, spacing.md) },
      ]}
    >
      {state && (
        <Text
          style={[styles.saveState, { color: state.ok ? colors.successText : colors.errorText }]}
          accessibilityLiveRegion="polite"
        >
          {state.message}
        </Text>
      )}
      {secondary ? (
        <Button
          label={secondary.label}
          onPress={secondary.onPress}
          variant="ghost"
          disabled={busy}
          style={styles.saveSecondary}
        />
      ) : null}
      <Button
        label={label}
        onPress={onSave}
        busy={busy}
        disabled={!dirty}
        style={styles.saveButton}
      />
    </View>
  );
}

/** A full-screen editor sheet - the phone equivalent of the web's TopicModal. */
export function Sheet({
  visible,
  title,
  onClose,
  children,
  footer,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={visible}
      animationType="slide"
      // Full screen, not a page sheet: these are forms that can hold unsaved
      // edits, and a stray swipe-down must not throw them away.
      presentationStyle="fullScreen"
      // Android: with edge-to-edge the modal window draws under the system
      // bars, so the root insets used below are the right ones.
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      {/* Every sheet in the assistant editor is a form with its Save bar
          pinned at the bottom as `footer`. Without this the keyboard covers
          both the bar and the last field or two, and the only way to save is
          to guess that dismissing the keyboard first is required.
          `padding` on BOTH platforms: app.json turns on edge-to-edge, which
          makes RN call setDecorFitsSystemWindows(false) for the activity and
          every modal - and that disables Android's adjustResize, so the window
          no longer shrinks for the keyboard on its own. */}
      <KeyboardAvoidingView style={styles.flex} behavior="padding">
        <View style={styles.sheet} accessibilityViewIsModal>
          {/* The status-bar inset is padded INSIDE the white head, so the band
              above the title is surface rather than a strip of page grey. */}
          <View style={[styles.sheetHead, { paddingTop: insets.top + spacing.sm }]}>
            <Text style={styles.sheetTitle} numberOfLines={1} accessibilityRole="header">
              {title}
            </Text>
            <IconButton icon="close" label="Close" tone="plain" onPress={onClose} style={styles.sheetClose} />
          </View>
          <ScrollView
            contentContainerStyle={styles.sheetBody}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
          >
            {children}
          </ScrollView>
          {footer}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** A tappable summary row, as used by the assistant screen's topic list. */
export function TopicRow({
  icon,
  title,
  value,
  done,
  onPress,
  style,
}: {
  icon: IconName;
  title: string;
  value: string;
  done?: boolean;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${value}`}
      accessibilityValue={done === undefined ? undefined : { text: done ? 'Done' : 'To do' }}
      android_ripple={ripple}
      style={({ pressed: down }) => [styles.topicRow, down && pressed, style]}
    >
      <View style={[styles.topicIcon, done && { backgroundColor: colors.successSoft }]}>
        <Icon name={icon} size={ICON.row} color={done ? colors.successText : colors.textSecondary} />
      </View>
      <View style={styles.flex}>
        <Text style={styles.topicTitle}>{title}</Text>
        <Text style={styles.topicValue} numberOfLines={1}>
          {value}
        </Text>
      </View>
      <Icon name="chevron-forward" size={ICON.chevron} color={colors.textMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  field: { marginBottom: spacing.lg },
  label: {
    ...type.label,
    marginBottom: 6,
    color: colors.inkSoft,
  },
  hint: { ...type.caption, marginTop: 6 },
  error: { ...type.caption, marginTop: 6, color: colors.errorText },
  input: inputStyle,
  inputLg: inputStyleLg,
  inputMultiline: { minHeight: 110, lineHeight: type.body.lineHeight },
  inputFocused: { borderColor: colors.ink },
  inputError: { borderColor: colors.errorText },
  inputOff: { backgroundColor: colors.surfaceSubtle, color: colors.textSecondary },
  selectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  selectValue: { ...type.body, flex: 1 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  switchTitle: { ...type.body },
  switchBody: { ...type.caption, marginTop: 2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  stop: { minWidth: 62 },
  sheet: { flex: 1, backgroundColor: colors.background },
  sheetHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  sheetTitle: { ...type.title, flex: 1 },
  // A 44pt disc whose glyph lines up with the content's right edge.
  sheetClose: { marginRight: -spacing.md },
  sheetBody: { padding: spacing.lg, paddingBottom: spacing.xxl },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: control.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  searchInput: {
    flex: 1,
    paddingVertical: spacing.sm,
    fontFamily: inputStyle.fontFamily,
    fontSize: inputStyle.fontSize,
    color: colors.text,
  },
  pickerSearch: { margin: spacing.lg, marginBottom: spacing.sm },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 48,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  optionLabel: { ...type.body },
  optionHint: { ...type.caption, marginTop: 2 },
  noMatch: {
    ...type.bodySm,
    padding: spacing.xl,
    textAlign: 'center',
    color: colors.textSecondary,
  },
  saveBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  saveState: { ...type.footnote, flex: 1 },
  saveSecondary: { marginLeft: 'auto' },
  saveButton: {
    minWidth: 110,
    marginLeft: 'auto',
  },
  topicRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 48,
    paddingVertical: spacing.md,
  },
  topicIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceSubtle,
  },
  topicTitle: { ...type.body, fontFamily: type.labelLg.fontFamily },
  topicValue: { ...type.caption, marginTop: 2 },
});
