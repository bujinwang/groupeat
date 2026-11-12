import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AiUnavailableError,
  AiUnavailableReason,
  CompletionRequest,
} from '../port';

vi.mock('server-only', () => ({}));

/**
 * What `real-port.ts` actually puts on the wire — recorded, not inferred.
 *
 * ## The hole this file exists to close, measured
 *
 * Not guessed. Running
 *
 * ```
 * npx vitest run src/lib/ai --coverage.enabled --coverage.provider=v8 --coverage.include='src/lib/ai/real-port.ts' --coverage.reporter=text
 * ```
 *
 * reported, before this file existed:
 *
 * ```
 * --------------|---------|----------|---------|---------|-------------------
 * File          | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
 * --------------|---------|----------|---------|---------|-------------------
 * All files     |       0 |        0 |       0 |       0 |
 *  real-port.ts |       0 |        0 |       0 |       0 | 1-108
 * --------------|---------|----------|---------|---------|-------------------
 * ```
 *
 * **0 % stmts / 0 % branch / 0 % funcs; every line 1-108 uncovered.** No test
 * imports the module for real: `deal-builder.ts:95` reaches it only by
 * `await import('./real-port')`, the AI tests inject a fake `CompletionPort`,
 * and the route test deletes `AI_API_KEY` so the dynamic import is never
 * reached. The adapter that actually builds the HTTP request — URL, bearer
 * header, JSON body, deadline, and every error mapping — was dead code as far
 * as the gate was concerned.
 *
 * ## Why a local recording server rather than a stubbed `fetch`
 *
 * This module calls global `fetch`. A `vi.stubGlobal('fetch', vi.fn(() => …))`
 * that *returns* a canned `Response` would let a wrong URL, a missing bearer
 * header, or a stray JSON field sail through while the test still claims to
 * "check the request" — the assertion would be against args the stub's own
 * author controls. Here `AI_BASE_URL` points at an in-process `node:http`
 * server on `127.0.0.1:0`: the test only passes if the bytes genuinely arrive
 * with the expected method, path, headers and body. A thin `fetch` wrapper
 * delegates to the real `fetch` so the request actually goes out; it exists
 * only to inspect `init.signal` and to inject two forced rejections.
 *
 * `env` is `loadEnv(process.env)` computed at MODULE LOAD, so each test sets
 * the three `AI_*` keys BEFORE `vi.resetModules()` + a fresh `import('../real-port')`.
 * Only those three keys are touched; `DATABASE_URL` and `JWT_SECRET` (loaded
 * by `vitest.setup.ts` from `.env`) are never deleted.
 *
 * ## What this proves, and what it does not
 *
 * **Proves:** the exact endpoint and method; the `content-type` and
 * `authorization` headers; the exact JSON body (sorted key set, env-supplied
 * model, `maxOutputTokens` and its `900` default, the default model, and the
 * trailing-slash stripping at line 52); verbatim return of `choices[0]`; the
 * `AbortSignal` at line 75; `isCopyModelConfigured` and the `no_key` guard; and
 * the full failure map (`http_error` with status, `timeout`, `bad_response`).
 *
 * **Does NOT prove:** that any real model provider accepts these shapes or
 * returns these bodies — **no live provider was contacted**. The one test that
 * omits `AI_BASE_URL` forces `fetch` to reject so no request ever leaves the
 * process, and asserts the assembled default URL instead. The request deadline
 * is **8 s per PRD-v1 §9.5** (`AbortSignal.timeout(8_000)`, line 75); this
 * suite deliberately does **not** wait out the 8 seconds — it asserts the
 * signal is present and not yet aborted, and exercises the timeout *branch* by
 * rejecting `fetch` with a `TimeoutError` rather than by sleeping.
 */

type AiEnv = {
  AI_API_KEY?: string;
  AI_BASE_URL?: string;
  AI_MODEL?: string;
};

type Recorded = {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
};

type Reply = { status: number; contentType: string; body: string };

const AI_KEYS = ['AI_API_KEY', 'AI_BASE_URL', 'AI_MODEL'] as const;
const API_KEY = 'sk-wire-recording-key';

const BASE_REQUEST: CompletionRequest = {
  system: 'You write short, warm deal copy.',
  user: 'A tray of lasagna, 12 portions, tonight.',
};

const recorded: Recorded[] = [];

let reply: Reply = { status: 200, contentType: 'application/json', body: '{}' };

function respondJson(status: number, body: unknown): void {
  reply = { status, contentType: 'application/json', body: JSON.stringify(body) };
}

