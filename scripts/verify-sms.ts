/**
 * Proves — or fails to prove — that SMS delivery works, against real Twilio.
 *
 *   npx tsx --conditions=react-server scripts/verify-sms.ts +14035551234
 *   npx tsx --conditions=react-server scripts/verify-sms.ts +14035551234 --dry
 *
 * ## Why this exists
 *
 * `twilio-sender.ts` has never been executed against Twilio. Its own header says so,
 * in the same terms `real-charge-port.ts` uses, and until a message arrives on a
 * phone that header stays true. Every test in the suite stubs `fetch`; not one of
 * them can tell you whether Twilio accepts our form encoding, our auth header, or
 * our sender.
 *
 * This is the smallest thing that can answer that: compose the real FR-506 message,
 * send it through the real sender, then **ask Twilio what became of it**.
 *
 * ## Why it asks afterwards, instead of trusting the 201
 *
 * Because a `201` does not mean a phone rang. On a Canadian number with an
 * unregistered sender, Twilio accepts the message, bills for it, and the carrier
 * silently filters it — no error, no bounce, nothing in the response. D-5 says
 * "verify Canadian sender ID" and this is the only check that verifies it.
 *
 * So the script re-reads the message resource a few seconds later and prints the
 * carrier status. `delivered` is proof. `sent` is progress. `queued` past a minute is
 * a smell. `failed`/`undelivered` with an error code is the answer, and it names the
 * code so the next step is a search rather than a guess.
 *
 * ## What it costs and what it touches
 *
 * It sends **one** message to a number you name, using the credentials in `.env`. It
 * writes nothing to the database, charges nothing, and is not imported by the app.
 * `--dry` composes and prints the body without contacting Twilio at all, which is the
 * right first run: it shows you exactly what a diner would read.
 *
 * ## Why `--conditions=react-server`
 *
 * `twilio-sender.ts` imports `server-only`, which resolves to a module that throws
 * outside the React server graph. That guard is correct and should stay; this flag
 * makes the module resolve as it does inside a Server Component, which is the only
 * context it is ever meant to run in. Without it the import fails before `main()`.
 */
import 'dotenv/config';

import { compose } from '../src/lib/notify/compose-port';
import { resolveSender, twilioConfigFrom } from '../src/lib/notify/twilio-sender';
import type { NotifyIntent } from '../src/lib/settlement/notify-port';

/**
 * The message a diner actually receives after a drop fills.
 *
 * Deliberately the real intent rather than a hand-written "test message": the point
 * is to prove *this* sentence survives the round trip — money, window, code and link
 * — not that Twilio can carry the word "hello". A hand-written body would skip the
 * composer, which is where a bug would live.
 */
