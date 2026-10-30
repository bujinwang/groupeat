import { Card } from '@/components/ui/Card';

/**
 * `/organiser` — the Sprint 1 placeholder (US-O1).
 *
 * An organiser can sign in and see this, and can reach nothing else: the layout
 * gates the role and middleware sends them here. Share links and drop ranking are
 * M7.
 */

export default function OrganiserHomePage() {
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Your organiser page</h1>
      <Card>
        <p className="text-sm leading-relaxed text-ink-soft">
          Share links, your drops and your commission arrive in a later release. For now there is
          nothing here to manage — if you were expecting a drop to share, ask the restaurant to send
          it to you directly.
        </p>
      </Card>
    </div>
  );
}
