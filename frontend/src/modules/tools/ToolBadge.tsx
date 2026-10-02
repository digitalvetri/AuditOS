import type { ToolDefinition } from './registry';

/**
 * The ~40px tinted square at the top-left of every card and workspace.
 * Tints are inline (the Tailwind palette is deliberately locked to the
 * CRM's neutrals + gold, so a green/blue/indigo/rose utility does not exist).
 */
const TINTS: Record<ToolDefinition['badge']['tint'], { bg: string; fg: string }> = {
  green:  { bg: '#E4F0E6', fg: '#2F6B3A' },
  blue:   { bg: '#E2ECF7', fg: '#2B5797' },
  indigo: { bg: '#E7E7F6', fg: '#4A4A9C' },
  amber:  { bg: '#FBF0DA', fg: '#8A6212' },
  rose:   { bg: '#F8E3E6', fg: '#A33A4A' },
};

export function ToolBadge({ badge, size = 40 }: { badge: ToolDefinition['badge']; size?: number }) {
  const tint = TINTS[badge.tint];
  const Icon = badge.icon;
  return (
    <span
      className="inline-flex items-center justify-center shrink-0 rounded font-mono font-semibold uppercase select-none"
      style={{ width: size, height: size, background: tint.bg, color: tint.fg, fontSize: 9, letterSpacing: '0.02em', lineHeight: 1 }}
      aria-hidden
    >
      {Icon ? <Icon size={18} strokeWidth={1.75} /> : badge.text}
    </span>
  );
}
