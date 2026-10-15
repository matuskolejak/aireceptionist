import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { Dimensions, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { inputStyleLg, SearchField } from '@/components/form';
import { Actions, Ask, Pill } from '@/components/funnel';
import { Icon, type IconName } from '@/components/Icon';
import { ICON, IconButton } from '@/components/ui';
import { colors, control, fonts, radius, spacing, type } from '@/constants/theme';
import { countryForLocale } from '@/lib/locale';
import { isValidAlertPhone } from '@/lib/onboarding-draft';
import {
  BEST_FOR_LABEL,
  TONE_LABEL,
  genderOf,
  joinPhone,
  splitPhone,
  voiceBestFor,
  voicePersonality,
  type Mood,
} from '@/lib/personality';
import type { Catalog, OnboardingState } from '@/lib/types';

/**
 * Step 1, as the website does it: not a form, but meeting the receptionist.
 *
 * Five questions in sequence, one screen each, each one asked BY the assistant
 * rather than labelled above a field - see `Ask`. The web asks the same five in
 * the same order inside a card that never resizes; on a phone the card is the
 * screen, so the shell (`components/funnel.tsx`) owns the fixed question zone
 * and the docked actions and this only fills in the middle.
 *
 * Two things are deliberately different from the web, because a phone is not a
 * mouse:
 *
 *   - The avatar's eyes follow TAPS rather than a cursor.
 *   - The voice question PLAYS each voice and the mouth moves along with it. On
 *     the web a voice is a description you read; picking the voice of your phone
 *     line by reading about it was always the weakest beat in the funnel, and a
 *     phone is the one device guaranteed to have a speaker.
 *
 * Every answer is reported upward as it changes (`onPartial`), so a guest who
 * is interrupted - an app kill, a phone call - comes back to the question they
 * were on with what they had typed.
 */

/** The five questions, in order. `sub` is the line under the question. */
const QUESTIONS = [
  {
    chapter: 'Business',
    q: "What's your business called?",
    sub: 'It is who I tell callers they have reached.',
  },
  {
    chapter: 'Name',
    q: 'What should I call myself?',
    sub: 'Only you see this name - callers hear your business name.',
  },
  { chapter: 'Country', q: 'Where should my number be?', sub: 'Pick where your customers ring from.' },
  { chapter: 'Voice', q: 'How should I sound?', sub: 'Tap a voice to hear it.' },
  {
    chapter: 'Transfer',
    q: 'Where do I send urgent calls?',
    sub: 'Urgent callers get put through to this number, and I text you a heads-up when I take a message.',
  },
] as const;

const LAST = QUESTIONS.length - 1;

/**
 * Ready-made names, so question 2 is a tap rather than an invented word.
 *
 * Naming a thing is the slowest field in the funnel - it is the only one with no
 * right answer - and on a phone it is also the most expensive, because it opens
 * the keyboard for a single short word. Four suggestions per gender turn the
 * commonest case into one tap and leave the field for anyone with their own idea.
 */
const NAME_IDEAS: Record<'f' | 'm', readonly string[]> = {
  f: ['Ava', 'Ivy', 'Nora', 'Mia'],
  m: ['Max', 'Leo', 'Noah', 'Eli'],
};

/**
 * A local number in the shape people write it in each country the server
 * offers, for the transfer field's placeholder. A Slovak example under a +1
 * prefix read as a format the field wanted.
 */
const PHONE_EXAMPLES: Record<string, string> = {
  US: '(555) 123-4567',
  CA: '(555) 123-4567',
  GB: '7700 900123',
  IE: '85 123 4567',
  NL: '6 12345678',
  FR: '6 12 34 56 78',
  DE: '1512 3456789',
  ES: '612 34 56 78',
  IT: '312 345 6789',
  SE: '70 123 45 67',
  PT: '912 345 678',
  BE: '470 12 34 56',
  PL: '512 345 678',
  AU: '412 345 678',
  NZ: '21 123 4567',
  AT: '664 123456',
  CH: '78 123 45 67',
  CZ: '601 123 456',
  SK: '903 123 456',
};

const PHONE_ERROR = 'Include the country code, e.g. +44 7700 900123';

export interface BasicsValues {
  companyName: string;
  companyWebsite: string;
  assistantName: string;
  voiceId: string;
  voiceGender: 'f' | 'm';
  country: string;
  alertsEmail: string;
  alertPhone: string;
}

/** The screen's Android back button asks this first. */
export interface MeetAssistantHandle {
  /** True when it moved to the previous question (or is mid-submit and swallowed it). */
  goBack: () => boolean;
}

export function MeetAssistant({
  state,
  catalog,
  defaultEmail,
  busy,
  error,
  startAt = 0,
  onSubstep,
  onPartial,
  onSubmit,
  backRef,
}: {
  state: OnboardingState;
  catalog: Catalog | null;
  /** Pre-fills the summaries address so the funnel never asks for it twice. */
  defaultEmail: string;
  busy: boolean;
  error: string | null;
  /**
   * Which question to open on. Backing out of step 2 lands on the LAST question
   * rather than the first: someone stepping back wants the answer they just
   * gave, and replaying all five to reach it is the reason funnels feel like a
   * trap. A guest's saved position after an app kill arrives the same way.
   */
  startAt?: number;
  /**
   * Reports which question is open, so the shell's one progress bar is honest
   * and its eyebrow can name the question rather than the whole chapter.
   */
  onSubstep: (index: number, total: number, chapter: string) => void;
  /** The answers so far and the open question, debounced. The shell persists them for a guest. */
  onPartial?: (values: Partial<BasicsValues> & { question: number }) => void;
  onSubmit: (values: BasicsValues) => void;
  backRef?: Ref<MeetAssistantHandle>;
}) {
  const cfg = state.config;
  const countries = state.countries;
  const dials = useMemo(() => catalog?.dialCodes ?? [], [catalog]);
  const voices = useMemo(() => catalog?.voices ?? [], [catalog]);

  const [step, setStep] = useState(() => Math.max(0, Math.min(startAt, LAST)));
  const [nudge, setNudge] = useState(0);
  const [gaze, setGaze] = useState(0);
  const [done, setDone] = useState(false);

  const [business, setBusiness] = useState(cfg.companyName);
  const [website, setWebsite] = useState(cfg.companyWebsite);
  /**
   * The website field, so the business field's return key can move focus INTO
   * it. Both fields used to declare `returnKeyType="next"` and then call
   * `advance`, so the keyboard's Next key - the obvious thing to press with a
   * second field sitting visibly below - skipped the website question entirely
   * and jumped to the next screen. A return key that says "next" has to mean
   * the next field while there still is one.
   */
  const websiteRef = useRef<TextInput>(null);
  /**
   * The other half of that. The website field's Done key sends focus BACK here
   * when neither answer has been given yet, rather than only dismissing the
   * keyboard and reflowing the screen with nothing said about why.
   */
  const businessRef = useRef<TextInput>(null);
  /**
   * The answer zone, so focusing the website field scrolls it and the line
   * under it into view. The keyboard is already up when that happens - the
   * business field autofocuses - so no keyboard event fires and nothing else
   * would bring the bottom of the step on screen.
   */
  const scroller = useRef<ScrollView>(null);
  const [name, setName] = useState(cfg.assistantName);
  // The phone's own region before the first country in the list: an Irish
  // phone wants an Irish number, and the list starts with the US.
  const [country, setCountry] = useState(() => cfg.country || countryForLocale(countries));
  const [gender, setGender] = useState<'f' | 'm'>(cfg.voiceGender);
  const [voiceId, setVoiceId] = useState(cfg.voiceId);

  const [phoneCode, setPhoneCode] = useState(
    () => splitPhone(cfg.alertPhone, cfg.country || country, dials).code,
  );
  const [phoneLocal, setPhoneLocal] = useState(
    () => splitPhone(cfg.alertPhone, cfg.country || country, dials).local,
  );
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const dialStrip = useRef<ScrollView>(null);
  const dialShown = useRef(false);

  // A saved number only resolves into a prefix once the catalogue lands. Once,
  // and never again: re-deriving it from the saved value on a later change
  // rewrote the field under the caller's thumb.
  const phoneSeeded = useRef(dials.length > 0);
  const savedPhone = cfg.alertPhone;
  const savedPhoneCountry = cfg.country || country;
  useEffect(() => {
    if (phoneSeeded.current || !dials.length) return;
    phoneSeeded.current = true;
    const initial = splitPhone(savedPhone, savedPhoneCountry, dials);
    setPhoneCode(initial.code);
    setPhoneLocal(initial.local);
  }, [dials, savedPhone, savedPhoneCountry]);

  // The transfer prefix follows the number's country until the caller picks a
  // different one by hand. Choosing Germany on question 3 and then being shown
  // +1 two screens later was the funnel forgetting its own answer. A number
  // saved earlier already carries its own prefix, so it counts as picked.
  const dialTouched = useRef(Boolean(cfg.alertPhone));
  useEffect(() => {
    if (dialTouched.current || !dials.length) return;
    const match = dials.find((d) => d.code === country);
    if (match) setPhoneCode(match.code);
  }, [country, dials]);

  useEffect(() => {
    onSubstep(step, QUESTIONS.length, QUESTIONS[step].chapter);
  }, [onSubstep, step]);

  const genderVoices = useMemo(() => voices.filter((v) => v.gender === gender), [voices, gender]);

  // Keep the voice and the gender chip agreeing: picking a gender moves the
  // voice with it unless the current one already matches.
  useEffect(() => {
    if (genderVoices.length === 0) return;
    if (genderVoices.some((v) => v.voiceId === voiceId)) return;
    setVoiceId(genderVoices[0].voiceId);
  }, [genderVoices, voiceId]);

  const joinedPhone = joinPhone(dials.find((d) => d.code === phoneCode)?.dial ?? '', phoneLocal);

  // Persist as the caller goes. Debounced: this runs on every keystroke, and
  // the draft only has to be as fresh as the last pause. Skipped on mount -
  // the values are the ones just read back.
  const onPartialRef = useRef(onPartial);
  useEffect(() => {
    onPartialRef.current = onPartial;
  });
  const partialMounted = useRef(false);
  useEffect(() => {
    if (!partialMounted.current) {
      partialMounted.current = true;
      return;
    }
    if (done || !onPartialRef.current) return;
    const t = setTimeout(() => {
      onPartialRef.current?.({
        companyName: business,
        companyWebsite: website,
        assistantName: name,
        voiceId,
        voiceGender: gender,
        country,
        alertPhone: joinedPhone,
        question: step,
      });
    }, 400);
    return () => clearTimeout(t);
  }, [business, website, name, voiceId, gender, country, joinedPhone, step, done]);

  const voice = voices.find((v) => v.voiceId === voiceId) ?? null;
  // Step 1 needs something to answer as: a business name, or a website the
  // assistant can take one from (the provisioner derives the name from the
  // domain when only a site was given, as the web does).
  const hasBusiness = business.trim().length > 0 || website.trim().length > 0;
  // Scoped to the question that has a required answer. The guard used to cover
  // all five, which is invisible going forwards - you cannot reach question 2
  // without answering question 1 - but backing INTO step 1 lands on the LAST
  // question (see `startAt`), so an account saved without an answer would have
  // arrived on question 5 with a permanently dead button and four presses of
  // Back as the only way to find out why.
  const canAdvance = step > 0 || hasBusiness;

  const [preview, setPreview] = useState<string | null>(null);
  const talking = usePreviewPlayer(preview, () => setPreview(null));

  /**
   * `greeting` is the blank-slate face, worn until the caller has made this
   * thing theirs. It used to be gated on the business field being empty, so it
   * was lost on the first character typed - and what replaced it was the
   * personality of a voice nobody had chosen, because the effect above
   * auto-selects one the moment the catalogue lands. That is why the gate is
   * not `voiceId`: it is set before the caller has seen a voice. The name they
   * give it on question 2 is the first thing they genuinely pick, and using it
   * also stops someone backing into question 1 being greeted by an assistant
   * they have already named.
   */
  const mood: Mood = done
    ? 'celebrate'
    : step === 0 && !name.trim()
      ? 'greeting'
      : voicePersonality(voice?.name, voice?.description).mood;

  /**
   * The answers already given, newest last. Only questions BEFORE the open one
   * appear, so this never previews what is being asked right now.
   */
  const soFar = useMemo(() => {
    const rows: { key: string; icon: IconName; value: string }[] = [];
    const businessLabel = business.trim() || website.trim();
    if (step > 0 && businessLabel) {
      rows.push({ key: 'business', icon: 'business-outline', value: businessLabel });
    }
    if (step > 1 && name.trim()) {
      rows.push({ key: 'name', icon: 'happy-outline', value: name.trim() });
    }
    if (step > 2) {
      const c = countries.find((x) => x.code === country);
      if (c) rows.push({ key: 'country', icon: 'call-outline', value: `${c.flag} ${c.name}` });
    }
    if (step > 3 && voice) {
      rows.push({ key: 'voice', icon: 'mic-outline', value: `${voice.name}'s voice` });
    }
    return rows;
  }, [business, website, name, country, countries, voice, step]);

  function go(target: number) {
    const next = Math.max(0, Math.min(target, LAST));
    if (next === step) return;
    if (next > step) {
      setNudge((n) => n + 1);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    setPreview(null);
    // The dial strip is rebuilt on the way back in; bring its pick into view again.
    if (next === LAST) dialShown.current = false;
    setStep(next);
  }

  function finish() {
    setDone(true);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }

  function advance() {
    if (!canAdvance) return;
    if (step < LAST) return go(step + 1);
    // The server refuses the whole of step 1 over a malformed number, so it
    // is caught here, on the question, while it is still on screen.
    if (phoneLocal.trim() && !isValidAlertPhone(joinedPhone)) {
      setPhoneError(PHONE_ERROR);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    finish();
  }

  useImperativeHandle(backRef, () => ({
    goBack: () => {
      // Mid-celebration the answers are already on their way; stepping back
      // under the save would only race it.
      if (done) return true;
      if (step > 0) {
        go(step - 1);
        return true;
      }
      return false;
    },
  }));

  // The success beat, matching the web's hold before it submits.
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => {
      onSubmit({
        companyName: business.trim(),
        companyWebsite: website.trim(),
        assistantName: name,
        voiceId,
        voiceGender: gender,
        country,
        alertsEmail: defaultEmail,
        alertPhone: joinedPhone,
      });
    }, 1200);
    return () => clearTimeout(t);
    // Only the beat retriggers this; the values are read when it fires, and
    // depending on them would reset the timer on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  // A failed save has to give the questions back, or the celebrate face sits
  // above an error with no way forward.
  useEffect(() => {
    if (error) setDone(false);
  }, [error]);

  if (done) {
    return (
      <View style={styles.root}>
        <Ask
          mood="celebrate"
          // The beat, not just the face. `mood` swaps the mouth in one frame;
          // `celebrate` is the pop and the sparkles, and this hold is the only
          // place in step 1 that has earned them - it is the assistant saying
          // its own name for the first time. Deliberately no `talking` here:
          // the mood mouth and the TALKING path cross-fade against each other,
          // so miming a line with no audio would hide the celebrate grin that
          // is the point, and the mouth is tied to real audio by design.
          celebrate
          name={name}
          question={name.trim() ? `I'm ${name.trim()}.` : "That's me set up."}
          sub={`Ready to answer for ${business.trim() || website.trim() || 'your business'}.`}
          nudge={nudge}
        />
        <View style={styles.flex} />
      </View>
    );
  }

  const current = QUESTIONS[step];
  const hasPhone = phoneLocal.trim().length > 0;

  return (
    <View
      style={styles.root}
      // The whole step feeds the avatar's gaze: a tap on the left half makes it
      // look left, the right half right. It costs nothing and it is the cheapest
      // thing that makes the character feel like it is watching you work.
      //
      // Read at touch time rather than held in state, so it survives a
      // rotation or a split view without re-rendering.
      onTouchStart={(e) =>
        setGaze(e.nativeEvent.pageX < Dimensions.get('window').width / 2 ? -1 : 1)
      }
    >
      <Ask
        mood={mood}
        name={name}
        question={current.q}
        sub={current.sub}
        nudge={nudge}
        talking={talking}
        gaze={gaze}
      />

      <ScrollView
        ref={scroller}
        style={styles.flex}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        {step === 0 && (
          <>
            {/* Unlabelled on screen: the question directly above asks for
                exactly this. The optional one below IS labelled, and that
                asymmetry is where the hierarchy comes from. */}
            <TextInput
              ref={businessRef}
              style={styles.input}
              value={business}
              onChangeText={setBusiness}
              placeholder="e.g. Bright Dental"
              placeholderTextColor={colors.textMuted}
              accessibilityLabel="Business name"
              textContentType="organizationName"
              autoComplete="organization"
              autoCapitalize="words"
              autoCorrect={false}
              autoFocus
              returnKeyType="next"
              // Without this the keyboard dismisses and reopens between the two
              // fields, which on a real device reads as the screen flinching.
              submitBehavior="submit"
              onSubmitEditing={() => websiteRef.current?.focus()}
            />

            {/* Either answer is enough - the web accepts a site on its own and
                derives the name from the domain - but they are not the same
                answer: the name is what callers are told, and the site is the
                only knowledge this funnel gathers by itself. So the name comes
                first and the site is the labelled, optional second. */}
            <Text style={styles.fieldLabel}>Website (optional)</Text>
            <TextInput
              ref={websiteRef}
              style={[styles.input, styles.websiteInput]}
              value={website}
              onChangeText={setWebsite}
              placeholder="e.g. brightdental.com"
              placeholderTextColor={colors.textMuted}
              accessibilityLabel="Website, optional"
              accessibilityHint="A business name or a website is enough."
              textContentType="URL"
              autoComplete="url"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              inputMode="url"
              returnKeyType="done"
              submitBehavior="submit"
              // This field and the line under it sit below the fold with the
              // keyboard up, and the keyboard is already up when focus lands
              // here, so nothing else brings them into view.
              onFocus={() => scroller.current?.scrollToEnd({ animated: true })}
              onSubmitEditing={() => {
                if (hasBusiness) return advance();
                businessRef.current?.focus();
              }}
            />
            <Text style={styles.hint}>Either one is enough.</Text>

            {/* The best sentence on this screen: the reason to fill the field
                above it. It echoes the domain back once there is one, the way
                question 5 confirms a transfer number. */}
            <View style={styles.outcomeRow}>
              <Icon
                name={website.trim() ? 'checkmark-circle' : 'sparkles-outline'}
                size={ICON.row}
                color={website.trim() ? colors.successText : colors.ink}
              />
              <Text style={styles.outcomeText}>
                I read {website.trim() || 'it'} before your first call, so I already know your
                services.
              </Text>
            </View>
          </>
        )}

        {step === 1 && (
          <>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="Receptionist"
              placeholderTextColor={colors.textMuted}
              accessibilityLabel="Receptionist name"
              autoCapitalize="words"
              autoCorrect={false}
              autoFocus
              returnKeyType="next"
              onSubmitEditing={advance}
            />

            {/* One tap instead of one keyboard. The set follows the voice
                gender below, so the two questions visibly belong together. */}
            <View style={styles.pills}>
              {NAME_IDEAS[gender].map((idea) => (
                <Pill
                  key={idea}
                  label={idea}
                  active={name.trim().toLowerCase() === idea.toLowerCase()}
                  onPress={() => setName(idea)}
                />
              ))}
            </View>

            <Text style={styles.fieldLabel}>My voice</Text>
            <View style={styles.chips} accessibilityRole="radiogroup">
              {(['f', 'm'] as const).map((g) => (
                <Chip
                  key={g}
                  label={g === 'f' ? 'Female' : 'Male'}
                  active={gender === g}
                  onPress={() => setGender(g)}
                />
              ))}
            </View>
            <Text style={styles.hint}>You pick the exact voice next, and can hear it.</Text>
          </>
        )}

        {step === 2 && (
          <CountryPicker countries={countries} value={country} onPick={setCountry} />
        )}

        {step === 3 && (
          <>
            {/* The gender question belongs to the name screen, which is where it
                is asked. What is left here says what is on screen and offers
                the way back to the question that decided it. */}
            <View style={styles.showing}>
              <Text style={styles.showingText}>
                Showing {gender === 'f' ? 'female' : 'male'} voices
              </Text>
              <Pressable
                onPress={() => go(1)}
                accessibilityRole="button"
                accessibilityLabel="Change voice gender"
                hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
              >
                <Text style={styles.showingChange}>Change</Text>
              </Pressable>
            </View>
            {genderVoices.length === 0 ? (
              <Text style={styles.hint}>Loading voices...</Text>
            ) : (
              <View style={styles.list} accessibilityRole="radiogroup">
                {genderVoices.map((v) => (
                  <VoiceCard
                    key={v.voiceId}
                    name={v.name}
                    tone={TONE_LABEL[voicePersonality(v.name, v.description).tone]}
                    bestFor={BEST_FOR_LABEL[voiceBestFor(v.description)]}
                    active={voiceId === v.voiceId}
                    playing={preview !== null && preview === v.previewUrl}
                    canPlay={Boolean(v.previewUrl)}
                    onSelect={() => {
                      setVoiceId(v.voiceId);
                      const g = genderOf(v.description);
                      if (g) setGender(g);
                      // The question says "Tap a voice to hear it", so tapping
                      // a voice plays it - the pre-selected one included, which
                      // used to be the one card that answered a tap with
                      // silence. A card already talking is left talking.
                      if (v.previewUrl && preview !== v.previewUrl) setPreview(v.previewUrl);
                    }}
                    onPlay={() =>
                      setPreview((cur) => (cur === v.previewUrl ? null : (v.previewUrl ?? null)))
                    }
                  />
                ))}
              </View>
            )}

            {/* The funnel offers a curated four, which without this reads as the
                whole catalogue - and someone who does not hear the voice they
                want here has no way to know the rest exist. */}
            {genderVoices.length > 0 && (
              <View style={styles.moreVoices}>
                <Icon name="options-outline" size={ICON.chevron} color={colors.textSecondary} />
                <Text style={styles.moreVoicesText}>
                  Pick one for now. Once I am live you can change my voice, language and pacing
                  any time under Receptionist.
                </Text>
              </View>
            )}
          </>
        )}

        {step === 4 && (
          <>
            <ScrollView
              ref={dialStrip}
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.dialStrip}
              contentContainerStyle={styles.dialStripContent}
              keyboardShouldPersistTaps="handled"
              accessibilityRole="radiogroup"
            >
              {dials.map((d) => (
                <Pressable
                  key={d.code}
                  // Once, on the way in: the prefix picked for Ireland sits
                  // off the right edge of the strip, which read as none picked.
                  // Never again after that - a strip that scrolls itself under
                  // a tap is a strip that moves the thing just tapped.
                  onLayout={(e) => {
                    if (dialShown.current || d.code !== phoneCode) return;
                    dialShown.current = true;
                    const x = e.nativeEvent.layout.x - spacing.lg;
                    if (x > 0) dialStrip.current?.scrollTo({ x, animated: false });
                  }}
                  onPress={() => {
                    dialTouched.current = true;
                    setPhoneCode(d.code);
                    setPhoneError(null);
                  }}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: phoneCode === d.code }}
                  accessibilityLabel={`Dial code ${d.dial}, ${d.code}`}
                  style={[styles.dial, phoneCode === d.code && styles.dialOn]}
                >
                  {/* The ISO code, because the US and Canada are both "+1" and
                      a flag at 15pt is not how you tell two countries apart. */}
                  <Text style={[styles.dialText, phoneCode === d.code && styles.dialTextOn]}>
                    {d.flag} {d.code} {d.dial}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            <TextInput
              style={[styles.input, phoneError ? styles.inputError : null]}
              value={phoneLocal}
              onChangeText={(v) => {
                setPhoneLocal(v);
                if (phoneError) setPhoneError(null);
              }}
              placeholder={PHONE_EXAMPLES[phoneCode] ?? 'Phone number'}
              placeholderTextColor={colors.textMuted}
              accessibilityLabel="Transfer number"
              textContentType="telephoneNumber"
              autoComplete="tel"
              keyboardType="phone-pad"
              inputMode="tel"
              autoFocus
              // No returnKeyType: a phone pad has no return key, so iOS would
              // add a "Done" toolbar of its own for it - a second, floating
              // submit stacked under the docked "Put me on the line" that the
              // keyboard already lifts into reach.
            />
            {phoneError ? (
              <Text style={styles.error} accessibilityLiveRegion="assertive">
                {phoneError}
              </Text>
            ) : null}

            {/* The last question is the one most often answered wrong, because
                "urgent" is doing a lot of work in it. Saying what actually
                happens - and what happens instead if it is left blank - is
                cheaper than a caller finding out on a live line. */}
            <View style={styles.outcome}>
              <View style={styles.outcomeRow}>
                <Icon
                  name={hasPhone ? 'checkmark-circle' : 'ellipse-outline'}
                  size={ICON.row}
                  color={hasPhone ? colors.successText : colors.textSecondary}
                />
                <Text style={styles.outcomeText}>
                  {hasPhone
                    ? 'Urgent callers get put through to this number.'
                    : 'With no number, nothing gets put through - I take a message instead.'}
                </Text>
              </View>
              <View style={styles.outcomeRow}>
                <Icon name="chatbox-ellipses-outline" size={ICON.row} color={colors.textSecondary} />
                <Text style={styles.outcomeText}>
                  {hasPhone
                    ? 'When I take a message, I text this number a heads-up.'
                    : 'Everything else I handle myself and send you the message.'}
                </Text>
              </View>
            </View>
          </>
        )}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {/* Parked in the slack rather than under the answer - see `SoFar`. */}
        <SoFar items={soFar} />
      </ScrollView>

      <Actions
        primary={{
          // One word on every question. "Put me on the line" on the last one
          // read as "go live" and led to the knowledge step instead; and with
          // an empty field it already meant "no transfer number", so a
          // separate Skip only offered the same thing twice.
          label: 'Continue',
          onPress: advance,
          disabled: !canAdvance,
          busy,
        }}
        onBack={step > 0 ? () => go(step - 1) : undefined}
      />
    </View>
  );
}

/**
 * The number's country: a filter over the list when it is long, and one radio
 * per country. Question 3 and the plan step's country sheet both render this,
 * so the two cannot offer different lists.
 */
export function CountryPicker({
  countries,
  value,
  onPick,
}: {
  countries: { code: string; name: string; flag: string }[];
  value: string;
  onPick: (code: string) => void;
}) {
  /** Twenty-odd countries is more than a phone can scan. */
  const [query, setQuery] = useState('');
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return countries;
    return countries.filter(
      (c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase().startsWith(q),
    );
  }, [countries, query]);

  return (
    <View style={styles.list}>
      {/* A phone shows five of twenty-odd rows at a time, so without this the
          answer is found by scrolling blind. Hidden on a short list, where a
          search box is just another thing to read. */}
      {countries.length > 8 && (
        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder="Search countries"
          accessibilityLabel="Search countries"
          style={styles.search}
        />
      )}

      {shown.length === 0 ? (
        <Text style={styles.hint}>
          No country matches &quot;{query.trim()}&quot;. I can only take a number in the
          countries listed.
        </Text>
      ) : (
        <View style={styles.list} accessibilityRole="radiogroup">
          {shown.map((c) => (
            <SelectCard
              key={c.code}
              lead={c.flag}
              title={c.name}
              active={value === c.code}
              onPress={() => onPick(c.code)}
            />
          ))}
        </View>
      )}
    </View>
  );
}

/**
 * Plays one preview and reports whether audio is actually coming out, which is
 * what drives the avatar's mouth.
 *
 * `playsInSilentMode` because a phone on a desk is very often on silent, and a
 * voice picker that is mute on half the devices that open it is worse than none.
 */
function usePreviewPlayer(url: string | null, onEnd: () => void): boolean {
  const player = useAudioPlayer(url ? { uri: url } : null);
  const status = useAudioPlayerStatus(player);

  useEffect(() => {
    void setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: false });
  }, []);

  useEffect(() => {
    if (!url) return;
    player.seekTo(0);
    player.play();
  }, [player, url]);

  // Clearing the URL on finish is what lets the same voice be replayed.
  const ended = status.didJustFinish;
  useEffect(() => {
    if (ended) onEnd();
    // `onEnd` is a fresh closure each render; depending on it would fire this
    // on every status tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ended]);

  return Boolean(url) && status.playing;
}

/**
 * What has been answered so far, parked at the bottom of the empty space.
 *
 * Every question after the first leaves 40-55% of a phone screen empty: the
 * question is pinned at the top and one field cannot fill what is left. The
 * slack is not worth centring the field into - that was tried, and it separates
 * a question from its own answer - so it is given a job instead. The assistant
 * assembling itself, one line per answer, means the funnel visibly accumulates
 * rather than only counting down, and it is where a wrong answer gets spotted
 * while going back to fix it is still cheap.
 */
function SoFar({ items }: { items: { key: string; icon: IconName; value: string }[] }) {
  if (items.length === 0) return null;
  return (
    // `marginTop: auto` inside a `flexGrow: 1` content box: it takes the slack
    // that is there and nothing at all on a step that already fills the screen.
    <View style={styles.soFar}>
      <Text style={styles.soFarHead} accessibilityRole="header">
        So far
      </Text>
      {items.map((item) => (
        <View key={item.key} style={styles.soFarRow}>
          <Icon name={item.icon} size={15} color={colors.textSecondary} />
          <Text style={styles.soFarValue} numberOfLines={1}>
            {item.value}
          </Text>
          <Icon name="checkmark" size={15} color={colors.successText} />
        </View>
      ))}
    </View>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: active }}
      style={[styles.chip, active && styles.chipOn]}
    >
      <Text style={[styles.chipText, active && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}

/** A full-width choice. Big enough to hit while walking, which is the test. */
function SelectCard({
  lead,
  title,
  active,
  onPress,
}: {
  lead: string;
  title: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      // The name alone: the flag is read out as a second, longer name.
      accessibilityLabel={title}
      accessibilityState={{ checked: active }}
      style={[styles.selectCard, active && styles.selectCardOn]}
    >
      <Text style={styles.lead}>{lead}</Text>
      <Text style={styles.selectTitle} numberOfLines={1}>
        {title}
      </Text>
      {active && <Icon name="checkmark-circle" size={20} color={colors.ink} />}
    </Pressable>
  );
}

/**
 * One voice: the row chooses it, the speaker auditions it.
 *
 * Two targets rather than "selecting plays it", because choosing and comparing
 * are different intents - someone weighing two voices should not have to
 * re-listen to the one they already picked just to keep it. For a screen
 * reader the row is one element and the audition is its custom action: a
 * button nested inside another is not reachable by VoiceOver at all.
 */
function VoiceCard({
  name,
  tone,
  bestFor,
  active,
  playing,
  canPlay,
  onSelect,
  onPlay,
}: {
  name: string;
  tone: string;
  bestFor: string;
  active: boolean;
  playing: boolean;
  canPlay: boolean;
  onSelect: () => void;
  onPlay: () => void;
}) {
  return (
    <Pressable
      onPress={onSelect}
      accessibilityRole="radio"
      accessibilityState={{ checked: active }}
      accessibilityLabel={`${name}, ${tone}, good for ${bestFor}`}
      accessibilityActions={
        canPlay
          ? [{ name: 'activate' }, { name: 'preview', label: playing ? `Stop ${name}` : `Hear ${name}` }]
          : undefined
      }
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'activate') onSelect();
        else if (e.nativeEvent.actionName === 'preview') onPlay();
      }}
      style={[styles.voice, active && styles.voiceOn]}
    >
      <View style={styles.flex}>
        <View style={styles.voiceHead}>
          <Text style={styles.voiceName}>{name}</Text>
          {active && <Icon name="checkmark-circle" size={18} color={colors.ink} />}
        </View>
        <Text style={styles.voiceTone}>{tone}</Text>
        <Text style={styles.voiceBest}>{bestFor}</Text>
      </View>
      {canPlay && (
        // Hidden from the screen reader: the row's custom action is its
        // audition, and a button inside a radio is unreachable anyway.
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <IconButton
            icon={playing ? 'pause' : 'play'}
            label={playing ? `Stop ${name}` : `Hear ${name}`}
            tone={playing ? 'ink' : 'subtle'}
            onPress={onPlay}
          />
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  // Top-aligned, deliberately. Centring this was tried and reverted: on a
  // one-field question it parked the input ~240pt below the question it
  // answers, so the two stopped reading as a pair. The slack belongs at the
  // bottom, above the docked bar, where nobody notices it.
  content: {
    flexGrow: 1,
    padding: spacing.lg,
    gap: spacing.sm,
    paddingBottom: spacing.xl,
  },
  list: { gap: spacing.sm },

  // The shared input surface at the funnel's larger size.
  input: inputStyleLg,
  inputError: { borderColor: colors.errorText },
  // One border step lighter than the required field above it - the weight
  // `selectCard` and `voice` already use, where `input` uses `borderStrong`.
  // The height and the type size deliberately do NOT change: this is the field
  // the step most wants filled, and shrinking a target to make a point about
  // hierarchy works against that.
  websiteInput: { borderColor: colors.border },
  hint: { ...type.footnote },

  fieldLabel: {
    ...type.micro,
    marginTop: spacing.md,
  },

  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs },

  search: { marginBottom: spacing.xs },

  soFar: {
    marginTop: 'auto',
    paddingTop: spacing.xl,
    gap: spacing.sm,
  },
  soFarHead: { ...type.micro },
  soFarRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  soFarValue: { ...type.bodySm, flex: 1, color: colors.textSecondary },

  outcome: {
    gap: spacing.sm,
    marginTop: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSubtle,
  },
  outcomeRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  // inkSoft, not textSecondary: this sits on surfaceSubtle in question 5,
  // where textSecondary drops under 4.5:1.
  outcomeText: { ...type.footnote, flex: 1, color: colors.inkSoft },

  chips: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  showing: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
  },
  showingText: { ...type.footnote },
  showingChange: {
    ...type.label,
    fontFamily: fonts.semibold,
    color: colors.ink,
    textDecorationLine: 'underline',
  },
  chip: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: control.lg,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { ...type.button, color: colors.inkSoft },
  chipTextOn: { color: colors.white },

  selectCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 56,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  selectCardOn: { borderColor: colors.ink, borderWidth: 1.5 },
  // An emoji flag, sized like the heading beside it; not a text style.
  lead: { fontSize: type.heading.fontSize },
  selectTitle: { ...type.body, flex: 1, fontFamily: fonts.medium },

  voice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  voiceOn: { borderColor: colors.ink, borderWidth: 1.5 },
  voiceHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  voiceName: { ...type.title },
  voiceTone: { ...type.bodySm, marginTop: 2, color: colors.textSecondary },
  voiceBest: { ...type.caption, marginTop: 1 },

  dialStrip: { marginHorizontal: -spacing.lg, flexGrow: 0 },
  dialStripContent: { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  dial: {
    minHeight: control.md,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  dialOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  dialText: { ...type.button, color: colors.inkSoft },
  dialTextOn: { color: colors.white },

  moreVoices: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    marginTop: spacing.xs,
    paddingHorizontal: spacing.md,
  },
  moreVoicesText: { ...type.footnote, flex: 1 },

  error: { ...type.bodySm, marginTop: spacing.xs, color: colors.errorText },
});
