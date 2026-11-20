import type { EmailMessage } from '@/lib/notify/email-sender';

import { escapeHtml } from './html';

/**
 * FR-101 — the invitation email, as words.
 *
 * > `FR-101 | Ops creates a Merchant and invites an Owner by email | Owner receives a
 * > set-password link valid 72h` — PRD-v1.md:442
 *
 * ## The link is the whole message
 *
 * An invited owner has no account state to describe: no drops, no figures, no reason
 * to open the app until they have a password. So the email says who invited them, what
 * the link does, how long it lives, and nothing else. Every extra sentence is another
 * thing to be wrong in a message whose only job is to be trusted enough to click.
 *
 * ## Why the expiry is stated as a duration, not a timestamp
 *
 * "Valid for 72 hours" is true whenever the person reads it. A formatted instant is
 * wrong the moment the mail client re-renders in another zone — and this repo has
 * already paid for that class of bug in the digest and the commission statement.
 *
 * ## Why there is no unsubscribe line
 *
 * This is a transactional account invitation, not marketing. CASL's consent rule is
 * about commercial electronic messages; an owner cannot "unsubscribe" from being given
 * the account their restaurant runs on. The digest's opt-in is a different feature and
 * a different message.
 *
 * ## What it does not contain
 *
 * No password, no temporary credential, no price, no diner data. The recipient's email
 * address is the `to` field and never appears in the body or the subject.
 */

export function ownerInviteEmail(args: {
  readonly to: string;
  readonly ownerName: string | null;
  readonly merchantName: string;
  readonly inviteUrl: string;
  readonly expiresInLabel: string;
}): EmailMessage {
  const firstName = args.ownerName?.trim().split(/\s+/)[0] || 'there';
  const subject = `Set up your GroupEat account for ${args.merchantName}`;

  const text = [
    `Hi ${firstName},`,
    '',
    `${args.merchantName} is being set up on GroupEat, and this address is the owner account.`,
    '',
    `Choose your password here: ${args.inviteUrl}`,
    '',
    `This link works once and expires in ${args.expiresInLabel}. If it expires, ask your GroupEat contact to send a new one.`,
    '',
    'If you were not expecting this, you can ignore the message — no account can be used until a password is chosen.',
  ].join('\n');

  const html = [
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;color:#0f172a">`,
    `<p>Hi ${escapeHtml(firstName)},</p>`,
    `<p><strong>${escapeHtml(
      args.merchantName,
    )}</strong> is being set up on GroupEat, and this address is the owner account.</p>`,
    `<p><a href="${escapeHtml(
      args.inviteUrl,
    )}" style="display:inline-block;min-height:44px;padding:12px 18px;border-radius:8px;background:#0f7b4f;color:#fff;text-decoration:none">Choose your password</a></p>`,
    `<p>This link works once and expires in ${escapeHtml(
      args.expiresInLabel,
    )}. If it expires, ask your GroupEat contact to send a new one.</p>`,
    '<p style="color:#64748b;font-size:12px">If you were not expecting this, you can ignore the message — no account can be used until a password is chosen.</p>',
    '</div>',
  ].join('');

  return {
    kind: 'owner_invite',
    to: args.to,
    subject,
    text: `${text}\n`,
    html,
  };
}
