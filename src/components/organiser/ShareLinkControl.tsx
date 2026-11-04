'use client';

import { useActionState, useEffect, useState } from 'react';

import { Button } from '@/components/ui/Button';
import { shareMessageFor, shareUrlFor } from '@/lib/organisers/share-link';

import { getShareLinkAction, type ShareLinkState } from '@/app/(organiser)/organiser/actions';
import { useLiveCount } from './LiveProgress';

/**
 * FR-802 — "Get share link", in two taps.
 *
 * > `FR-802 | "Get share link" generates unique token, 2 taps max | Link + copyable
 * > pre-written message` — PRD-v1.md:537
 *
 * ## The two taps
 *
 *   1. **Get share link** — a server action mints the row and re-renders with the token.
 *   2. **Copy message** — the pre-written message, link included, to the clipboard.
 *
 * The second tap is the one that matters. An organiser is standing in a WeChat group
 * composing a message on a phone; if step two were "select this text and copy it", the
 * feature would technically have two taps and practically have five.
 *
 * ## Why the token arrives two different ways
 *
 * `existingToken` is what the server rendered: an organiser returning to this page
 * already has a link and must see it immediately, not be offered to "get" one again.
 * `state.token` is what the action just minted. `state.token ?? existingToken` resolves
 * them in that order — the newer value wins, and after the revalidation both agree.
 *
 * ## Why the message is composed here rather than on the server
 *
 * Because it must include the token, and the token may not exist until the tap. The
 * formatter is pure (`lib/organisers/share-link.ts`), so composing it in the browser
 * produces byte-identical text to composing it on the server — and there is no second
 * implementation to drift.
 */
export type ShareLinkControlProps = {
  readonly dropId: string;
  readonly publicCode: string;
  readonly origin: string | undefined;
  readonly title: string;
  readonly merchantName: string;
  readonly dealPriceCents: number;
  readonly menuPriceCents: number;
  readonly minQty: number;
  readonly joinedQty: number;
  readonly cutoffAt: Date;
  readonly timeZone: string;
  readonly existingToken: string | null;
  readonly existingClicks: number;
};

const INITIAL: ShareLinkState = { error: null, token: null };

type CopyState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'copied'; readonly what: 'message' | 'link' }
  | { readonly kind: 'failed' };

/**
 * Copy with a visible acknowledgement, because a silent copy looks broken.
 *
 * Three outcomes, not two: copied, failed, and not-yet. A browser that refuses the
 * clipboard (an insecure context, a denied permission) must not look like a success —
 * the organiser would paste nothing into their group and never learn why.
 */
function useCopy(): { state: CopyState; copy: (text: string, what: 'message' | 'link') => void } {
  const [state, setState] = useState<CopyState>({ kind: 'idle' });

  useEffect(() => {
    if (state.kind !== 'copied') {
      return;
    }
    const timer = setTimeout(() => setState({ kind: 'idle' }), 2000);
    return () => clearTimeout(timer);
  }, [state]);

  function copy(text: string, what: 'message' | 'link'): void {
    navigator.clipboard.writeText(text).then(
      () => setState({ kind: 'copied', what }),
      () => setState({ kind: 'failed' }),
    );
  }

  return { state, copy };
}

export function ShareLinkControl(props: ShareLinkControlProps) {
  const [state, formAction, pending] = useActionState(getShareLinkAction, INITIAL);
  const { state: copyState, copy } = useCopy();
  // FR-803's live count, when this card is inside the provider. The message quotes the
  // joined count, so a copy taken after the poll must not paste last render's number.
  // Outside the provider (a test, or a future caller) this is `null` and the server's
  // value is used, which is the same fallback every other field already has.
  const live = useLiveCount(props.dropId);
  const joinedQty = live?.joinedQty ?? props.joinedQty;

  const token = state.token ?? props.existingToken;

  if (token === null) {
    return (
      <form action={formAction} className="space-y-2">
        <input type="hidden" name="dropId" value={props.dropId} />
        <Button type="submit" disabled={pending}>
          {pending ? 'Getting link…' : 'Get share link'}
        </Button>
        {state.error ? (
          <p role="alert" className="text-xs text-blocked">
            {state.error}
          </p>
        ) : null}
      </form>
    );
  }

  const url = shareUrlFor({ publicCode: props.publicCode, token, origin: props.origin });
  const message = shareMessageFor({
    title: props.title,
    merchantName: props.merchantName,
    dealPriceCents: props.dealPriceCents,
    menuPriceCents: props.menuPriceCents,
    minQty: props.minQty,
    joinedQty,
    cutoffAt: props.cutoffAt,
    timeZone: props.timeZone,
    url,
  });

  return (
    <div className="space-y-2">
      <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-surface-muted p-2 text-xs leading-relaxed">
        {message}
      </pre>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => copy(message, 'message')}>
          {copyState.kind === 'copied' && copyState.what === 'message' ? 'Copied' : 'Copy message'}
        </Button>
        <button
          type="button"
          onClick={() => copy(url, 'link')}
          className="text-xs text-ink-soft underline underline-offset-2"
        >
          {copyState.kind === 'copied' && copyState.what === 'link' ? 'Link copied' : 'Copy link only'}
        </button>
        {props.existingClicks > 0 ? (
          <span className="text-[10px] tabular-nums text-ink-soft">
            {props.existingClicks} {props.existingClicks === 1 ? 'open' : 'opens'} so far
          </span>
        ) : null}
      </div>

      {props.origin === undefined ? (
        <p className="text-[10px] leading-relaxed text-thin">
          {/* The deployment has no usable APP_URL, so the link is relative and will not
              work when pasted into a chat. Saying so beats an organiser discovering it
              after their group taps a dead link. */}
          This link is relative because the app’s public address is not configured. It
          will work only on this machine.
        </p>
      ) : null}

      {copyState.kind === 'failed' ? (
        <p role="alert" className="text-[10px] text-thin">
          Your browser refused the clipboard. Select the text above and copy it manually.
        </p>
      ) : null}
    </div>
  );
}
