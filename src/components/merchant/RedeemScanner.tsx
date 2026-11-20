'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { buttonClass } from '@/components/ui/Button';
import { Field, inputClass } from '@/components/ui/Field';
import { MAX_SCANNED_CODE_LENGTH } from '@/lib/redemption/rules';

/**
 * The scan screen — FR-601…FR-605.
 *
 * ## No QR library, by choice
 *
 * A QR decoder is 40–200 kB of JavaScript on a phone at a restaurant, and it runs
 * on a camera stream. The browser has `BarcodeDetector` in Chrome on Android and
 * Safari on iOS 17+, which is most of what a counter actually holds. Where it is
 * absent, the manual field is not a fallback that looks broken — it is the primary
 * input, because a printed code can be typed in eight seconds and the alternative
 * is installing 200 kB to save six of them.
 *
 * That decision is visible in the type below: `BarcodeDetector` is not in the DOM
 * lib, so its shape is declared locally and narrowed at runtime. Nothing in this
 * file pretends the API exists.
 *
 * ## Why the outcome is rendered from the server's `reason` and copy
 *
 * `REFUSAL_COPY` is exhaustive over `RefusalReason` and lives on the server. If
 * this component wrote its own sentences, the copy for `NOT_YOUR_DROP` and
 * `UNKNOWN_PARTICIPANT` would drift apart — and they are deliberately identical so
 * a valid code cannot be used to probe for drop ids. The screen renders what it is
 * told and adds only the layout.
 *
 * ## What a staff member sees, in order
 *
 * The result area sits **above** the input and is the tallest thing on the screen,
 * because the answer is the reason the person is standing there. It is also
 * announced with `aria-live="assertive"`: a counter is loud, and a staff member
 * who looks away while the fetch lands needs the answer read out.
 */

/** The response shapes from `POST /api/merchant/redeem`. */
type RedeemResponse =
  | {
      ok: true;
      outcome: 'REDEEMED';
      participantId: string;
      dropId: string;
      name: string | null;
      qty: number;
      taken: number;
      redeemedQty: number;
      remaining: number;
    }
  | {
      ok: true;
      outcome: 'PARTIAL';
      participantId: string;
      dropId: string;
      name: string | null;
      qty: number;
      taken: number;
      redeemedQty: number;
      remaining: number;
      reason: 'ALREADY_PARTLY_REDEEMED';
    }
  | {
      ok: true;
      outcome: 'ALREADY_REDEEMED';
      participantId: string;
      dropId: string;
      name: string | null;
      qty: number;
      redeemedQty: number;
      redeemedAt: string | null;
    }
  | {
      ok: false;
      outcome: 'REFUSED';
      reason: string;
      copy: { title: string; detail: string };
    };

type ScanState =
  | { kind: 'idle' }
  | { kind: 'scanning' }
  | { kind: 'result'; response: RedeemResponse; at: Date }
  | { kind: 'failed'; message: string };

/**
 * `BarcodeDetector` is not in TypeScript's DOM lib (it is a WICG draft, shipped in
 * two engines). Declared here rather than pulled in with `any`, so the one place it
 * is used has a shape to check.
 */
type DetectedBarcode = { rawValue: string };
type BarcodeDetectorLike = {
  detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]>;
};
type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

function barcodeDetectorCtor(): BarcodeDetectorCtor | null {
  const candidate = (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector;
  return typeof candidate === 'function' ? (candidate as BarcodeDetectorCtor) : null;
}

/** Plates, in words, because "3 plates" beats "qty 3" at a counter. */
function plates(count: number): string {
  return count === 1 ? '1 plate' : `${count} plates`;
}

function timeOf(iso: string | null, timeZone: string): string {
  if (!iso) return 'earlier';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'earlier';
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
    }).format(date);
  } catch {
    // An unknown IANA zone must not blank the answer. Falling back to the device
    // zone is still true, just less precise.
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
  }
}

