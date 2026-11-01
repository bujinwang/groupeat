/**
 * The model seam — a port, not a client.
 *
 * Same shape as `lib/payments/connect-port.ts`, and for the same reason: the
 * orchestration that matters (does the copy say the right price? does the merchant
 * still get three proposals when the model is down?) must be testable without a
 * network, an API key, or a clock. `deal-builder.ts` depends on this interface;
 * only `real-port.ts` knows a provider exists.
 *
 * ## `complete()` returns text, not a parsed object
 *
 * Deliberately. A port that parses is a port whose fake has to reproduce the
 * provider's exact failure modes, and whose failures become indistinguishable
 * from the parser's. Here the seam is at the network boundary: the fake returns
 * whatever string a test wants, including garbage, and `parseCopyResponse` is
 * exercised for real in every one of those cases.
 */

export type CompletionRequest = {
  system: string;
  user: string;
  /** Upper bound on the reply. The copy contract is ~900 characters. */
  maxOutputTokens?: number;
};

export type CompletionPort = {
  /** Resolves with the assistant's raw message text. */
  complete(request: CompletionRequest): Promise<string>;
};

export type AiUnavailableReason =
  /** No `AI_API_KEY` configured. The supported no-model mode. */
  | 'no_key'
  /** The provider did not answer within the deadline. */
  | 'timeout'
  /** Non-2xx response. */
  | 'http_error'
  /** 2xx with a body that is not the shape a chat completion has. */
  | 'bad_response';

/**
 * Thrown by a port that cannot answer. Always caught by the caller: no path in
 * this feature may surface an AI failure to a merchant (§9.1.4).
 */
export class AiUnavailableError extends Error {
  readonly reason: AiUnavailableReason;
  /** HTTP status, when there was one. Safe to log; never contains the key. */
  readonly status?: number;

  constructor(reason: AiUnavailableReason, message: string, status?: number) {
    super(message);
    this.name = 'AiUnavailableError';
    this.reason = reason;
    this.status = status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isAiUnavailable(value: unknown): value is AiUnavailableError {
  return value instanceof AiUnavailableError;
}

/**
 * A port that always fails, used when no key is configured.
 *
 * Preferred over `undefined` so callers have one shape to handle: `try { … }
 * catch (AiUnavailableError)` reads the same whether the model is absent or
 * broken, and the reason says which.
 */
export function createUnavailablePort(
  reason: AiUnavailableReason = 'no_key',
): CompletionPort {
  return {
    async complete() {
      throw new AiUnavailableError(reason, 'No copy model is configured.');
    },
  };
}