function respondRaw(status: number, raw: string): void {
  reply = { status, contentType: 'application/json', body: raw };
}

function okContent(content: string): void {
  respondJson(200, { choices: [{ message: { content } }] });
}

/** One recording `node:http` server, bound to 127.0.0.1 on an ephemeral port. */
let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = undefined;
      }

      recorded.push({
        method: request.method ?? '',
        path: url.pathname,
        headers: request.headers,
        body,
      });

      response.writeHead(reply.status, { 'content-type': reply.contentType });
      response.end(reply.body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

/** Save the pristine global fetch before stubbing, so the wrapper can delegate. */
function makeFetchMock(original: typeof globalThis.fetch) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => original(input, init));
}

let fetchMock: ReturnType<typeof makeFetchMock>;

beforeEach(() => {
  recorded.length = 0;
  okContent('Default recorded copy.');

  const originalFetch = globalThis.fetch.bind(globalThis) as typeof globalThis.fetch;
  fetchMock = makeFetchMock(originalFetch);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  // Only the three AI_* keys were touched; DATABASE_URL and JWT_SECRET stay put.
  delete process.env.AI_API_KEY;
  delete process.env.AI_BASE_URL;
  delete process.env.AI_MODEL;
  vi.unstubAllGlobals();
});

/**
 * Set the three AI_* keys, then reset the module graph, then import fresh.
 * `env` is frozen at config-module load, so the ORDER here is load-bearing:
 * keys must be set before `vi.resetModules()` + `import('../real-port')`.
 * A fresh import per call is also what lets `isCopyModelConfigured` see three
 * different key states in one test.
 */
async function load(overrides: AiEnv = {}) {
  setAiEnv({
    AI_API_KEY: API_KEY,
    // Trailing slash on purpose: every wire test thus exercises the
    // baseUrl.replace(/\/+$/, '') at line 52.
    AI_BASE_URL: `http://127.0.0.1:${port}/v1/`,
    // AI_MODEL intentionally omitted by default -> the default model.
    ...overrides,
  });

  vi.resetModules();
  const realPort = await import('../real-port');
  // Same module-graph generation as real-port's own './port', so the
  // `instanceof AiUnavailableError` inside isAiUnavailable matches the errors.
  const portModule = await import('../port');

  return {
    isCopyModelConfigured: realPort.isCopyModelConfigured,
    createRealCompletionPort: realPort.createRealCompletionPort,
    isAiUnavailable: portModule.isAiUnavailable,
  };
}

