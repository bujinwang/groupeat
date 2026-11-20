import { describe, expect, it } from 'vitest';

import { ownerInviteEmail } from '../invite-email';

/**
 * FR-101's email, without a provider.
 *
 * The claims are the ones a provider test cannot make: the link is the message, the
 * expiry is a duration, and the merchant name is escaped because it is an
 * operator-entered string.
 */

const URL = 'https://groupeat.example/set-password?token=abc_DEF-123';

describe('ownerInviteEmail', () => {
  it('names the merchant and carries the one link', () => {
    const email = ownerInviteEmail({
      to: 'owner@example.test',
      ownerName: 'Sam Okafor',
      merchantName: 'Copper Kettle',
      inviteUrl: URL,
      expiresInLabel: '72 hours',
    });

    expect(email.kind).toBe('owner_invite');
    expect(email.to).toBe('owner@example.test');
    expect(email.subject).toBe('Set up your GroupEat account for Copper Kettle');
    expect(email.text).toContain('Hi Sam,');
    expect(email.text).toContain(URL);
    expect(email.text).toContain('expires in 72 hours');
    expect(email.text).toContain('works once');
  });

  it('escapes the merchant name in the HTML alternative', () => {
    const email = ownerInviteEmail({
      to: 'owner@example.test',
      ownerName: null,
      merchantName: '<script>alert(1)</script>',
      inviteUrl: URL,
      expiresInLabel: '72 hours',
    });

    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
    // A missing owner name still greets a person rather than a blank.
    expect(email.html).toContain('Hi there,');
  });

  it('does not repeat the recipient address inside the message', () => {
    const email = ownerInviteEmail({
      to: 'private@example.test',
      ownerName: 'Sam',
      merchantName: 'Copper Kettle',
      inviteUrl: URL,
      expiresInLabel: '72 hours',
    });

    expect(email.subject).not.toContain('private@example.test');
    expect(email.text).not.toContain('private@example.test');
    expect(email.html).not.toContain('private@example.test');
  });
});
