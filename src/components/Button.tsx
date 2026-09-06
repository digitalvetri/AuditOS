import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  children: ReactNode;
}

/**
 * §7: primary action is the gold button (max one per screen — that's a design
 * discipline, not a code check). Secondary is a bordered neutral. Ghost is
 * unadorned text.
 */
export function Button({ variant = 'secondary', className = '', children, ...rest }: Props) {
  const base =
    'inline-flex items-center justify-center h-8 px-3 text-13 font-medium rounded transition ' +
    'disabled:cursor-not-allowed disabled:opacity-50';
  const styles: Record<Variant, string> = {
    primary:
      'bg-gold text-white hover:bg-gold-hover',
    secondary:
      'bg-white text-neutral-900 border border-neutral-300 hover:bg-neutral-50',
    ghost: 'text-neutral-700 hover:text-neutral-900',
  };
  return (
    <button className={`${base} ${styles[variant]} ${className}`} {...rest}>
      {children}
    </button>
  );
}
