import type { ReactNode } from 'react';

/**
 * Small status chip. Tones match the panel's semantics: green works, amber thin,
 * red blocked, neutral informational.
 */
export type BadgeTone = 'ok' | 'thin' | 'blocked' | 'neutral';

const TONES: Record<BadgeTone, string> = {
  ok: 'bg-ok/10 text-ok',
  thin: 'bg-thin/10 text-thin',
  blocked: 'bg-blocked/10 text-blocked',
  neutral: 'bg-slate-100 text-ink-soft',
};

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}
