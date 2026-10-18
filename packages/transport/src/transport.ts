// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One transport per provider for the provider's whole life, the same on every side. It reads each message once and
// hands it by kind and leg to the handshake, to the calls this side makes, or to the calls it serves. It owns whether
// the transport is open, and everything the parts cannot handle goes to the owner's issue hook.

import { realTimers, type Timers } from '@dotli/shared';
import { createCalls } from './calls.js';
import { logIssue, type TransportIssue } from './errors.js';
import { createAccepter, createOpener } from './handshake.js';
import type { Provider } from './provider.js';
import { err, ok, type Result } from './result.js';
import {
  methodAddress,
  type HelloOf,
  type MethodName,
  type MethodTypes,
  type RequestMethodName,
  type Schema,
  type TraitName,
} from './schema.js';
import { createServing, type AnyHandler, type CallContext } from './serving.js';
import { decodeMessage, type Leg } from './wire.js';

const DEFAULT_RETRY_MS = 50;
const DEFAULT_TIMEOUT_MS = 5_000;
// The largest id the wire's u32 carries. Ids wrap long after any call with an old one has settled.
const MAX_ID = 0xffff_ffff;

interface BaseOptions {
  /** Which side opens the handshake. The other accepts it. */
  handshake: 'open' | 'accept';
  /** How often the opener posts a fresh handshake until it is answered. */
  retryMs?: number;
  /** How long the opener waits for an answer, on the running clock. */
  timeoutMs?: number;
  timers?: Timers;
  /** Hears what the transport cannot handle itself. With none, each issue is logged as an error. */
  onIssue?: (issue: TransportIssue) => void;
}

/** A transport's options. `hello` is this side's handshake value, required exactly when the schema declares one. */
export type TransportOptions<S extends Schema> = BaseOptions &
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- a schema without a hello has a void one
  ([HelloOf<S>] extends [void] ? { hello?: undefined } : { hello: HelloOf<S> });

export interface RequestOptions {
  /** Gives up on the call: it resolves `Cancelled` and a late answer is ignored. The peer is not told. */
  signal?: AbortSignal;
}

type Payload<S extends Schema, T extends TraitName<S>, M extends MethodName<S, T>> =
  MethodTypes<S, T, M> extends { request: infer P } ? P : never;
type Answer<S extends Schema, T extends TraitName<S>, M extends MethodName<S, T>> =
  MethodTypes<S, T, M> extends { response: infer R } ? R : never;

/** Serves one request method. It answers with a `Result`, and a throw or rejection answers `HostFailure`. */
export type RequestHandler<S extends Schema, T extends TraitName<S>, M extends RequestMethodName<S, T>> = (
  payload: Payload<S, T, M>,
  context: CallContext<S>,
) => Answer<S, T, M> | PromiseLike<Answer<S, T, M>>;

export interface Transport<S extends Schema> {
  /** Starts the handshake on the opener. Does nothing on the accepter, which waits for the opener. */
  connect(): void;
  /** Resolves once the handshake succeeds, and rejects with the closing error once the transport closes. */
  whenConnected(): Promise<void>;
  /**
   * Calls the peer. Resolves to its `Result`, or to `Cancelled` once the signal aborts. Calls made before the handshake
   * wait and go out in call order once it succeeds. Rejects only with the error the transport closed with, or when the
   * call cannot go out: a payload that does not encode or a post the provider throws on.
   */
  request<T extends TraitName<S>, M extends RequestMethodName<S, T>>(
    trait: T,
    method: M,
    payload: Payload<S, T, M>,
    options?: RequestOptions,
  ): Promise<Answer<S, T, M>>;
  /** Serves one method. One handler per method, and calling the returned function unregisters it. */
  handleRequest<T extends TraitName<S>, M extends RequestMethodName<S, T>>(
    trait: T,
    method: M,
    handler: RequestHandler<S, T, M>,
  ): () => void;
  /** Closes this side: every pending and later call rejects with `reason`, and the provider is disposed. */
  dispose(reason: Error): void;
}

type Phase = { name: 'connecting' } | { name: 'connected'; peerHello: unknown } | { name: 'closed'; error: Error };

