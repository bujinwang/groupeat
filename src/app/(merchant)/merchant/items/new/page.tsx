import Link from 'next/link';

import { ItemForm } from '@/components/items/ItemForm';

/**
 * `/merchant/items/new` — the dish form (PRD-sprint1 §6.3).
 *
 * The panel is empty until the dish has been saved once: an unsaved dish has no
 * id, so there is nothing to evaluate.
 */
export default function NewItemPage() {
  return (
    <div className="space-y-4">
      <div>
        <Link href="/merchant/items" className="text-sm text-ink-soft underline underline-offset-4">
          ← Dishes
        </Link>
        <h1 className="mt-2 text-lg font-semibold">New dish</h1>
      </div>
      <ItemForm />
    </div>
  );
}
