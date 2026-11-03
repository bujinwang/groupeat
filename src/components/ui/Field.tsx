import { cloneElement, isValidElement, type ReactNode } from 'react';

/**
 * A labelled form field with helper text and an optional error.
 *
 * The label is the merchant-facing wording from PRD-sprint1 §5.1 — the technical
 * field name must never appear on screen.
 *
 * ## Why the child is cloned to carry `aria-describedby`
 *
 * The error and helper paragraphs are rendered *by this component*, and their ids are derived
 * from `id` — but the `<input>` is rendered by the caller, so nothing connected the two. Before
 * this, exactly **one of the 52 `<Field>` call sites in the repo** passed `aria-describedby`,
 * and that one (`/login`) points at the standalone alert, not at a field error. So on every
 * other form a screen-reader user was told the field was invalid and never told why: the
 * sentence existed in the DOM, adjacent, unassociated.
 *
 * Found while probing `/change-password`: a mutation that deleted the field-error association
 * changed no assertion, because no assertion could exist. The fix is one line here rather than
 * 52 at the call sites, and it cannot regress silently — `renderWithSearchParams`'s suites and
 * the change-password render both assert field markup.
 *
 * `cloneElement` rather than a render prop because every call site already passes exactly one
 * element as children, and a render prop would be a 52-file refactor for a wiring detail. The
 * existing `aria-describedby` is **kept and extended** rather than replaced, so a caller that
 * points at its own element (like `/login`'s alert) does not lose it.
 */
export function Field({
  id,
  label,
  helper,
  error,
  children,
}: {
  id: string;
  label: string;
  helper?: ReactNode;
  error?: string | null;
  children: ReactNode;
}) {
  // Only the ids that will actually be in the DOM. Pointing at an id that was never rendered
  // is worse than pointing at nothing: the reader announces a gap.
  const describedBy = [error ? `${id}-error` : null, helper ? `${id}-helper` : null].filter(
    (value): value is string => value !== null,
  );

  const control = isValidElement<{ 'aria-describedby'?: string }>(children)
    ? cloneElement(children, {
        'aria-describedby': [children.props['aria-describedby'], ...describedBy]
          .filter(Boolean)
          .join(' ') || undefined,
      })
    : children;

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
      </label>
      {control}
      {error ? (
        <p id={`${id}-error`} className="text-sm text-blocked">
          {error}
        </p>
      ) : null}
      {helper ? (
        <p id={`${id}-helper`} className="text-xs leading-relaxed text-ink-soft">
          {helper}
        </p>
      ) : null}
    </div>
  );
}

export const inputClass =
  'block w-full rounded-lg border border-slate-300 bg-surface px-3 py-2.5 text-base text-ink ' +
  'placeholder:text-slate-400 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20 ' +
  'disabled:bg-surface-muted disabled:text-ink-soft';

export const inputErrorClass = 'border-blocked focus:border-blocked focus:ring-blocked/20';