export function createTransport<S extends Schema>(
  schema: S,
  provider: Provider,
  options: TransportOptions<S>,
): Transport<S> {
  const report = options.onIssue ?? logIssue;
  // The option exists exactly when the schema declares a hello, which its type has already checked.
  const { hello } = options as { hello?: unknown };

  let phase: Phase = { name: 'connecting' };
  let disposed = false;
  let lastId = 0;
  let endHandshake = (): void => undefined;
  // Settles once the handshake succeeds or fails, or the transport closes. The phase says which.
  const handshakeOver = new Promise<void>(resolve => {
    endHandshake = resolve;
  });

  const nextId = (): number => {
    lastId = lastId >= MAX_ID ? 1 : lastId + 1;
    return lastId;
  };
  const closedBy = (): Error | null => (phase.name === 'closed' ? phase.error : null);
  const refuse = (cause: Error): void => {
    report({ kind: 'refused', reason: 'invalid', cause });
  };
  const post = (data: ArrayBuffer, leg: Leg): Result<void, unknown> => {
    try {
      provider.post(data);
      return ok();
    } catch (error) {
      report({ kind: 'post_failed', leg, error });
      return err(error);
    }
  };

  const calls = createCalls({ schema, nextId, post, handshakeOver, closedBy, refuse });

  const onOpen = (peerHello: unknown): void => {
    if (phase.name !== 'connecting') {
      return;
    }
    phase = { name: 'connected', peerHello };
    endHandshake();
  };
  const close = (error: Error): void => {
    if (phase.name === 'closed') {
      return;
    }
    phase = { name: 'closed', error };
    endHandshake();
    calls.close(error);
  };

  const handshakeDeps = { schema, hello, nextId, post, refuse, onOpen, onFail: close };
  const handshake =
    options.handshake === 'open'
      ? createOpener({
          ...handshakeDeps,
          retryMs: options.retryMs ?? DEFAULT_RETRY_MS,
          timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          timers: options.timers ?? realTimers,
        })
      : createAccepter(handshakeDeps);

  const serving = createServing({
    schema,
    post,
    context: () => (phase.name === 'connected' ? { origin: provider.peerOrigin(), hello: phase.peerHello } : null),
    closed: () => phase.name === 'closed',
    refuse,
  });

  // Typed as unknown, since a provider of the owner's may hand over anything.
  const onData = (data: unknown): void => {
    if (!(data instanceof ArrayBuffer)) {
      report({ kind: 'refused', reason: 'not_bytes', cause: new TypeError(`Expected bytes, got ${typeof data}`) });
      return;
    }
    const decoded = decodeMessage(schema, data);
    if ('refused' in decoded) {
      report({ kind: 'refused', reason: decoded.refused, cause: decoded.cause });
      if (decoded.refused === 'malformed' && decoded.header !== undefined) {
        serving.onMalformed(decoded.header, decoded.cause);
      }
      return;
    }
    switch (decoded.kind) {
      case 'handshake':
        handshake.hear(decoded);
        return;
      case 'protocolError':
        // Nothing ever answers a protocol error, so two peers that both lack an address cannot loop.
        calls.onProtocolError(decoded);
        return;
      case 'unknownAddress':
        serving.onUnknownAddress(decoded);
        return;
      case 'method':
        switch (decoded.leg) {
          case 'request':
            serving.onRequest(decoded);
            return;
          case 'response':
            calls.onResponse(decoded);
            return;
          case 'start':
            serving.onStart(decoded);
            return;
          case 'receive':
          case 'interrupt':
            refuse(
              new Error(`A ${decoded.leg} leg names subscription ${String(decoded.id)}, which this side never opened`),
            );
            return;
          case 'stop':
            // This side runs no subscription, and a stop may cross the interrupt that answered its start.
            return;
        }
    }
  };
  // Providers do not buffer, so the listener is bound before anything can arrive.
  const unsubscribeProvider = provider.subscribe(onData);

  return {
    connect() {
      handshake.start();
    },

    async whenConnected() {
      await handshakeOver;
      const closed = closedBy();
      if (closed !== null) {
        throw closed;
      }
    },

    request(trait, method, payload, requestOptions = {}) {
      const address = methodAddress(schema, trait, method);
      return calls.request(
        { trait: address.traitId, method: address.methodId },
        payload,
        requestOptions.signal,
      ) as Promise<Answer<S, typeof trait, typeof method>>;
    },

    handleRequest(trait, method, handler) {
      const address = methodAddress(schema, trait, method);
      return serving.handleRequest(
        { trait: address.traitId, method: address.methodId },
        `${trait}.${method}`,
        // The handler was typed against this method's payload, which the address decodes to.
        handler as unknown as AnyHandler,
      );
    },

    dispose(reason) {
      if (disposed) {
        return;
      }
      disposed = true;
      handshake.stop(reason);
      close(reason);
      unsubscribeProvider();
      provider.dispose();
    },
  };
}
