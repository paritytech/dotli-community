// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A network's signed stack for a start: the stored copy when there is one, so the start waits on no fetch, and the live
// copy fetched behind it and stored for the next start. The bundled copy is the floor. A copy is stored only once its
// consumer accepts it. A consumer that cannot be asked, since it fails its whole start on a copy it refuses, has the
// copy's signature checked in its place.

import { loadStack, type BundledStack, type Network } from '@dotli/config';
import { createReporter, defineCount } from '@dotli/metrics';
import {
  createAsyncTaskPool,
  createLazyLoad,
  fromHex,
  getErrorMessage,
  isRecord,
  realTimers,
  withTimeout,
  type Timers,
} from '@dotli/shared';
import { stackStore, type StackStore, type StoredLightSpecs, type StoredStack } from './stackStore.js';

/** What a read of a network's stack resolves with. */
export type StackRead = {
  /** The copy to start from. */
  stack: BundledStack;
  /**
   * A verified live copy newer than `stack`, resolved once its write settles, whether or not the store kept it, or
   * `null` when none arrived.
   */
  newer: Promise<BundledStack | null>;
};

/** A live copy newer than the one a start opened, not stored until its consumer keeps it. */
export type StackOffer = BundledStack & {
  /**
   * Stores this copy with the light specs its consumer accepted it with, in one write, for the next start. Writes
   * nothing when a newer copy is stored by then. A failed write keeps the old copy and specs and is reported.
   */
  keep: (lightSpecs: StoredLightSpecs) => Promise<void>;
};

/** A copy to start from. A fetched copy carries the `keep` that stores it, and a stored or bundled one `null`. */
export type StackOfferStart = BundledStack & { keep: StackOffer['keep'] | null };

/** What a read of a network's stack resolves with, for a consumer that confirms a copy itself. */
export type StackOfferRead = {
  stack: StackOfferStart;
  /** A live copy newer than `stack`, or `null` when none arrived. */
  newer: Promise<StackOffer | null>;
  lightSpecs: {
    /** The light specs kept for the network, empty when none. */
    held: StoredLightSpecs;
    /** Replaces the kept set, for a start from a stored or bundled copy. */
    set: (specs: StoredLightSpecs) => Promise<void>;
  };
};

type Params = {
  /** Loads a network's bundled copy. */
  loadBundled?: (network: Network) => Promise<BundledStack>;
  fetch?: typeof fetch;
  /** Checks a live copy's signature. */
  subtle?: Pick<SubtleCrypto, 'importKey' | 'verify'>;
  /** The fetch's timeout and retry waits run on them. */
  timers?: Timers;
};

type CreateStackReaderParams = Params & {
  store?: Pick<StackStore, 'getStack' | 'setStackUnlessLightSpecs'>;
};

type CreateStackOfferReaderParams = Params & {
  store?: Pick<StackStore, 'getStack' | 'getLightSpecs' | 'setLightSpecs' | 'setStackAndLightSpecs'>;
};

/** A descriptor that parsed, with what its signature covers. */
type ParsedDescriptor = {
  payload: Uint8Array<ArrayBuffer>;
  signature: Uint8Array<ArrayBuffer>;
  sequence: number;
};

/** A live copy that passed its check. */
type LiveCopy = {
  stack: BundledStack;
  sequence: number;
  /** `false` where the platform cannot check an Ed25519 signature. */
  verified: boolean;
};

/** What a stack's link names: the key its descriptor is signed with and the URL the live descriptor is served at. */
type StackLink = {
  pointer: string;
  key: string;
  url: string;
};

