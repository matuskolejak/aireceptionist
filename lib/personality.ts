/**
 * The assistant's face and tone, derived from the chosen voice.
 *
 * A port of the web funnel's `personality.ts`. The regexes are copied verbatim
 * rather than adapted: the two funnels read the SAME voice descriptions from the
 * same ElevenLabs catalogue, and a phone that decides "Rachel" is calm while the
 * website decides she is friendly gives the same product two different faces.
 */

export type ToneKey = 'toneFriendly' | 'toneCalm' | 'toneConfident' | 'toneBright';

/**
 * The expression the avatar wears. `greeting` is the blank-slate wave before a
 * voice is picked; `celebrate` is the once-it-is-ready face.
 */
export type Mood =
  | 'greeting'
  | 'friendly'
  | 'calm'
  | 'confident'
  | 'bright'
  | 'celebrate'
  | 'studying';

export interface Personality {
  tone: ToneKey;
  mood: Mood;
}

const BRIGHT_RE = /\b(energetic|cheerful|bright|upbeat|expressive|lively|playful|young)\b/i;
const CONFIDENT_RE = /\b(deep|confident|bold|strong|authoritative|announcer|rich)\b/i;
const CALM_RE =
  /\b(calm|professional|soft|gentle|smooth|news|narration|serious|mature|articulate)\b/i;

/** Friendly and warm is the default - the tone wanted when nothing else matches. */
export function voicePersonality(name?: string, description?: string): Personality {
  const d = `${name ?? ''} ${description ?? ''}`;
  if (BRIGHT_RE.test(d)) return { tone: 'toneBright', mood: 'bright' };
  if (CONFIDENT_RE.test(d)) return { tone: 'toneConfident', mood: 'confident' };
  if (CALM_RE.test(d)) return { tone: 'toneCalm', mood: 'calm' };
  return { tone: 'toneFriendly', mood: 'friendly' };
}

/** What the tone chip under the avatar reads. */
export const TONE_LABEL: Record<ToneKey, string> = {
  toneFriendly: 'Friendly and warm',
  toneCalm: 'Calm and professional',
  toneConfident: 'Confident and clear',
  toneBright: 'Bright and upbeat',
};

/**
 * The business case a voice suits, so the picker offers a reason to choose
 * rather than a raw ElevenLabs descriptor.
 */
export type BestForKey = 'bestForPro' | 'bestForWarm' | 'bestForConfident' | 'bestForVersatile';

const BF_CONFIDENT =
  /\b(deep|confident|authoritative|bold|strong|narrat|character|dramatic|announcer)\b/i;
const BF_PRO =
  /\b(professional|calm|serious|news|informative|corporate|formal|articulate|business)\b/i;
const BF_WARM = /\b(warm|friendly|soft|gentle|pleasant|soothing|cheerful|welcoming|casual|social)\b/i;

export function voiceBestFor(description?: string): BestForKey {
  const d = description ?? '';
  if (BF_CONFIDENT.test(d)) return 'bestForConfident';
  if (BF_PRO.test(d)) return 'bestForPro';
  if (BF_WARM.test(d)) return 'bestForWarm';
  return 'bestForVersatile';
}

export const BEST_FOR_LABEL: Record<BestForKey, string> = {
  bestForPro: 'Clinics and firms',
  bestForWarm: 'Salons and shops',
  bestForConfident: 'Trades and services',
  bestForVersatile: 'Any business',
};

export function genderOf(description?: string): 'f' | 'm' | undefined {
  const d = description ?? '';
  if (/\bfemale\b/i.test(d)) return 'f';
  if (/\bmale\b/i.test(d)) return 'm';
  return undefined;
}

/** Fills `{name}` / `{company}` placeholders in a copy template. */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? `{${key}}`);
}

/**
 * Split a stored E.164 number into a dial selection plus the local remainder.
 * Ported from `lib/number-pricing.ts` so the transfer-number field round-trips
 * a saved value the way the web's does.
 */
export function splitPhone(
  value: string,
  fallbackCode: string,
  dials: { code: string; dial: string }[],
): { code: string; local: string } {
  const v = (value || '').replace(/[\s().-]/g, '');
  if (v.startsWith('+')) {
    // Longest dial first, so "+421" wins over an overlapping shorter prefix.
    const byLength = [...dials].sort((a, b) => b.dial.length - a.dial.length);
    const opt = byLength.find((d) => v.startsWith(d.dial));
    if (opt) return { code: opt.code, local: v.slice(opt.dial.length) };
  }
  return { code: fallbackCode, local: v.replace(/^\+/, '') };
}

/**
 * Combine a dial prefix with a typed number. A number typed in full (leading
 * `+` or `00`) wins; otherwise the prefix is prepended and one national trunk
 * `0` is dropped.
 */
export function joinPhone(dial: string, local: string): string {
  const raw = (local || '').replace(/[\s().-]/g, '');
  if (!raw) return '';
  if (raw.startsWith('+')) return raw;
  if (raw.startsWith('00')) return '+' + raw.slice(2);
  return dial + raw.replace(/^0/, '');
}