export function RedeemScanner({ timeZone }: { timeZone: string }) {
  const [code, setCode] = useState('');
  const [state, setState] = useState<ScanState>({ kind: 'idle' });
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  /**
   * The submit. Guarded by a ref rather than by `state`, because two rapid
   * `onKeyDown` events in the same tick both read the old state. The server is
   * idempotent anyway — this only stops the screen from firing duplicate requests
   * and flickering between two answers.
   */
  const inFlight = useRef(false);

  /**
   * FR-606 — the idempotency key of the scan currently being retried.
   *
   * A `scanId` must be **stable across retries of the same scan**, because that is the
   * only thing that makes the server able to tell "the response was lost, try again"
   * from "the staff member scanned a second time". Generating one per `fetch` would
   * defeat the mechanism exactly when it is needed: the failure case.
   *
   * So the key is held here, keyed by the code it belongs to. A retry of the *same*
   * code reuses it; a different code (or a completed scan) gets a fresh one. `code`
   * is cleared on success, which naturally retires the key with it.
   */
  const pendingScan = useRef<{ code: string; scanId: string } | null>(null);

  const nextScanId = useCallback((forCode: string): string => {
    if (pendingScan.current !== null && pendingScan.current.code === forCode) {
      return pendingScan.current.scanId;
    }
    const scanId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pendingScan.current = { code: forCode, scanId };
    return scanId;
  }, []);

  const submit = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      if (trimmed.length === 0 || inFlight.current) return;

      inFlight.current = true;
      setState({ kind: 'scanning' });

      // Reused across retries of this code — see `pendingScan`.
      const scanId = nextScanId(trimmed);

      try {
        const response = await fetch('/api/merchant/redeem', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: trimmed, scanId }),
        });

        if (response.status === 401) {
          // A session that expired mid-shift is not a bad code, and dressing it up
          // as one teaches staff to re-scan instead of signing in.
          window.location.href = '/login';
          return;
        }

        const body: unknown = await response.json().catch(() => null);

        if (!response.ok || body === null) {
          const message =
            body && typeof body === 'object' && 'message' in body
              ? String((body as { message?: string }).message)
              : 'That could not be checked. Try again.';
          setState({ kind: 'failed', message });
          return;
        }

        setState({ kind: 'result', response: body as RedeemResponse, at: new Date() });
        // Cleared only on a successful round trip: a network failure leaves the
        // code on screen so it can be typed again rather than retyped.
        setCode('');
        // Retire the idempotency key with the code it belonged to. The next scan of
        // this code is a *new* human scan and must be allowed to take more plates.
        pendingScan.current = null;
      } catch {
        setState({ kind: 'failed', message: 'No connection. Check the code again in a moment.' });
      } finally {
        inFlight.current = false;
        inputRef.current?.focus();
      }
    },
    [],
  );

  // Stop the camera on unmount, or the torch stays lit in a pocket.
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  async function startCamera(): Promise<void> {
    const Detector = barcodeDetectorCtor();
    if (!Detector) {
      setCameraError('This browser cannot scan codes. Type the code instead.');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('This browser has no camera access. Type the code instead.');
      return;
    }

    setCameraError(null);
    setCameraOn(true);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // `environment` because the camera is pointed at a phone, not a face.
        video: { facingMode: 'environment' },
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play();

      const detector = new Detector({ formats: ['qr_code'] });

      const tick = async (): Promise<void> => {
        if (!streamRef.current) return;
        try {
          const found = await detector.detect(video);
          const first = found[0];
          if (first?.rawValue) {
            stopCamera();
            void submit(first.rawValue);
            return;
          }
        } catch {
          // A frame that cannot be decoded is the normal case in poor light. The
          // loop continues; a persistent failure shows up as nothing ever scanning,
          // which is why manual entry is always on screen.
        }
        rafRef.current = requestAnimationFrame(() => {
          void tick();
        });
      };
      void tick();
    } catch {
      setCameraOn(false);
      setCameraError('The camera could not be started. Type the code instead.');
    }
  }

  function stopCamera(): void {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraOn(false);
  }

  const canScan = barcodeDetectorCtor() !== null;

  return (
    <div className="space-y-4">
      <ResultPanel state={state} timeZone={timeZone} />

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit(code);
        }}
        className="space-y-3"
      >
        <Field
          id="redemption-code"
          label="Code"
          helper="Scan the diner's code, or type the letters after the last dot."
        >
          <input
            id="redemption-code"
            ref={inputRef}
            // `autoFocus` because this screen exists to receive one input, and a
            // phone that opens the keyboard saves an unglamorous second per diner.
            autoFocus
            value={code}
            onChange={(event) => setCode(event.target.value)}
            maxLength={MAX_SCANNED_CODE_LENGTH}
            // `off` everywhere: a code is not a name, and autocomplete on a shared
            // counter phone would offer the previous diner's code.
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            inputMode="text"
            className={inputClass}
            placeholder="v1.…"
          />
        </Field>

        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            className={buttonClass('primary', 'flex-1')}
            disabled={state.kind === 'scanning' || code.trim().length === 0}
          >
            {state.kind === 'scanning' ? 'Checking…' : 'Check and hand over'}
          </button>

          {canScan && !cameraOn ? (
            <button type="button" onClick={() => void startCamera()} className={buttonClass('secondary')}>
              Use camera
            </button>
          ) : null}

          {cameraOn ? (
            <button type="button" onClick={stopCamera} className={buttonClass('secondary')}>
              Stop camera
            </button>
          ) : null}
        </div>

        {cameraError ? <p className="text-sm text-thin">{cameraError}</p> : null}
      </form>

      {/*
        `playsInline` or iOS opens a full-screen player and takes the answer off
        screen. Muted because a camera that plays audio is alarming and, on some
        devices, blocks autoplay.
      */}
      <video
        ref={videoRef}
        playsInline
        muted
        className={cameraOn ? 'w-full rounded-xl bg-ink' : 'hidden'}
      />
    </div>
  );
}

