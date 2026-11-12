import { beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/lib/logging/logger';

import { loggingSender, recordingSender } from '../sender';
import type { NotificationMessage } from '../copy';

/**
 * The two senders — the one every deployment uses today, and the one every test uses.
 *
 * ## The hole this closes, measured
 *
 * V8 coverage over the full 2 764-test suite: `src/lib/notify/sender.ts` executed
 * **31 of 59 statements**. Uncovered lines were 97–124 and 150–159. Translated out of
 * line numbers: `loggingSender().send()` — the sender `resolveSender()` returns on
 * every deployment without Twilio credentials, which is every deployment today — had
 * **never run**, and `recordingSender().failNext()` had **never been called**.
 *
 * ## Why nothing noticed
 *
 * Both functions are reachable, and both are widely *referenced*, which is exactly why
 * this survived four sessions of coverage work. `recordingSender()` is imported by
 * eight test files and exercised heavily; `failNext` is a second property on the same
 * object and nobody happened to need it here — `digest-run.test.ts` calls
 * `failNext(1)` on a *different* recorder (`recordingEmailSender`, a separate type in
 * `email-sender.ts`), and `twilio-sender.test.ts` asserts `resolveSender({}).name ===
 * 'logging'` without ever calling `send` on what it got back.
 *
 * So the shape of the gap is worth naming, because it is subtler than "untested file":
 * **the object was tested, the function was not.** A coverage number per *file* would
 * have shown 52 % and invited a shrug; per *function* it is two zeroes.
 *
 * ## Why these two and not a third
 *
 * `loggingSender` is the production fallback, and its contract is unusual enough to be
 * worth pinning: it must **never throw** and it must report `NOT_CONFIGURED` *per
 * message* rather than merely failing. `failNext` exists, in its own docblock's words,
 * "so the 'must not throw' rule can be tested from the caller's side" — a tool built
 * for a test that was never written. Both are the same defect this repo keeps finding:
 * a docblock asserting a property that nothing pins.
 *
 * ## What is mocked, and only this
 *
 * The logger. `loggingSender`'s entire observable output is one `logger.warn` call, so
 * if the logger is real the function is a black box that prints to stdout. Replacing
 * it makes the *reason*, the *total* and the *per-kind counts* assertable — and those
 * three are the whole content of the log line.
 */

vi.mock('@/lib/logging/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const warn = vi.mocked(logger.warn);

/** A message. `phone` is present because the type requires it and must never be logged. */
function message(kind: string, phone = '+14035550100'): NotificationMessage {
  return { kind, phone, body: `body for ${kind}` };
}

beforeEach(() => {
  warn.mockClear();
});

describe('loggingSender · the sender every deployment actually gets', () => {
  it('reports NOT_CONFIGURED per message, and counts every one as failed', async () => {
    // Per message, not per batch. The job's JSON response is built from `outcomes`,
    // so a sender that returned one aggregate outcome would make "14 of 16 sent"
    // unrepresentable — the exact reporting failure the module docblock describes.
    const result = await loggingSender().send([message('drop_locked'), message('pickup_soon')]);

    expect(result.sentCount).toBe(0);
    expect(result.failedCount).toBe(2);
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes.map((outcome) => outcome.kind)).toEqual([
      'drop_locked',
      'pickup_soon',
    ]);
    for (const outcome of result.outcomes) {
      expect(outcome.sent).toBe(false);
      expect(outcome.reason).toBe('NOT_CONFIGURED');
    }
  });

  it('never claims a provider id, because nothing was sent', async () => {
    // `providerId` is the only way to ask the provider "did this go out". Inventing
    // one here would be worse than omitting it: ops would query Twilio for a sid that
    // was never issued and conclude the message was lost rather than never attempted.
    const result = await loggingSender().send([message('drop_locked')]);

    expect(result.outcomes[0]?.providerId).toBeUndefined();
  });

  it('groups the log line by kind, so a batch of 40 writes one line and not forty', async () => {
    // The counting is the whole reason the grouping loop exists. Three messages, two
    // of one kind: `{ drop_locked: 2, pickup_soon: 1 }`.
    await loggingSender().send([
      message('drop_locked'),
      message('drop_locked'),
      message('pickup_soon'),
    ]);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('notification.not_sent', {
      reason: 'NOT_CONFIGURED',
      total: 3,
      kinds: { drop_locked: 2, pickup_soon: 1 },
    });
  });

  it('logs nothing and warns nobody when there is nothing to send', async () => {
    // The early return. Without it, an empty batch writes a `total: 0` warning on
    // every cutoff tick for every drop with no participants — noise that trains an
    // operator to ignore the one line that matters when a real batch fails.
    const result = await loggingSender().send([]);

    expect(result).toEqual({ outcomes: [], sentCount: 0, failedCount: 0 });
    expect(warn).not.toHaveBeenCalled();
  });

  it('never puts a phone number or a body into the log line', async () => {
    // §11.7 and AC-12. The body of a join confirmation carries a bearer token, and
    // `phone` is E.164. Asserted on the serialised argument rather than field by
    // field, so a future field added to the log payload is caught too.
    const phone = '+14035559999';
    await loggingSender().send([{ kind: 'join_confirmed', phone, body: 'token=SECRET123' }]);

    const serialised = JSON.stringify(warn.mock.calls);
    expect(serialised).not.toContain(phone);
    expect(serialised).not.toContain('SECRET123');
  });

  it('does not throw, which is the one rule the docblock states twice', async () => {
    // Called from the cutoff job after money has moved. A throw here would turn a
    // successful capture into a 500 the scheduler retries, and the retry re-enters
    // settlement for a drop already charged. So: resolves, always.
    await expect(loggingSender().send([message('drop_locked')])).resolves.toBeDefined();
  });
});

describe('recordingSender · failNext is the half that was never called', () => {
  it('records what it was given and reports both messages sent', async () => {
    const sender = recordingSender();
    const result = await sender.send([message('a'), message('b')]);

    expect(sender.sent).toHaveLength(2);
    expect(result.sentCount).toBe(2);
    expect(result.failedCount).toBe(0);
  });

  it('fails exactly the next N messages, then succeeds again', async () => {
    // `failNext`'s purpose is to let a caller-side test prove a rejection becomes a
    // `SendResult` instead of an exception. That only holds if the failure is
    // *bounded* — an unbounded failure mode would make the recovery path untestable
    // and the counter meaningless.
    const sender = recordingSender();
    sender.failNext(1);

    const first = await sender.send([message('a'), message('b')]);
    expect(first.outcomes.map((outcome) => outcome.sent)).toEqual([false, true]);
    expect(first.failedCount).toBe(1);
    expect(first.outcomes[0]?.reason).toBe('PROVIDER_ERROR');
    expect(sender.sent.map((entry) => entry.kind)).toEqual(['b']);

    // The budget is spent: the next send is clean, and nothing is recorded twice.
    const second = await sender.send([message('c')]);
    expect(second.sentCount).toBe(1);
    expect(sender.sent.map((entry) => entry.kind)).toEqual(['b', 'c']);
  });

  it('fails a whole batch without throwing, so the caller always gets a result', async () => {
    // The "must not throw" rule proved from the caller's side, which is the reason
    // `failNext` exists at all.
    const sender = recordingSender();
    sender.failNext(2);

    const result = await sender.send([message('a'), message('b')]);

    expect(result).toEqual({
      outcomes: [
        { kind: 'a', sent: false, reason: 'PROVIDER_ERROR' },
        { kind: 'b', sent: false, reason: 'PROVIDER_ERROR' },
      ],
      sentCount: 0,
      failedCount: 2,
    });
    expect(sender.sent).toHaveLength(0);
  });

  it('does not record a failed message, so a caller cannot mistake it for delivered', async () => {
    // `sender.sent` is the evidence a caller asserts against. A failed message
    // appearing there would make every notification test that checks `sent` weaker
    // than it looks — green while nothing arrived.
    const sender = recordingSender();
    sender.failNext(1);

    await sender.send([message('failed_one'), message('ok_one')]);

    expect(sender.sent.map((entry) => entry.kind)).toEqual(['ok_one']);
  });
});

describe('the two senders agree about what a SendResult is', () => {
  it('both satisfy the interface the job consumes, including an empty batch', async () => {
    // The contract is `NotificationSender`, and the job must not care which one it
    // holds. Asserted structurally on the result rather than by importing the type,
    // because a type can be satisfied nominally by an object that lies at runtime.
    for (const sender of [loggingSender(), recordingSender()]) {
      const result = await sender.send([]);
      expect(result).toHaveProperty('outcomes');
      expect(result).toHaveProperty('sentCount');
      expect(result).toHaveProperty('failedCount');
      expect(result.sentCount + result.failedCount).toBe(result.outcomes.length);
    }
  });

  it('keeps sentCount + failedCount equal to the number of messages in every case', async () => {
    // The one invariant a caller may rely on when it reports "N of M". True for a
    // clean batch, a partial failure and a total failure.
    const messages = [message('a'), message('b'), message('c')];

    const clean = await recordingSender().send(messages);
    const partial = recordingSender();
    partial.failNext(1);
    const partialResult = await partial.send(messages);
    const total = recordingSender();
    total.failNext(3);
    const totalResult = await total.send(messages);
    const log = await loggingSender().send(messages);

    for (const result of [clean, partialResult, totalResult, log]) {
      expect(result.sentCount + result.failedCount).toBe(3);
      expect(result.outcomes).toHaveLength(3);
    }
  });
});
