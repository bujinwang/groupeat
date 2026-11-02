/**
 * Mints a redemption code for a participant, so the pickup screen can be tested
 * by hand without running a whole drop through settlement.
 *
 *   npx tsx scripts/mint-code.ts <participantId> <dropId> <qty>
 *
 * Prints the code to stdout with nothing after it, so it can be piped into
 * `pbcopy` or a curl body.
 *
 * ## Why this exists and is not a test
 *
 * Every path in `lib/redemption/` is covered by a test that signs its own codes
 * with an explicit secret. That is the right way to test the *rules*. It is the
 * wrong way to look at the screen: a browser has to scan a code signed with the
 * **ambient** key, which means `JWT_SECRET` from `.env` — and no unit test can
 * show you what a 360px phone does with a long name, or where focus lands.
 *
 * ## Why it is safe to keep in the repo
 *
 * It reads `.env` and signs with whatever key is there, which is exactly what the
 * application already does. It cannot mint anything a running app could not, it
 * writes nothing, and in production there is no `.env` to read. Keeping it here
 * means the next person does not invent a weaker one.
 */
import 'dotenv/config';

import { signRedemptionCode } from '../src/lib/settlement/redemption-code';

const [participantId, dropId, qtyRaw] = process.argv.slice(2);

if (!participantId || !dropId || !qtyRaw) {
  process.stderr.write('usage: mint-code <participantId> <dropId> <qty>\n');
  process.exit(1);
}

const qty = Number(qtyRaw);
if (!Number.isInteger(qty) || qty < 1) {
  process.stderr.write('qty must be a positive integer\n');
  process.exit(1);
}

process.stdout.write(signRedemptionCode({ participantId, dropId, qty }));