/** What a read opens: the copy to start from and the live copy behind it. */
type OpenedStack = {
  start: BundledStack;
  /** The live copy `start` is, when nothing usable was stored and the start waited on the fetch. */
  fetched: LiveCopy | null;
  /** A live copy newer than `start`, verified or not, or `null` when none arrived. */
  newer: Promise<LiveCopy | null>;
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

/**
 * The stack reader for a consumer that cannot be asked whether it accepts a copy without starting from it. A live copy
 * is written once its signature verifies, so a platform without Ed25519 writes nothing. The write keeps the stored copy
 * once the light client has written specs for the network, since from then on only the light client replaces it, or
 * where the stored copy is newer. `store` is the page's own stack store by default.
 */
export function createStackReader({ store = stackStore, ...params }: CreateStackReaderParams = {}) {
  const source = createStackSource({ ...params, store });

  /**
   * Resolves with the copy to start from and the newer live copy to come. Each read starts from the copy stored by
   * then, and reads of one network share one live fetch. Rejects when the bundled copy fails to load or its descriptor or link is malformed.
   */
  async function read(network: Network): Promise<StackRead> {
    const { start, fetched, newer } = await source.open(network);
    if (fetched !== null) {
      await store.setStackUnlessLightSpecs(toStoredStack(network, fetched));
    }
    return {
      stack: start,
      newer: newer.then(async copy => {
        if (copy?.verified !== true) {
          return null;
        }
        await store.setStackUnlessLightSpecs(toStoredStack(network, copy));
        return copy.stack;
      }),
    };
  }

  return { read };
}

export type StackReader = ReturnType<typeof createStackReader>;

/**
 * The stack reader for a consumer that confirms a copy itself, such as an engine that checks the descriptor's
 * signature and its parts. It stores nothing on its own: a live copy, whether started from or newer, is handed on
 * unstored and stored with its light specs once the consumer keeps it. Where the platform cannot check Ed25519 a newer
 * copy is handed on all the same, since the consumer checks it. `store` is the page's own stack store by default.
 */
export function createStackOfferReader({ store = stackStore, ...params }: CreateStackOfferReaderParams = {}) {
  const source = createStackSource({ ...params, store });

  /**
   * Resolves with the copy to start from and the newer live copy to come. Each read starts from the copy stored by
   * then, and reads of one network share one live fetch. Rejects when the bundled copy fails to load or its descriptor or link is malformed.
   */
  async function read(network: Network): Promise<StackOfferRead> {
    const [{ start, fetched, newer }, held] = await Promise.all([source.open(network), store.getLightSpecs(network)]);

    function offer(copy: LiveCopy): StackOffer {
      return {
        ...copy.stack,
        keep: lightSpecs => store.setStackAndLightSpecs(toStoredStack(network, copy), lightSpecs),
      };
    }

    return {
      stack: fetched === null ? { ...start, keep: null } : offer(fetched),
      newer: newer.then(copy => (copy === null ? null : offer(copy))),
      lightSpecs: { held, set: specs => store.setLightSpecs(network, specs) },
    };
  }

  return { read };
}

export type StackOfferReader = ReturnType<typeof createStackOfferReader>;

/**
 * What both readers share: the policy that picks the copy to start from, and the live copy fetched and checked once per
 * network.
 */
function createStackSource({
  store,
  loadBundled = loadStack,
  fetch: fetchResource = fetch,
  subtle = globalThis.crypto.subtle,
  timers = realTimers,
}: Params & { store: Pick<StackStore, 'getStack'> }) {
  // Unbounded, since each network fetches once. The pool only retries.
  const pool = createAsyncTaskPool({
    poolSize: Number.POSITIVE_INFINITY,
    retryCount: FETCH_RETRY_COUNT,
    retryDelay: retry => FETCH_RETRY_BASE_MS * 2 ** retry,
    timers,
  });
  // One live copy per network for the page's life. A failed fetch is not kept, so the next read fetches again.
  const liveFetches = new Map<Network, () => Promise<LiveCopy | null>>();

  /**
   * The copy to start from and the live copy behind it. The stored and the bundled copy are read at once. With one
   * stored, the start opens the higher of the two and waits on no fetch. Without, it waits on the live copy and opens it
   * once it verified and is at least the bundled one. Rejects as `read` does.
   */
  async function open(network: Network): Promise<OpenedStack> {
    const storedRead = store.getStack(network);
    const bundled = await loadBundled(network);
    const bundledSequence = readBundledSequence(bundled);
    const link = readLink(bundled.pointer);
    const live = readLive(network, bundled, link);
    const storedRecord = await storedRead;
    // A copy kept under another link is signed by another key, so it is not this stack's.
    const stored = storedRecord?.pointer === bundled.pointer ? storedRecord : null;
    if (stored !== null) {
      const start = pickStart(bundled, bundledSequence, stored);
      return {
        start: start.stack,
        fetched: null,
        newer: live.then(copy => (copy !== null && copy.sequence > start.sequence ? copy : null)),
      };
    }
    const copy = await live;
    if (copy === null || copy.sequence < bundledSequence) {
      return { start: bundled, fetched: null, newer: Promise.resolve(null) };
    }
    if (!copy.verified) {
      // A copy the platform could not check may still fail the consumer's own check, so it is offered, not started
      // from.
      return { start: bundled, fetched: null, newer: Promise.resolve(copy.sequence > bundledSequence ? copy : null) };
    }
    return { start: copy.stack, fetched: copy, newer: Promise.resolve(null) };
  }

  /**
   * The live copy, fetched and checked once per network, or `null` when it is refused or once the fetch still fails
   * after its retries, which is reported.
   */
  async function readLive(network: Network, bundled: BundledStack, link: StackLink): Promise<LiveCopy | null> {
    let load = liveFetches.get(network);
    if (load === undefined) {
      load = createLazyLoad({
        load: async () => check(await pool.call(() => fetchDescriptor(link.url)), bundled, link),
      });
      liveFetches.set(network, load);
    }
    try {
      return await load();
    } catch (error) {
      report.expected(error, {
        step: 'stack_live_fetch',
        metric: stackLiveCopyMetric,
        attributes: { step: 'fetch' },
        message: `[dot.li stack] the live descriptor of ${link.pointer} could not be fetched: ${getErrorMessage(error)}`,
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
   * The copy in `bytes` once it parses, verified against the key in `link` where the platform can check Ed25519, else
   * `null`. A refused one, and a gap in the platform's check, is reported.
   */
  async function check(bytes: Uint8Array, bundled: BundledStack, link: StackLink): Promise<LiveCopy | null> {
    let parsed: ParsedDescriptor;
    try {
      parsed = parseDescriptor(bytes);
    } catch (error) {
      reportCheck(error, link.pointer);
      return null;
    }
    const stack = toStack(bundled, bytes);
    try {
      await verifySignature(parsed, link.key);
      return { stack, sequence: parsed.sequence, verified: true };
    } catch (error) {
      reportCheck(error, link.pointer);
      return error instanceof Ed25519UnsupportedError ? { stack, sequence: parsed.sequence, verified: false } : null;
    }
  }

  /**
   * Resolves once the signature over the payload verifies against `key`. Rejects with an
   * `Ed25519UnsupportedError` when the platform cannot check it, and with a `StackCopyRefusedError` otherwise.
   */
  async function verifySignature({ payload, signature }: ParsedDescriptor, key: string): Promise<void> {
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

  return { open };
}

/** A live copy that is not a signed descriptor of this stack, such as an error page answered with success. */
class StackCopyRefusedError extends Error {
  override readonly name = 'StackCopyRefusedError';
}

/** A platform whose WebCrypto lacks Ed25519, so no live copy can be checked. */
class Ed25519UnsupportedError extends Error {
  override readonly name = 'Ed25519UnsupportedError';
}

function reportCheck(error: unknown, pointer: string): void {
  report.expected(error, {
    step: 'stack_live_check',
    metric: stackLiveCopyMetric,
    attributes: { step: 'check' },
    message: `[dot.li stack] the live descriptor of ${pointer} did not pass its check: ${getErrorMessage(error)}`,
  });
}

/** With a stored copy, the copy to start from: the stored one, or the bundled one when its sequence is higher. */
function pickStart(
  bundled: BundledStack,
  bundledSequence: number,
  stored: StoredStack,
): { stack: BundledStack; sequence: number } {
  return stored.sequence > bundledSequence
    ? { stack: toStack(bundled, stored.descriptor), sequence: stored.sequence }
    : { stack: bundled, sequence: bundledSequence };
}

function toStoredStack(network: Network, { stack: { pointer, descriptor }, sequence }: LiveCopy): StoredStack {
  return { network, pointer, descriptor, sequence };
}

function toStack(bundled: BundledStack, descriptor: Uint8Array): BundledStack {
  return { ...bundled, descriptor };
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

/** The key and the descriptor URL the bundled link names. Throws when it names no Ed25519 key or no URL, which its build check rules out. */
function readLink(pointer: string): StackLink {
  const { searchParams } = new URL(pointer);
  const key = searchParams.get('key');
  const url = searchParams.get('url');
  if (key === null || !KEY_PATTERN.test(key) || url === null) {
    throw new Error(`The bundled link ${pointer} names no Ed25519 key or no descriptor URL`);
  }
  return { pointer, key, url };
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
