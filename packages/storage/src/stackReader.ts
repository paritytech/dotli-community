// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A network's signed stack for a start: the stored copy when there is one, so the start waits on no fetch, and the live
// copy fetched behind it and stored for the next start. The bundled copy is the floor. A copy is stored only once its
// signature verifies, since a consumer refuses a copy it cannot verify and fails its whole start on it.

import { loadStack, type BundledStack, type Network } from '@dotli/config';
import { createReporter, defineCount } from '@dotli/metrics';
import {
  createAsyncTaskPool,
  fromHex,
  getErrorMessage,
  isRecord,
  realTimers,
  withTimeout,
  type Timers,
} from '@dotli/shared';
import { stackStore, type StackStore, type StoredStack } from './stackStore.js';

/** What a read of a network's stack resolves with. */
export type StackRead = {
  /** The copy to start from. */
  stack: BundledStack;
  /**
   * A verified live copy newer than `stack`, resolved once it is stored, or `null` when none arrived. Never rejects.
   */
  newer: Promise<BundledStack | null>;
};

type Params = {
  store?: Pick<StackStore, 'getStack' | 'setStack'>;
  /** Loads a network's bundled copy. */
  loadBundled?: (network: Network) => Promise<BundledStack>;
  fetch?: typeof fetch;
  /** Checks a live copy's signature. Without Ed25519 in it, nothing is stored. */
  subtle?: Pick<SubtleCrypto, 'importKey' | 'verify'>;
  /** The fetch's timeout and retry waits run on them. */
  timers?: Timers;
};

/** A descriptor that parsed, with what its signature covers. */
type ParsedDescriptor = {
  payload: Uint8Array<ArrayBuffer>;
  signature: Uint8Array<ArrayBuffer>;
  sequence: number;
};

/** A live copy that verified. */
type LiveCopy = {
  descriptor: Uint8Array;
  sequence: number;
};

const report = createReporter({ flow: 'storage' });

/**
 * A live descriptor that could not be had: fetched, checked and verified. Counted only on failure, tagged `outcome`
 * (error), `reason` (the error's name) and `step` (`fetch, check`).
 */
const stackLiveCopyMetric = defineCount<'error'>('stack.live_copy');

