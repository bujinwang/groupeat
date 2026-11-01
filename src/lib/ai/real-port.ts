import 'server-only';

import { env } from '@/lib/config';

import { AiUnavailableError, type CompletionPort, type CompletionRequest } from './port';

/**
 * The only module that knows a model provider exists.
 *
 * `server-only` at the top, and imported **dynamically** by `deal-builder.ts`
 * (`await import('./real-port')`). A static import would evaluate `server-only`
 * at module load, which throws under Vitest, which would make the orchestration
 * untestable — the same trap `lib/payments/real-connect-port.ts` documents, and
 * the same fix.
 *
 * ## OpenAI-compatible by default
 *
 * `/chat/completions` with a bearer token is the de-facto shape: OpenAI, Azure
 * OpenAI gateways, OpenRouter, Groq, Together, Ollama and vLLM all speak it. One
 * client covers them by pointing `AI_BASE_URL` somewhere else, which is worth more
 * than provider-specific features this feature does not use.
 *
 * ## The deadline is 8 seconds
 *
 * PRD-v1 §9.5: "Model timeout (>8s) → fall back to form-based creation". A
 * merchant is standing in a kitchen with a phone; past eight seconds the copy is
 * not the bottleneck, the waiting is. `AbortSignal.timeout` is used rather than a
 * `setTimeout` + `abort()` pair so the timer cannot leak if the request settles
 * first.
 */

const REQUEST_TIMEOUT_MS = 8_000;
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';

/** The subset of a chat-completion response this feature reads. */
type ChatCompletionResponse = {
  choices?: { message?: { content?: unknown } }[];
};

export function isCopyModelConfigured(): boolean {
  return typeof env.AI_API_KEY === 'string' && env.AI_API_KEY.length > 0;
}

export function createRealCompletionPort(): CompletionPort {
  const apiKey = env.AI_API_KEY;
  if (!apiKey) {
    // Callers check `isCopyModelConfigured()` first; this is the belt.
    throw new AiUnavailableError('no_key', 'AI_API_KEY is not set.');
  }

  const baseUrl = (env.AI_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = env.AI_MODEL ?? DEFAULT_MODEL;

  return {
    async complete(request: CompletionRequest): Promise<string> {
      let response: Response;

      try {
        response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            temperature: 0.4,
            max_tokens: request.maxOutputTokens ?? 900,
            messages: [
              { role: 'system', content: request.system },
              { role: 'user', content: request.user },
            ],
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        // `AbortSignal.timeout` rejects with a `TimeoutError` DOMException. Any
        // other rejection here is a connection problem, which for this feature has
        // the same consequence: fall back.
        const isTimeout = error instanceof Error && error.name === 'TimeoutError';
        throw new AiUnavailableError(
          isTimeout ? 'timeout' : 'http_error',
          isTimeout ? 'The copy model did not answer in time.' : 'The copy model could not be reached.',
        );
      }

      if (!response.ok) {
        // The body is not read: it can echo the prompt, and the prompt contains
        // the merchant's name. The status is enough to act on.
        throw new AiUnavailableError(
          'http_error',
          'The copy model returned an error.',
          response.status,
        );
      }

      const body = (await response.json().catch(() => null)) as ChatCompletionResponse | null;
      const content = body?.choices?.[0]?.message?.content;

      if (typeof content !== 'string' || content.trim() === '') {
        throw new AiUnavailableError('bad_response', 'The copy model returned no text.');
      }

      return content;
    },
  };
}
