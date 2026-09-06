import type { Config } from 'tailwindcss';

/**
 * Design tokens per HRMSPart1.md §7.
 *
 * We REPLACE (not extend) `colors`, `borderRadius`, and `boxShadow` so that
 * illegal utilities (`bg-purple-500`, `rounded-xl`, `shadow-lg`, …) don't
 * exist. A violation produces an invalid class rather than rendering wrong,
 * and the §14 grep test passes by omission.
 */
const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    // Full replacement — no purple/indigo/violet, no blue-grey neutral.
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      white: '#ffffff',
      black: '#000000',
      // Warm neutral ramp, 9 steps (not blue-grey).
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
      // Single gold accent. Two shades: base + a hover.
      gold: {
        DEFAULT: '#b8892b',
        hover: '#9c721f',
      },
      // Status encoding uses a 2px left border (see components/StatusRow).
      // One red for Overdue/Rejected/Absent; one amber for Pending/Late/Missing.
      red: '#a8321a',
      amber: '#c07a1a',
    },
    // Radius: 0 for table cells, 4px for buttons/inputs/cards/drawers. Nothing else.
    borderRadius: {
      none: '0',
      DEFAULT: '4px',
      sm: '4px',
      md: '4px',
    },
    // Only two elevation levels: flat (none), and drawer/modal.
    boxShadow: {
      none: 'none',
      drawer: '0 4px 16px rgba(0,0,0,0.08)',
    },
    // Type scale: 11 / 12 / 13 / 14 / 16 / 20 / 28. Nothing else.
    fontSize: {
      '11': ['11px', { lineHeight: '16px' }],
      '12': ['12px', { lineHeight: '16px' }],
      '13': ['13px', { lineHeight: '20px' }],
      '14': ['14px', { lineHeight: '20px' }],
      '16': ['16px', { lineHeight: '24px' }],
      '20': ['20px', { lineHeight: '28px' }],
      '28': ['28px', { lineHeight: '36px' }],
    },
    // Weights: 400 / 500 / 600. Never 700, never italic.
    fontWeight: {
      normal: '400',
      medium: '500',
      semibold: '600',
    },
    // Spacing scale: 4 / 8 / 12 / 16 / 24 / 32 / 48. (Keep pixel identifiers.)
    spacing: {
      0: '0',
      px: '1px',
      0.5: '2px',
      1: '4px',
      2: '8px',
      3: '12px',
      4: '16px',
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