const DESCRIPTOR_VERSION = 1;
// A descriptor is a few kilobytes. The cap keeps an error page or a runaway body out of memory.
const MAX_DESCRIPTOR_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 5000;
// A start with no stored copy waits out the retries, so they stay short.
const FETCH_RETRY_COUNT = 2;
const FETCH_RETRY_BASE_MS = 500;
const SIGNING_PREFIX = new TextEncoder().encode('trinity-stack/descriptor/v1');
const SIGNATURE_PATTERN = /^0x[0-9a-f]{128}$/;
const KEY_PATTERN = /^0x[0-9a-f]{64}$/;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** The stack reader over `store`, the page's own stack store by default. */
export function createStackReader({
  store = stackStore,
  loadBundled = loadStack,
  fetch: fetchResource = fetch,
  subtle = globalThis.crypto.subtle,
  timers = realTimers,
}: Params = {}) {
  // Unbounded, since each network fetches once. The pool only retries.
  const pool = createAsyncTaskPool({
    poolSize: Number.POSITIVE_INFINITY,
    retryCount: FETCH_RETRY_COUNT,
    retryDelay: retry => FETCH_RETRY_BASE_MS * 2 ** retry,
    timers,
  });
  const reads = new Map<Network, Promise<StackRead>>();

  /**
   * Resolves with the copy to start from and the newer live copy to come. A repeated read of a network returns the
   * first one's work, so a page fetches once. Rejects when the bundled copy fails to load or is malformed, and a read
   * after that loads again.
   */
  function read(network: Network): Promise<StackRead> {
    const pending = reads.get(network);
    if (pending !== undefined) {
      return pending;
    }
    const started = readStack(network);
    reads.set(network, started);
    // The caller gets the rejection. Only the memo drops it here, so a later read loads again.
    started.catch(() => {
      reads.delete(network);
    });
    return started;
  }

  async function readStack(network: Network): Promise<StackRead> {
    const storedRead = store.getStack(network);
    const bundled = await loadBundled(network);
    const bundledSequence = readBundledSequence(bundled);
    const served = fetchServed(bundled.pointer);
    const storedRecord = await storedRead;
    // A copy kept under another link is signed by another key, so it is not this stack's.
    const stored = storedRecord?.pointer === bundled.pointer ? storedRecord : null;

    function toStack(descriptor: Uint8Array): BundledStack {
      return { ...bundled, descriptor };
    }

    async function keep(copy: LiveCopy): Promise<void> {
      const record: StoredStack = { network, pointer: bundled.pointer, ...copy };
      await store.setStack(record);
    }

    if (stored !== null) {
      const startSequence = Math.max(stored.sequence, bundledSequence);
      const newer = served.then(async bytes => {
        const copy = await checkCopy(bytes, { pointer: bundled.pointer, minimum: stored.sequence + 1 });
        if (copy === null) {
          return null;
        }
        await keep(copy);
        return copy.sequence > startSequence ? toStack(copy.descriptor) : null;
      });
      return { stack: stored.sequence > bundledSequence ? toStack(stored.descriptor) : bundled, newer };
    }
    const copy = await checkCopy(await served, { pointer: bundled.pointer, minimum: bundledSequence });
    if (copy === null) {
      return { stack: bundled, newer: Promise.resolve(null) };
    }
    await keep(copy);
    return { stack: toStack(copy.descriptor), newer: Promise.resolve(null) };
  }

  /** The live descriptor's bytes, or `null` once the fetch still fails after its retries, which is reported. */
  async function fetchServed(pointer: string): Promise<Uint8Array | null> {
    try {
      const url = getDescriptorUrl(pointer);
      return await pool.call(() => fetchDescriptor(url));
    } catch (error) {
      report.expected(error, {
        step: 'stack_live_fetch',
        metric: stackLiveCopyMetric,
        attributes: { step: 'fetch' },
        message: `[dot.li stack] the live descriptor of ${pointer} could not be fetched: ${getErrorMessage(error)}`,
      });
      return null;
    }
  }

  /** The body at `url`, past any cached copy. Rejects on a failed fetch, a non-ok answer, a timeout or a body over the cap. */
  async function fetchDescriptor(url: string): Promise<Uint8Array> {
    const controller = new AbortController();
    try {
      return await withTimeout({
        // Redirects are not followed, since the stack's link names the one URL its descriptor is served at.
        work: fetchResource(url, { cache: 'no-cache', redirect: 'error', signal: controller.signal }).then(response =>
          readCapped(url, response),
        ),
        ms: FETCH_TIMEOUT_MS,
        timeoutError: () => new Error(`GET ${url} took over ${String(FETCH_TIMEOUT_MS)}ms`),
        timers,
      });
    } finally {
      controller.abort();
    }
  }

  /**
   * The copy in `bytes` once it parses, its sequence is at least `minimum` and its signature verifies against the key in
   * `pointer`, else `null`. A copy below `minimum` is skipped quietly. A refused or unverifiable one is reported.
   */
  async function checkCopy(
    bytes: Uint8Array | null,
    { pointer, minimum }: { pointer: string; minimum: number },
  ): Promise<LiveCopy | null> {
    if (bytes === null) {
      return null;
    }
    try {
      const parsed = parseDescriptor(bytes);
      if (parsed.sequence < minimum) {
        return null;
      }
      await verifySignature(parsed, pointer);
      return { descriptor: bytes, sequence: parsed.sequence };
    } catch (error) {
      report.expected(error, {
        step: 'stack_live_check',
        metric: stackLiveCopyMetric,
        attributes: { step: 'check' },
        message: `[dot.li stack] the live descriptor of ${pointer} was not stored: ${getErrorMessage(error)}`,
      });
      return null;
    }
  }

  /**
   * Resolves once the signature over the payload verifies against the key in `pointer`. Rejects with an
   * `Ed25519UnsupportedError` when the platform cannot check it, and with a `StackCopyRefusedError` otherwise.
   */
  async function verifySignature({ payload, signature }: ParsedDescriptor, pointer: string): Promise<void> {
    const key = new URL(pointer).searchParams.get('key');
    if (key === null || !KEY_PATTERN.test(key)) {
      throw new StackCopyRefusedError(`Stack link ${pointer} names no Ed25519 key`);
    }
    let publicKey: CryptoKey;
    try {
      publicKey = await subtle.importKey('raw', new Uint8Array(fromHex(key)), { name: 'Ed25519' }, false, ['verify']);
    } catch (error) {
      throw new Ed25519UnsupportedError('This platform cannot check an Ed25519 signature', { cause: error });
    }
    const message = new Uint8Array(SIGNING_PREFIX.length + payload.length);
    message.set(SIGNING_PREFIX);
    message.set(payload, SIGNING_PREFIX.length);
    if (!(await subtle.verify({ name: 'Ed25519' }, publicKey, signature, message))) {
      throw new StackCopyRefusedError(`The descriptor's signature does not verify against ${key}`);
    }
  }

  return { read };
}