function sampleIntent(phone: string): NotifyIntent {
  // A fixed instant, so two runs are comparable. The zone is a real merchant's.
  const windowStart = new Date('2026-11-05T20:00:00Z');
  const windowEnd = new Date('2026-11-05T22:00:00Z');

  return {
    kind: 'DROP_CONFIRMED_CHARGED',
    dropId: 'drop_verify_sms',
    participantId: 'participant_verify_sms',
    phone,
    chargedCents: 5240,
    qty: 2,
    // Shaped like a real code (`v1.<body>.<sig>`) but not a valid one: nothing can
    // redeem it. A verification script must never mint a code that works.
    redemptionCode:
      'v1.eyJwYXJ0aWNpcGFudElkIjoidmVyaWZ5IiwicXR5IjoyfQ.0000000000000000000000000000000000000000',
    orderUrl: 'https://groupeat.example/d/VERIFY/mine?t=p1.verify-only-not-a-real-token',
    windowStart,
    windowEnd,
  };
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry');
  const phone = args.find((arg) => !arg.startsWith('--'));

  if (!phone) {
    fail(
      'usage: verify-sms <+E.164 number> [--dry]\n' +
        '\n' +
        '  --dry   compose and print the message; do not contact Twilio\n' +
        '\n' +
        'The number must be one you can read, in E.164 (e.g. +14035551234).',
    );
  }

  if (!/^\+\d{8,15}$/.test(phone)) {
    fail(`"${phone}" is not E.164. Expected a leading + and 8–15 digits, e.g. +14035551234.`);
  }

  // The merchant's zone, so the window reads in the kitchen's local time — the same
  // argument the settlement path passes.
  const message = compose(sampleIntent(phone), 'America/Edmonton');
  if (!message) {
    fail('the composer returned null for a charged intent — that is a composer bug.');
  }

  process.stdout.write('\n--- composed body ---\n');
  process.stdout.write(`${message.body}\n`);
  process.stdout.write(`--- length: ${message.body.length} chars ---\n\n`);

  const config = twilioConfigFrom(process.env);
  if (!config) {
    // A dry run is the one case where missing credentials is fine — it never reaches
    // the provider. Anything else needs them, and says which are missing rather than
    // failing with a network error later.
    if (dryRun) {
      process.stdout.write('Dry run: no Twilio credentials present, so nothing was sent.\n');
      process.stdout.write('That is expected for --dry. Set TWILIO_* in .env to send for real.\n');
      return;
    }
    fail(
      'TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER must all be set in .env.\n' +
        'See .env.example. Absent, the app runs in logging mode and sends nothing.',
    );
  }

  process.stdout.write(`account: …${config.accountSid.slice(-6)}   from: ${config.from}\n\n`);

  if (dryRun) {
    process.stdout.write('Dry run: credentials look complete, but nothing was sent.\n');
    process.stdout.write(`Run without --dry to send to ${phone}.\n`);
    return;
  }

  const sender = resolveSender(process.env);
  // The guard that stops a keyless deployment from reporting success. `resolveSender`
  // falls back to `loggingSender`, which returns `sent: false` — but a script that
  // only printed "done" would look identical either way.
  if (sender.name !== 'twilio') {
    fail(`resolveSender chose "${sender.name}" despite complete credentials — that is a bug.`);
  }

  process.stdout.write(`sending to ${phone} …\n`);

  const result = await sender.send([message]);
  const outcome = result.outcomes[0];

  if (!outcome?.sent) {
    fail(
      `the send failed: ${outcome?.reason ?? 'no outcome'}.\n` +
        'Before assuming a Twilio outage, check the log line above — provider errors are\n' +
        'reported there with their numeric code (21610 = rate limit, 21606 = sender not\n' +
        'SMS-capable, 21211 = bad To number).',
    );
  }

  process.stdout.write(`accepted by Twilio. sid: ${outcome.providerId ?? '(none returned)'}\n`);

  if (!outcome.providerId) {
    // Not a failure, but it disables the only check that matters, so say so plainly
    // rather than printing a tick.
    process.stdout.write(
      '\nTwilio did not return a message sid, so delivery cannot be checked from here.\n' +
        'Look the message up in the Twilio console instead.\n',
    );
    return;
  }

  await reportDelivery(config.accountSid, config.authToken, outcome.providerId);
}

/**
 * Re-reads the message until it reaches a terminal status, or gives up.
 *
 * ~30 s, because a carrier round trip is seconds and a queue is usually under one
 * minute. Polling longer would make the script feel hung; polling once would report
 * `queued` and prove nothing.
 */
async function reportDelivery(
  accountSid: string,
  authToken: string,
  sid: string,
): Promise<void> {
  const authorisation = `Basic ${Buffer.from(`${accountSid}:${authToken}`, 'utf8').toString('base64')}`;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages/${sid}.json`;

  const terminal = new Set(['delivered', 'undelivered', 'failed']);
  let last = '';

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const response = await fetch(url, { headers: { authorization: authorisation } });
    if (!response.ok) {
      process.stdout.write(`\ncould not read the message back: HTTP ${response.status}\n`);
      return;
    }

    const detail = (await response.json().catch(() => null)) as
      | { status?: string; error_code?: number | null; error_message?: string | null; num_segments?: string }
      | null;

    const status = detail?.status ?? 'unknown';
    if (status !== last) {
      process.stdout.write(`  ${((attempt + 1) * 3).toString().padStart(2)}s  ${status}\n`);
      last = status;
    }

    if (terminal.has(status)) {
      report(status, detail);
      return;
    }
  }

  process.stdout.write(
    `\nStill "${last}" after 30s. Not conclusive — queued messages can take a minute —\n` +
      `but not proof either. Check ${sid} in the Twilio console.\n`,
  );
}

function report(
  status: string,
  detail: { error_code?: number | null; error_message?: string | null; num_segments?: string } | null,
): void {
  process.stdout.write('\n--- result ---\n');

  if (status === 'delivered') {
    process.stdout.write(
      'DELIVERED. This is the proof that was missing: a real handset received a real\n' +
        'message. FR-506 delivery now has evidence behind it, and the same run proves\n' +
        'the form encoding, the auth header and the Canadian sender.\n',
    );
    return;
  }

  process.stdout.write(`status ${status}${detail?.error_code ? `, code ${detail.error_code}` : ''}\n`);
  if (detail?.error_message) {
    process.stdout.write(`${detail.error_message}\n`);
  }
  process.stdout.write(
    '\nNOT delivered. The API accepted it and the carrier did not. The usual cause on a\n' +
      'Canadian number is an unregistered A2P sender (D-5: "verify Canadian sender ID") —\n' +
      'the message is billed and silently filtered. The number below is what to search.\n',
  );
}

await main();