function ResultPanel({ state, timeZone }: { state: ScanState; timeZone: string }) {
  if (state.kind === 'idle') {
    return (
      <div className="rounded-xl border border-slate-200 bg-surface-muted p-4 text-sm text-ink-soft">
        Nothing scanned yet.
      </div>
    );
  }

  if (state.kind === 'scanning') {
    return (
      <div className="rounded-xl border border-slate-200 bg-surface-muted p-4 text-sm text-ink-soft">
        Checking…
      </div>
    );
  }

  if (state.kind === 'failed') {
    return (
      <div aria-live="assertive" className="rounded-xl border-2 border-thin bg-thin/5 p-4">
        <p className="text-base font-semibold text-thin">Not checked</p>
        <p className="mt-1 text-sm text-ink-soft">{state.message}</p>
      </div>
    );
  }

  const { response } = state;

  // A refusal: the server sent the sentence, the screen lays it out.
  if (!response.ok) {
    return (
      <div aria-live="assertive" className="rounded-xl border-2 border-blocked bg-blocked/5 p-4">
        <p className="text-lg font-semibold text-blocked">{response.copy.title}</p>
        <p className="mt-1 text-sm text-ink-soft">{response.copy.detail}</p>
        <p className="mt-2 text-xs text-ink-soft">Do not hand over food.</p>
      </div>
    );
  }

  if (response.outcome === 'ALREADY_REDEEMED') {
    /**
     * FR-605: neutral, not red. The food is gone and the diner is not at fault,
     * and a red box at a counter starts an argument this screen cannot win.
     */
    return (
      <div aria-live="assertive" className="rounded-xl border-2 border-slate-300 bg-surface-muted p-4">
        <p className="text-lg font-semibold text-ink">Already collected</p>
        <p className="mt-1 text-sm text-ink-soft">
          {response.name ? `${response.name} — ` : ''}
          all {plates(response.qty)} were handed over at {timeOf(response.redeemedAt, timeZone)}.
        </p>
      </div>
    );
  }

  if (response.outcome === 'PARTIAL') {
    return (
      <div aria-live="assertive" className="rounded-xl border-2 border-thin bg-thin/5 p-4">
        <p className="text-lg font-semibold text-thin">Handed over {plates(response.taken)}</p>
        <p className="mt-1 text-sm text-ink-soft">
          {response.name ? `${response.name} — ` : ''}
          the rest of this order ({plates(response.qty - response.taken)}) was already collected.
        </p>
        <p className="mt-2 text-xs text-ink-soft">
          {response.redeemedQty} of {response.qty} now collected.
        </p>
      </div>
    );
  }

  return (
    <div aria-live="assertive" className="rounded-xl border-2 border-ok bg-ok/5 p-4">
      <p className="text-lg font-semibold text-ok">Handed over {plates(response.taken)}</p>
      <p className="mt-1 text-sm text-ink-soft">
        {response.name ? `${response.name} — ` : ''}
        {response.remaining === 0
          ? 'this order is complete.'
          : `${plates(response.remaining)} still to come on this order.`}
      </p>
      <p className="mt-2 text-xs text-ink-soft">
        {response.redeemedQty} of {response.qty} now collected.
      </p>
    </div>
  );
}
