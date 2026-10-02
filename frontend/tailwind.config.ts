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
 * Every colour is an `rgb(var(--c-…) / <alpha-value>)` reference; the light
 * and dark triplets live in src/design/globals.css so a theme switch is one
 * attribute on <html> and zero component edits.
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
      white: 'rgb(var(--c-white) / <alpha-value>)',
      black: 'rgb(var(--c-black) / <alpha-value>)',

      // ── Base (§7) ──────────────────────────────────────────────────────
      neutral: {
        50: 'rgb(var(--c-neutral-50) / <alpha-value>)',
        100: 'rgb(var(--c-neutral-100) / <alpha-value>)',
        200: 'rgb(var(--c-neutral-200) / <alpha-value>)',
        300: 'rgb(var(--c-neutral-300) / <alpha-value>)',
        400: 'rgb(var(--c-neutral-400) / <alpha-value>)',
        500: 'rgb(var(--c-neutral-500) / <alpha-value>)',
        600: 'rgb(var(--c-neutral-600) / <alpha-value>)',
        700: 'rgb(var(--c-neutral-700) / <alpha-value>)',
        800: 'rgb(var(--c-neutral-800) / <alpha-value>)',
        900: 'rgb(var(--c-neutral-900) / <alpha-value>)',
      },

      // ── Shell / dashboard palette (UI-BUILD-PROMPT §1) ─────────────────
      // Target ref (Screenshot 214422) — LIGHT mint sage, DARKER sage
      // filled pill for the active row (not white). Section headers stay
      // as dark forest at reduced weight rather than muted grey-green.
      // Primary action surface — same navy as the sidebar rail.
      primary:       'rgb(var(--c-primary) / <alpha-value>)',
      primaryHover:  'rgb(var(--c-primary-hover) / <alpha-value>)',
      sidebar:       'rgb(var(--c-sidebar) / <alpha-value>)', // light mint sage — sidebar background
      sidebarHover:  'rgb(var(--c-sidebarHover) / <alpha-value>)',
      sidebarActive: 'rgb(var(--c-sidebarActive) / <alpha-value>)', // filled darker sage pill for active row
      sidebarText:   'rgb(var(--c-sidebarText) / <alpha-value>)', // near-black forest — nav labels
      sidebarMuted:  'rgb(var(--c-sidebarMuted) / <alpha-value>)', // section headers — dark, not muted

      canvas:        'rgb(var(--c-canvas) / <alpha-value>)', // page background, warm off-white
      surface:       'rgb(var(--c-surface) / <alpha-value>)',
      border:        'rgb(var(--c-border) / <alpha-value>)',

      ink:           'rgb(var(--c-ink) / <alpha-value>)',
      inkMuted:      'rgb(var(--c-inkMuted) / <alpha-value>)',
      inkFaint:      'rgb(var(--c-inkFaint) / <alpha-value>)',

      // Semantic. `warning` and `success` intentionally alias to gold+sage
      // per the prompt so the palette stays lean.
      danger:        'rgb(var(--c-danger) / <alpha-value>)',
      warning:       'rgb(var(--c-warning) / <alpha-value>)',
      success:       'rgb(var(--c-success) / <alpha-value>)',

      // Gold accent — used across BOTH palettes.
      gold: {
        DEFAULT: 'rgb(var(--c-gold) / <alpha-value>)',
        hover:   'rgb(var(--c-gold-hover) / <alpha-value>)',
      },

      // Legacy §7 status colours — kept for existing modules' left-border
      // encoding. Aliased to danger/warning for consistency.
      red:   'rgb(var(--c-red) / <alpha-value>)',
      amber: 'rgb(var(--c-amber) / <alpha-value>)',
    },

    // Radius: 4px for base components, 8px for shell inputs/buttons/nav pills,
    // 10px for cards. Nothing else.
    borderRadius: {
      none: '0',
      DEFAULT: '4px',
      sm: '4px',
      md: '8px',
      lg: '10px',
      // Pills and circles: avatars, the search field, unread counts, progress
      // tracks. Thirteen call sites across the app already wrote
      // `rounded-full` — with the scale closed it silently resolved to
      // nothing and they rendered square. This is a named token, not a hole:
      // the scale still refuses `rounded-xl` and friends.
      full: '9999px',
    },

    // Elevation levels.
    boxShadow: {
      none: 'none',
      card:    '0 1px 2px rgba(0,0,0,0.04)',
      raised:  '0 2px 8px rgba(0,0,0,0.06)',   // dropdowns/modals only
      drawer:  '0 4px 16px rgba(0,0,0,0.08)',  // legacy — kept for existing modals
    },

    // Type scale: 11 / 12 / 13 / 14 / 15 / 16 / 18 / 20 / 28 / 34. Nothing else.
    fontSize: {
      '11': ['11px', { lineHeight: '16px' }],
      '12': ['12px', { lineHeight: '16px' }],
      '13': ['13px', { lineHeight: '20px' }],
      '14': ['14px', { lineHeight: '20px' }],
      '15': ['15px', { lineHeight: '22px' }], // sidebar nav labels
      '16': ['16px', { lineHeight: '24px' }],
      '18': ['18px', { lineHeight: '26px' }], // brand wordmark, module titles
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

    // Spacing scale — 4px grid. Includes the sizes used by the shell
    // (chips 32/36/40/44, rows 32/40/44/48, header 80/96, sidebar 264).
    // Anything outside this list is a mistake; use `text-N` / `p-N`
    // exactly from here so alignment stays predictable.
    spacing: {
      0:    '0',
      px:   '1px',
      0.5:  '2px',
      1:    '4px',
      2:    '8px',
      3:    '12px',
      4:    '16px',
      5:    '20px',
      6:    '24px',
      7:    '28px',
      8:    '32px',
      9:    '36px',
      10:   '40px',
      11:   '44px',
      12:   '48px',
      14:   '56px',
      16:   '64px',
      18:   '72px',
      20:   '80px',
      24:   '96px',
      28:   '112px',
      32:   '128px',
      40:   '160px',
      48:   '192px',
      56:   '224px',
      64:   '256px',
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
