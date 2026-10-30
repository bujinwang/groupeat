import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * The only button style in the app. No component library (ARCHITECTURE-sprint1
 * Q-3): seven bespoke copy blocks and a 360px form do not need one.
 *
 * `min-h-11` keeps the tap target above 44px at 360px width (NFR-02).
 */

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'quiet';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-white hover:bg-brand-strong',
  secondary: 'border border-slate-300 bg-surface text-ink hover:bg-surface-muted',
  danger: 'bg-blocked text-white hover:opacity-90',
  quiet: 'text-ink-soft underline underline-offset-4 hover:text-ink',
};

export function buttonClass(variant: ButtonVariant = 'primary', extra = ''): string {
  return [
    'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium',
    'transition-colors disabled:cursor-not-allowed disabled:opacity-60',
    VARIANTS[variant],
    extra,
  ]
    .filter(Boolean)
    .join(' ');
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  children: ReactNode;
};

export function Button({ variant = 'primary', className = '', children, ...rest }: ButtonProps) {
  return (
    <button type="button" {...rest} className={buttonClass(variant, className)}>
      {children}
    </button>
  );
}