function setAiEnv(values: AiEnv): void {
  for (const key of AI_KEYS) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function firstRecorded(): Recorded {
  const entry = recorded[0];
  if (!entry) throw new Error('no HTTP request was recorded');
  return entry;
}

/** Assert reason (and optional status) via isAiUnavailable(); return the narrowed error. */
function expectUnavailable(
  isAiUnavailable: (value: unknown) => value is AiUnavailableError,
  value: unknown,
  reason: AiUnavailableReason,
  status?: number,
): AiUnavailableError {
  expect(isAiUnavailable(value)).toBe(true);
  if (!isAiUnavailable(value)) throw new Error('expected an AiUnavailableError');
  expect(value.reason).toBe(reason);
  if (status !== undefined) expect(value.status).toBe(status);
  return value;
}

/** All six ways a 2xx response can fail to be usable text. */
const badBodies: { label: string; respond: () => void }[] = [
  { label: 'empty object {}', respond: () => respondJson(200, {}) },
  {
    label: 'content is empty string',
    respond: () => respondJson(200, { choices: [{ message: { content: '' } }] }),
  },
  {
    label: 'content is whitespace only',
    respond: () => respondJson(200, { choices: [{ message: { content: '   ' } }] }),
  },
  {
    label: 'content is a number',
    respond: () => respondJson(200, { choices: [{ message: { content: 42 } }] }),
  },
  {
    label: 'choices present but message missing',
    respond: () => respondJson(200, { choices: [{}] }),
  },
  { label: 'unparseable JSON', respond: () => respondRaw(200, 'this is not json {{') },
];

describe('the request on the wire', () => {
  it('POSTs to exactly /v1/chat/completions, stripping a trailing slash from AI_BASE_URL', async () => {
    const { createRealCompletionPort } = await load({
      AI_BASE_URL: `http://127.0.0.1:${port}/v1/`,
    });
    await createRealCompletionPort().complete(BASE_REQUEST);

    const request = firstRecorded();
    expect(request.method).toBe('POST');
    // Without line 52's .replace(/\/+$/, '') this would be /v1//chat/completions.
    expect(request.path).toBe('/v1/chat/completions');
    expect(request.path).not.toBe('/v1//chat/completions');
  });

  it('sends content-type: application/json and the exact Bearer authorization', async () => {
    const { createRealCompletionPort } = await load();
    await createRealCompletionPort().complete(BASE_REQUEST);

    const { headers } = firstRecorded();
    expect(headers['content-type']).toBe('application/json');
    // A wrong key silently disables the model with no error; pin it exactly.
    expect(headers['authorization']).toBe(`Bearer ${API_KEY}`);
  });

  it('sends exactly {model, temperature, max_tokens, messages} with env model and request maxOutputTokens', async () => {
    const CUSTOM_MODEL = 'gpt-wire-custom-7b';
    const { createRealCompletionPort } = await load({ AI_MODEL: CUSTOM_MODEL });
    await createRealCompletionPort().complete({ ...BASE_REQUEST, maxOutputTokens: 321 });

    const parsed = firstRecorded().body as Record<string, unknown>;
    // The sorted key set catches a NEW stray field, not just wrong values.
    expect(Object.keys(parsed).sort()).toEqual(['max_tokens', 'messages', 'model', 'temperature']);
    expect(parsed.model).toBe(CUSTOM_MODEL);
    expect(parsed.temperature).toBe(0.4);
    expect(parsed.max_tokens).toBe(321);
    expect(parsed.messages).toEqual([
      { role: 'system', content: BASE_REQUEST.system },
      { role: 'user', content: BASE_REQUEST.user },
    ]);
  });

  it('defaults max_tokens to 900 when maxOutputTokens is omitted (line 69)', async () => {
    const { createRealCompletionPort } = await load();
    await createRealCompletionPort().complete(BASE_REQUEST);

    const parsed = firstRecorded().body as Record<string, unknown>;
    expect(parsed.max_tokens).toBe(900);
  });

  it('defaults the model to gpt-4o-mini when AI_MODEL is omitted', async () => {
    const { createRealCompletionPort } = await load();
    await createRealCompletionPort().complete(BASE_REQUEST);

    const parsed = firstRecorded().body as Record<string, unknown>;
    expect(parsed.model).toBe('gpt-4o-mini');
  });

  it('returns choices[0].message.content verbatim, without trimming', async () => {
    const { createRealCompletionPort } = await load();
    const content = '  A  warm  tray,  tonight.  ';
    okContent(content);
    const result = await createRealCompletionPort().complete(BASE_REQUEST);

    expect(result).toBe(content);
  });

  it('passes an AbortSignal that is present and not yet aborted (line 75)', async () => {
    const { createRealCompletionPort } = await load();
    await createRealCompletionPort().complete(BASE_REQUEST);

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
    expect(init?.signal?.reason).toBeUndefined();
    // The timer is unref'd. We deliberately do NOT wait it out — an 8-second
    // sleep would dominate the suite. `reason === undefined` proves it has not
    // fired. The timeout *branch* is exercised below by rejecting fetch with a
    // TimeoutError rather than by sleeping. The VALUE is pinned separately in
    // "uses the 8-second deadline" — this test does not check it.
  });

  it('uses the 8-second deadline PRD-v1 §9.5 names, not merely "a signal"', async () => {
    // Found by mutation, not by reading. This suite originally asserted only that
    // `init.signal` was an AbortSignal and not yet aborted — so changing
    // `REQUEST_TIMEOUT_MS` from 8_000 to **30_000** passed all 15 tests. A merchant
    // standing in a kitchen waiting 30 s for copy that falls back instantly is the
    // exact outcome §9.5 exists to prevent, and nothing failed.
    //
    // Pinned by recording the argument to `AbortSignal.timeout` rather than by
    // sleeping 8 seconds: the value is what §9.5 specifies, and waiting would add
    // 8 s to every gate run to learn the same fact. The spy delegates to the real
    // implementation so the signal is still a genuine, working AbortSignal.
    const calls: number[] = [];
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      calls.push(ms);
      return realTimeout(ms);
    });

    try {
      const { createRealCompletionPort } = await load();
      await createRealCompletionPort().complete(BASE_REQUEST);
    } finally {
      spy.mockRestore();
    }

    expect(calls).toEqual([8_000]);
  });

  it('falls back to the documented default base URL when AI_BASE_URL is absent, with no network', async () => {
    const { createRealCompletionPort, isAiUnavailable } = await load({ AI_BASE_URL: undefined });
    // Force fetch to reject so NOTHING can reach api.openai.com.
    fetchMock.mockRejectedValueOnce(new Error('network disabled for this test'));
    const port = createRealCompletionPort();
    const error = await port.complete(BASE_REQUEST).catch((caught: unknown) => caught);

    expectUnavailable(isAiUnavailable, error, 'http_error');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('returns only the first choice when the response has two (the ?.[0] is load-bearing)', async () => {
    const { createRealCompletionPort } = await load();
    respondJson(200, {
      choices: [
        { message: { content: 'FIRST_COPY' } },
        { message: { content: 'SECOND_COPY' } },
      ],
    });
    const result = await createRealCompletionPort().complete(BASE_REQUEST);

    expect(result).toBe('FIRST_COPY');
  });
});

describe('configuration guards', () => {
  it('isCopyModelConfigured is true with a key and false for an absent or empty-string key', async () => {
    // Three fresh module imports: `env` is computed at import time.
    const configured = await load({ AI_API_KEY: API_KEY });
    expect(configured.isCopyModelConfigured()).toBe(true);

    const absent = await load({ AI_API_KEY: undefined });
    expect(absent.isCopyModelConfigured()).toBe(false);

    // optionalString() (config.ts:30-35) treats '' as absent.
    const empty = await load({ AI_API_KEY: '' });
    expect(empty.isCopyModelConfigured()).toBe(false);
  });

  it('createRealCompletionPort throws no_key without a key and makes no HTTP request', async () => {
    const { createRealCompletionPort, isAiUnavailable } = await load({ AI_API_KEY: undefined });

    let thrown: unknown;
    try {
      createRealCompletionPort();
    } catch (caught: unknown) {
      thrown = caught;
    }

    expectUnavailable(isAiUnavailable, thrown, 'no_key');
    expect(recorded).toHaveLength(0);
  });
});

describe('failure mapping', () => {
  it('maps a non-2xx (429) to http_error with status 429 and does not surface the body', async () => {
    const MARKER = 'MARKER_PROMPT_ECHO_7f3a9c';
    const { createRealCompletionPort, isAiUnavailable } = await load();
    respondJson(429, { error: { prompt_echo: MARKER } });
    const port = createRealCompletionPort();
    const error = await port.complete(BASE_REQUEST).catch((caught: unknown) => caught);

    const aiError = expectUnavailable(isAiUnavailable, error, 'http_error', 429);
    // The port deliberately never reads the error body (it can echo the
    // merchant's name). This assertion is WEAK BY NATURE: the module has no
    // logging, so the only honest claim is that the thrown error carries no
    // marker from that body. It does NOT prove the bytes were never read —
    // only that they were not surfaced here. Do not overclaim it.
    expect(`${aiError.message}|${aiError.status}`).not.toContain(MARKER);
  });

  it('maps every malformed 2xx body to bad_response', async () => {
    const { createRealCompletionPort, isAiUnavailable } = await load();
    const port = createRealCompletionPort();
    const observed: [string, unknown][] = [];
    for (const { label, respond } of badBodies) {
      respond();
      const error = await port.complete(BASE_REQUEST).catch((caught: unknown) => caught);
      observed.push([label, isAiUnavailable(error) ? error.reason : 'not-ai-unavailable']);
    }
    expect(observed).toEqual(badBodies.map(({ label }) => [label, 'bad_response']));
  });

  it('maps a TimeoutError DOMException rejection to reason timeout', async () => {
    const { createRealCompletionPort, isAiUnavailable } = await load();
    // What AbortSignal.timeout produces on deadline: name === 'TimeoutError'.
    // (DOMException instanceof Error is true on Node 24.21.0, so the port's
    // `error instanceof Error && error.name === 'TimeoutError'` holds.)
    fetchMock.mockRejectedValueOnce(new DOMException('deadline exceeded', 'TimeoutError'));
    const port = createRealCompletionPort();
    const error = await port.complete(BASE_REQUEST).catch((caught: unknown) => caught);

    expectUnavailable(isAiUnavailable, error, 'timeout');
  });

  it('maps a plain Error rejection to reason http_error', async () => {
    const { createRealCompletionPort, isAiUnavailable } = await load();
    fetchMock.mockRejectedValueOnce(new Error('connection refused'));
    const port = createRealCompletionPort();
    const error = await port.complete(BASE_REQUEST).catch((caught: unknown) => caught);

    expectUnavailable(isAiUnavailable, error, 'http_error');
  });
});

