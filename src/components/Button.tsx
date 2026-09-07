import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  children: ReactNode;
}

/**
 * §7 rule: at most one primary (gold) button per screen — that stays a
 * design discipline, not a lint. Sizes match the shell: `md` (default) is a
 * 40px pill that lines up with the topbar controls; `sm` is the 32px chip
 * used inside dense tables.
 */
export function Button({
  variant = 'secondary', size = 'md', className = '', children, ...rest
}: Props) {
  const sizing = size === 'md'
    ? 'h-10 px-5 text-14 rounded-md'
    : 'h-8 px-3 text-13 rounded';
  const base =
    'inline-flex items-center justify-center font-medium transition-colors ' +
    'disabled:cursor-not-allowed disabled:opacity-50';
  const styles: Record<Variant, string> = {
    primary:
      'bg-gold text-white hover:bg-gold-hover shadow-card',
    secondary:
      'bg-surface text-ink border border-border hover:bg-canvas',
    ghost:
      'text-inkMuted hover:text-ink hover:bg-canvas',
    danger:
      'bg-surface text-danger border border-border hover:bg-canvas',
  };
  return (
    <button className={`${base} ${sizing} ${styles[variant]} ${className}`} {...rest}>
      {children}
    </button>
  );
}
