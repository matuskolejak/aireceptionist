import type { TextStyle } from 'react-native';

/**
 * The design tokens, taken from what the web dashboard actually renders.
 *
 * Not from `--success/--warning/--error` in the web's globals.css: those vars
 * are dead. The dashboard draws its status colour with Tailwind emerald, amber
 * and rose (dots -500, text -700, pills -50 bg / -200 border / -700 text), so
 * that is what is ported here. Everything else is near-black on white with
 * colour reserved for meaning, and a phone showing a different colour language
 * for the same numbers would read as a different product.
 *
 * Type is Inter (one family, loaded in app/_layout.tsx), surfaces are the web's
 * flat `.shape-card` (20/20/20/4 corners, hairline outline, no drop shadow) on
 * the `.dash-bg` page.
 *
 * `--color-black` / `--color-neutral-900` are both #1D1D1D on the web, which is
 * why `ink` is not pure black here either.
 */
export const colors = {
  /** Site "black" (Jet). Text, primary buttons, the active tab. */
  ink: '#1D1D1D',
  inkSoft: '#3F3F3F',

  text: '#1D1D1D',
  /**
   * 4.74:1 on white, 4.5:1 on the page - anything a person has to READ that is
   * not body text. Only 4.35:1 on surfaceSubtle, so text on a grey fill is inkSoft.
   */
  textSecondary: '#737373',
  /**
   * 2.42:1 - under WCAG AA even for large text. Only for things that carry no
   * meaning on their own: a placeholder, an icon beside a label that already
   * says the same thing, a disabled control, a decorative dot. Never readable
   * text; that is textSecondary.
   */
  textMuted: '#A3A3A3',

  /** `.dash-bg`. */
  background: '#F8F9FB',
  surface: '#FFFFFF',
  surfaceSubtle: '#F5F5F5',

  border: '#E5E5E5',
  borderStrong: '#D4D4D4',
  /** The `.glass` outline, rgb(15 23 42 / .06) on the web, a touch firmer for a phone's smaller cards. */
  hairline: 'rgba(15,23,42,0.08)',

  /*
   * The only semantic colours in the product. Do not add a fourth.
   * The bare name is for dots and fills; `*Text` is the readable shade
   * (>= 4.5:1 on white and on its own `*Soft`); `*Soft`/`*Border` make a pill.
   */
  success: '#10B981',
  successText: '#047857',
  successSoft: '#ECFDF5',
  successBorder: '#A7F3D0',
  warning: '#F59E0B',
  warningText: '#B45309',
  warningSoft: '#FFFBEB',
  warningBorder: '#FDE68A',
  error: '#F43F5E',
  errorText: '#BE123C',
  errorSoft: '#FFF1F2',
  errorBorder: '#FECDD3',

  /** The web overview's amber-600 tile number (large text, 3:1 bar). */
  tileWarn: '#D97706',
  /** The live-call pulse. */
  live: '#FBBF24',
  white: '#FFFFFF',
  /** Secondary text on an ink fill (the live banner's second line): 9.6:1 on ink. */
  textOnInk: '#D4D4D4',
} as const;

/**
 * Inter, one weight per family name. Android ignores `fontWeight` on a custom
 * font and iOS would synthesise a fake bold from it, so weight is chosen by
 * family and `fontWeight` is never set alongside one of these.
 */
export const fonts = {
  light: 'Inter_300Light',
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
} as const;

/**
 * The type scale. The web's body is Inter 300; at phone sizes that is too thin
 * to read outdoors, so body is 400. Display and headings are 600; nothing is
 * 700.
 */
export const type = {
  display: { fontFamily: fonts.semibold, fontSize: 24, lineHeight: 30, letterSpacing: -0.5, color: colors.text },
  title: { fontFamily: fonts.semibold, fontSize: 17, lineHeight: 22, color: colors.text },
  section: { fontFamily: fonts.medium, fontSize: 14, lineHeight: 20, color: colors.text },
  body: { fontFamily: fonts.regular, fontSize: 15, lineHeight: 22, color: colors.text },
  bodySm: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.text },
  caption: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 16, color: colors.textSecondary },
  eyebrow: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: colors.textSecondary,
  },
  stat: { fontFamily: fonts.semibold, fontSize: 24, lineHeight: 30, fontVariant: ['tabular-nums'], color: colors.text },
  price: { fontFamily: fonts.medium, fontSize: 30, lineHeight: 36, letterSpacing: -0.6, color: colors.text },
  button: { fontFamily: fonts.semibold, fontSize: 15, lineHeight: 20 },
  label: { fontFamily: fonts.medium, fontSize: 13, lineHeight: 18, color: colors.text },
  /** A control label one step up from `label`: chips, segments, pill buttons, status lines. */
  labelLg: { fontFamily: fonts.medium, fontSize: 14, lineHeight: 20, color: colors.text },
  /** A card or hero heading between `title` and `display`. */
  heading: { fontFamily: fonts.semibold, fontSize: 18, lineHeight: 24, color: colors.text },
  /** A secondary paragraph at 13: hints, footnotes, fine print. Between `caption` and `bodySm`. */
  footnote: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
  /** The smallest eyebrow: ribbons, speaker labels, tight meta. */
  micro: {
    fontFamily: fonts.semibold,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: colors.textSecondary,
  },
} satisfies Record<string, TextStyle>;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  /** The funnel's `.onb-cta` - large buttons. */
  control: 14,
  lg: 16,
  xl: 20,
  pill: 999,
} as const;

/** The web's asymmetric silhouettes (`.shape-card`, `.shape-pill`, chat bubbles). */
export const shape = {
  card: { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderBottomRightRadius: 20, borderBottomLeftRadius: 4 },
  pill: { borderTopLeftRadius: 14, borderTopRightRadius: 14, borderBottomRightRadius: 14, borderBottomLeftRadius: 4 },
  bubbleLeft: { borderTopLeftRadius: 4, borderTopRightRadius: 18, borderBottomRightRadius: 18, borderBottomLeftRadius: 18 },
  bubbleRight: { borderTopLeftRadius: 18, borderTopRightRadius: 4, borderBottomRightRadius: 18, borderBottomLeftRadius: 18 },
} as const;

/** Minimum control heights. Minimums, not heights: a control grows with Dynamic Type. */
export const control = { lg: 52, md: 44, sm: 40 } as const;

/** Cap for tightly packed labels (badges, chips, segments) so they grow without breaking the row. */
export const MAX_FONT_SCALE = 1.6;

/**
 * Content cards are flat, like the web's `.glass` ("no drop shadow"); a shadow
 * is only for something that floats over the page - a popover, a callout.
 */
export const shadow = {
  pop: {
    shadowColor: '#0F172A',
    shadowOpacity: 0.12,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
} as const;

/**
 * The sentiment dot colour. An outcome is neutral information (a booking is not
 * "good news" to colour green in a list); sentiment is the one thing worth
 * tinting. For dots only - the neutral case is textMuted.
 */
export function sentimentColor(sentiment: string | null): string {
  switch (sentiment) {
    case 'positive':
      return colors.success;
    case 'negative':
    case 'angry':
      return colors.error;
    case 'frustrated':
      return colors.warning;
    default:
      return colors.textMuted;
  }
}