export type StackReader = ReturnType<typeof createStackReader>;

/** A live copy that is not a signed descriptor of this stack, such as an error page answered with success. */
class StackCopyRefusedError extends Error {
  override readonly name = 'StackCopyRefusedError';
}

/** A platform whose WebCrypto lacks Ed25519, so no live copy can be checked. */
class Ed25519UnsupportedError extends Error {
  override readonly name = 'Ed25519UnsupportedError';
}

/** The bundled copy's sequence. Throws when the copy is malformed, which its build check rules out. */
function readBundledSequence({ pointer, descriptor }: BundledStack): number {
  try {
    return parseDescriptor(descriptor).sequence;
  } catch (error) {
    throw new Error(`The bundled descriptor of stack ${pointer} is malformed: ${getErrorMessage(error)}`, {
      cause: error,
    });
  }
}

/**
 * The envelope `{ $v, payload, signature }` and the sequence of its payload, the base64 of the descriptor's JSON.
 * Throws a `StackCopyRefusedError` on any other shape, or when the payload's `$v` differs from the envelope's.
 */
function parseDescriptor(bytes: Uint8Array): ParsedDescriptor {
  const envelope = parseJson(bytes, 'descriptor');
  if (
    !isRecord(envelope) ||
    envelope['$v'] !== DESCRIPTOR_VERSION ||
    typeof envelope['payload'] !== 'string' ||
    typeof envelope['signature'] !== 'string' ||
    !SIGNATURE_PATTERN.test(envelope['signature'])
  ) {
    throw new StackCopyRefusedError(`The descriptor is not a version ${String(DESCRIPTOR_VERSION)} signed envelope`);
  }
  let payload: Uint8Array<ArrayBuffer>;
  try {
    payload = Uint8Array.from(atob(envelope['payload']), character => character.charCodeAt(0));
  } catch (error) {
    throw new StackCopyRefusedError('The descriptor payload is not base64', { cause: error });
  }
  const body = parseJson(payload, 'payload');
  if (!isRecord(body) || body['$v'] !== envelope['$v']) {
    throw new StackCopyRefusedError(`The descriptor payload is not version ${String(DESCRIPTOR_VERSION)}`);
  }
  const sequence = body['sequence'];
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new StackCopyRefusedError(`The descriptor payload's sequence ${String(sequence)} is not a whole number`);
  }
  return { payload, signature: new Uint8Array(fromHex(envelope['signature'])), sequence };
}

function parseJson(bytes: Uint8Array, part: string): unknown {
  try {
    return JSON.parse(UTF8.decode(bytes));
  } catch (error) {
    throw new StackCopyRefusedError(`The descriptor ${part} is not UTF-8 JSON`, { cause: error });
  }
}

/** The URL the live descriptor is served at, from the stack's link. Throws when the link names none. */
function getDescriptorUrl(pointer: string): string {
  const url = new URL(pointer).searchParams.get('url');
  if (url === null) {
    throw new Error(`Stack link ${pointer} names no descriptor URL`);
  }
  return url;
}

/** The response's body. Rejects on a non-ok answer or a body over the cap, which is cancelled unread. */
async function readCapped(url: string, response: Response): Promise<Uint8Array> {
  if (!response.ok) {
    throw new Error(`GET ${url} answered ${String(response.status)}`);
  }
  if (response.body === null) {
    return new Uint8Array();
  }
  if (Number(response.headers.get('content-length')) > MAX_DESCRIPTOR_BYTES) {
    await response.body.cancel();
    throw new Error(`GET ${url} answered a body over ${String(MAX_DESCRIPTOR_BYTES)} bytes`);
  }
  // Read through a reader, since Safari 17 cannot iterate a stream with `for await`.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    length += chunk.value.length;
    if (length > MAX_DESCRIPTOR_BYTES) {
      await reader.cancel();
      throw new Error(`GET ${url} answered a body over ${String(MAX_DESCRIPTOR_BYTES)} bytes`);
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
