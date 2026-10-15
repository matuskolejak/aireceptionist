import { useHeaderHeight } from '@react-navigation/elements';
import { usePreventRemove } from '@react-navigation/native';
import * as Haptics from 'expo-haptics';
import { useNavigation, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';

import { SaveBar, SelectRow, SwitchRow, TextField, type Option } from '@/components/form';
import { ErrorState, SkeletonForm, StaleNotice } from '@/components/ui';
import { colors, spacing } from '@/constants/theme';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/api';
import { deviceTimeZone } from '@/lib/locale';
import { useQuery } from '@/lib/use-query';

/**
 * The business profile. Mirrors the web's Business tab, including the two things
 * that are easy to miss there: the company name also renames the business the
 * receptionist speaks for (only when there is exactly one), and "About you" is
 * fed into its brief when sharing is on.
 */
export default function ProfileScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const headerHeight = useHeaderHeight();
  const { email } = useAuth();
  const { data, error, loading, refresh } = useQuery(() => api.settings(), []);

  const [fullName, setFullName] = useState('');
  const [company, setCompany] = useState('');
  const [role, setRole] = useState('');
  const [phone, setPhone] = useState('');
  const [timezone, setTimezone] = useState('');
  // What the zone field was seeded with: the saved zone, else the phone's.
  // Measured against this rather than the saved value, so an account with no
  // zone does not open with Save lit and a discard prompt on the way out.
  const [seededZone, setSeededZone] = useState('');
  const [about, setAbout] = useState('');
  const [share, setShare] = useState(true);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<{ ok: boolean; message: string } | null>(null);

  // Seed once the payload lands. Keyed on `data` rather than run in a mount
  // effect, because the first render has nothing to seed from - but exactly
  // once: useQuery hands back a fresh object on every focus and foreground
  // refetch, and re-seeding would wipe half-typed edits with no warning while
  // resetting `dirty`, so the Save button greys out as if nothing was typed.
  const seeded = useRef(false);
  // A save asks for exactly one more seed, from the copy the server normalized.
  // That request is a separate one-shot flag rather than clearing `seeded`,
  // because a refetch that fails leaves `data` identical and the effect never
  // runs: a cleared `seeded` would stay disarmed from then on, and the next
  // successful focus refetch would wipe whatever was typed after the save.
  const reseed = useRef(false);
  useEffect(() => {
    if (!data || (seeded.current && !reseed.current)) return;
    reseed.current = false;
    seeded.current = true;
    setFullName(data.profile.fullName);
    setCompany(data.profile.company);
    setRole(data.profile.role);
    setPhone(data.profile.phone);
    // An account that never saved a zone is shown in the phone's (the web
    // does the same with the browser's), so that is the sensible default -
    // preselected, and saved with the next Save.
    const zone = data.profile.timezone || deviceTimeZone();
    setTimezone(zone);
    setSeededZone(zone);
    setAbout(data.profile.about);
    setShare(data.profile.shareWithAssistants);
  }, [data]);

  // The server sends ~400 zones and each label needs a formatter, which is a
  // visible stall on the JS thread if done during render. So the picker gets
  // the bare names first and the offset/time labels once they are built,
  // after the first paint; they are keyed on the list they were built from.
  const zoneList = data?.timezones.join('|') ?? '';
  const [labels, setLabels] = useState<{ list: string; byZone: Map<string, string> } | null>(null);
  useEffect(() => {
    if (!zoneList) return;
    const timer = setTimeout(() => {
      const now = new Date();
      setLabels({
        list: zoneList,
        byZone: new Map(zoneList.split('|').map((z) => [z, zoneLabel(z, now)])),
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [zoneList]);
  const labelledZones = useMemo<Option[]>(() => {
    const byZone = labels?.list === zoneList ? labels.byZone : null;
    return (zoneList ? zoneList.split('|') : []).map((z) => ({
      value: z,
      label: byZone?.get(z) ?? zoneName(z),
    }));
  }, [zoneList, labels]);
  // The preselected phone zone must be pickable even if the list lacks it.
  const zoneOptions =
    timezone && !labelledZones.some((o) => o.value === timezone)
      ? [{ value: timezone, label: zoneLabel(timezone, new Date()) }, ...labelledZones]
      : labelledZones;

  const dirty = Boolean(
    data &&
      (fullName !== data.profile.fullName ||
        company !== data.profile.company ||
        role !== data.profile.role ||
        phone !== data.profile.phone ||
        timezone !== seededZone ||
        about !== data.profile.about ||
        share !== data.profile.shareWithAssistants),
  );

  // Back, the swipe and the Android button all leave with the edits unsaved,
  // exactly as the editor's sheets would - so this asks the same question they
  // do. A save that is on its way out sets `leaving` and passes straight through.
  const leaving = useRef(false);
  usePreventRemove(dirty && !busy, ({ data: removal }) => {
    if (leaving.current) {
      navigation.dispatch(removal.action);
      return;
    }
    Alert.alert('Discard changes?', 'Your edits to your profile have not been saved.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => navigation.dispatch(removal.action) },
    ]);
  });

  if (loading) {
    return (
      <View style={[styles.root, styles.content]}>
        <SkeletonForm fields={5} />
      </View>
    );
  }
  // Only a missing payload is a dead end. A failed background refetch still has
  // the last good profile to show, with the notice below saying so.
  if (!data) return <ErrorState message={error ?? 'Could not load your profile.'} onRetry={refresh} />;

  // The web requires both; saving a blank would leave the receptionist
  // answering for a business with no name.
  const nameMissing = !fullName.trim();
  const companyMissing = !company.trim();

  async function save() {
    if (nameMissing || companyMissing) return;
    setBusy(true);
    setState(null);
    try {
      const res = await api.saveSettings({
        fullName,
        company,
        role,
        phone,
        timezone,
        about,
        shareWithAssistants: share,
      });
      // The server trims and normalizes what it stores, so let the saved values
      // re-seed once. Without this a trailing space keeps `dirty` true forever
      // on the warning path.
      reseed.current = true;
      await refresh();
      if (res.warning) {
        setState({ ok: false, message: res.warning });
      } else {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        leaving.current = true;
        router.back();
      }
    } catch (err) {
      setState({ ok: false, message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    // Six editable fields with a Save bar pinned below them. `padding` on both
    // platforms: edge-to-edge (app.json) turns off Android's adjustResize, so
    // the window no longer shrinks for the keyboard on its own. On iOS the KAV
    // measures itself against the window, so it has to be told about the
    // navigation header above it or the keyboard still covers the Save bar.
    <KeyboardAvoidingView
      style={styles.root}
      behavior="padding"
      keyboardVerticalOffset={Platform.OS === 'ios' ? headerHeight : 0}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        {error ? <StaleNotice message={error} onRetry={refresh} /> : null}
        <TextField
          label="Your name"
          value={fullName}
          onChangeText={setFullName}
          autoCapitalize="words"
          autoComplete="name"
          textContentType="name"
          error={nameMissing ? 'Enter your name.' : undefined}
        />
        <TextField label="Email" value={email} onChangeText={() => {}} editable={false} />
        <TextField
          label="Business name"
          value={company}
          onChangeText={setCompany}
          autoComplete="organization"
          textContentType="organizationName"
          error={companyMissing ? 'Enter your business name.' : undefined}
          hint={
            data.businessCount > 1
              ? 'Renaming here does not rename your businesses - do that per business on the web.'
              : 'This is the business name your receptionist answers with.'
          }
        />
        <TextField label="Your role" value={role} onChangeText={setRole} placeholder="Owner" />
        <TextField
          label="Your phone"
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
          autoCapitalize="none"
          autoComplete="tel"
          textContentType="telephoneNumber"
          hint="Used for text alerts when your receptionist takes a message."
        />
        <SelectRow
          label="Time zone"
          value={timezone}
          options={zoneOptions}
          onChange={setTimezone}
          placeholder="Choose a time zone"
          searchable
        />
        <TextField
          label="About you"
          value={about}
          onChangeText={setAbout}
          placeholder="What you do, who you serve, anything your receptionist should know."
          multiline
        />
        <SwitchRow
          title="Share this with your receptionist"
          body="When off, the notes above are kept for you and never reach a call."
          value={share}
          onValueChange={setShare}
        />
      </ScrollView>
      <SaveBar
        onSave={save}
        busy={busy}
        dirty={dirty && !nameMissing && !companyMissing}
        state={state}
      />
    </KeyboardAvoidingView>
  );
}

/**
 * 'Europe/Dublin' -> 'Europe/Dublin (GMT+1, 2:05 PM)': the short UTC offset and
 * the time it is there now, like the web's picker, so a zone can be recognised
 * without knowing its IANA name.
 */
function zoneName(zone: string): string {
  return zone.replace(/_/g, ' ');
}

function zoneLabel(zone: string, now: Date): string {
  const name = zoneName(zone);
  try {
    // One formatter gives both the local time and the offset.
    const parts = new Intl.DateTimeFormat('en', {
      timeZone: zone,
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'shortOffset',
    }).formatToParts(now);
    const offset = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    const time = parts
      .filter((p) => p.type !== 'timeZoneName')
      .map((p) => p.value)
      .join('')
      .trim();
    return `${name} (${offset ? `${offset}, ` : ''}${time})`;
  } catch {
    // An engine without this zone (or without shortOffset) still gets the name.
    return name;
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
});
