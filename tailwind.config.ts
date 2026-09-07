import type { Config } from 'tailwindcss';

/**
 * Design tokens.
 *
 *   Base palette (HRMSPart1.md §7): warm neutral ramp + single gold, radius 4,
 *   flat elevation. Existing HRMS/Workstation modules render against these.
 *
 *   New shell + dashboard palette (UI-BUILD-PROMPT.md §1): sage green sidebar,
 *   canvas off-white surface, gold accent, filled-pill active state, radius
 *   10 on cards. Additive to the base — old modules keep working.
 *
 * We REPLACE (not extend) `colors`, `borderRadius`, and `boxShadow` so that
 * illegal utilities (`bg-purple-500`, `rounded-xl`, `shadow-lg`, …) don't
 * exist. A violation produces an invalid class rather than rendering wrong.
 */
const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    // Full replacement — no purple/indigo/violet.
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      white: '#ffffff',
      black: '#000000',

      // ── Base (§7) ──────────────────────────────────────────────────────
      neutral: {
        50: '#faf9f7',
        100: '#f3f1ed',
        200: '#e6e2db',
        300: '#d0cabf',
        400: '#a8a196',
        500: '#7a736a',
        600: '#585249',
        700: '#3f3a33',
        800: '#28251f',
        900: '#171512',
      },

      // ── Shell / dashboard palette (UI-BUILD-PROMPT §1) ─────────────────
      sidebar:       '#4F6B52', // deep sage green — sidebar background
      sidebarHover:  '#5C7A5F',
      sidebarActive: '#6B8A6E', // filled active pill
      sidebarText:   '#EAF0EA',
      sidebarMuted:  '#B8CCBA',

      canvas:        '#F7F6F2', // page background, warm off-white
      surface:       '#FFFFFF',
      border:        '#E8E6DF',

      ink:           '#1A1A18',
      inkMuted:      '#6B6B63',
      inkFaint:      '#9A9A90',

      // Semantic. `warning` and `success` intentionally alias to gold+sage
      // per the prompt so the palette stays lean.
      danger:        '#B33A2B',
      warning:       '#C8952E',
      success:       '#4F6B52',

      // Gold accent — used across BOTH palettes.
      gold: {
        DEFAULT: '#C8952E',
        hover:   '#B0821F',
      },

      // Legacy §7 status colours — kept for existing modules' left-border
      // encoding. Aliased to danger/warning for consistency.
      red:   '#B33A2B',
      amber: '#C8952E',
    },

    // Radius: 4px for base components, 8px for shell inputs/buttons/nav pills,
    // 10px for cards. Nothing else.
    borderRadius: {
      none: '0',
      DEFAULT: '4px',
      sm: '4px',
      md: '8px',
      lg: '10px',
    },

    // Elevation levels.
    boxShadow: {
      none: 'none',
      card:    '0 1px 2px rgba(0,0,0,0.04)',
      raised:  '0 2px 8px rgba(0,0,0,0.06)',   // dropdowns/modals only
      drawer:  '0 4px 16px rgba(0,0,0,0.08)',  // legacy — kept for existing modals
    },

    // Type scale: 11 / 12 / 13 / 14 / 16 / 20 / 28 / 34. Nothing else.
    fontSize: {
      '11': ['11px', { lineHeight: '16px' }],
      '12': ['12px', { lineHeight: '16px' }],
      '13': ['13px', { lineHeight: '20px' }],
      '14': ['14px', { lineHeight: '20px' }],
      '16': ['16px', { lineHeight: '24px' }],
      '20': ['20px', { lineHeight: '28px' }],
      '28': ['28px', { lineHeight: '36px' }],
      '34': ['34px', { lineHeight: '42px' }], // hero ledger figure (§5)
    },

    // Weights: 400 / 500 / 600. Never 700, never italic.
    fontWeight: {
      normal: '400',
      medium: '500',
      semibold: '600',
    },

    // Spacing scale: 4 / 8 / 12 / 16 / 20 / 24 / 32 / 48.
    spacing: {
      0: '0',
      px: '1px',
      0.5: '2px',
      1: '4px',
      2: '8px',
      3: '12px',
      4: '16px',
      5: '20px',   // added for the shell (24 gutter, 20 grid gap, 20 padding)
      6: '24px',
      8: '32px',
      12: '48px',
    },

    extend: {
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'sans-serif',
        ],
      },
      borderWidth: {
        DEFAULT: '1px',
        0: '0',
        2: '2px',
      },
      transitionDuration: {
        DEFAULT: '150ms',
      },
      transitionTimingFunction: {
        DEFAULT: 'cubic-bezier(0, 0, 0.2, 1)', // ease-out
      },
    },
  },
  plugins: [],
};

export default config;
