// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The calls this side serves. It runs the handler registered for each method and answers with its `Result`, and
// answers the library's own outcomes itself: no handler, a payload that does not decode, a handler that throws, and an
// address this schema lacks.

import { createAsyncTaskPool } from '@dotli/shared';
import type { Address } from './calls.js';
import { decodeReason, failureReason } from './errors.js';
import { err, hostFailure, malformedFrame, unsupported, type CallError, type Result } from './result.js';
import type { HelloOf, Schema } from './schema.js';
import { encodeMessage, type Header, type Leg, type MethodMessage, type UnknownAddressMessage } from './wire.js';

type Outcome = Result<unknown, CallError<unknown>>;

/** What a handler knows about the peer that called it. */
export interface CallContext<S extends Schema> {
  /** The peer's origin when the call arrived, or null when it has none. */
  origin: string | null;
  /** The peer's handshake hello. */
  hello: HelloOf<S>;
}

/** A request or a start, which carries the call's payload. */
type CallMessage = Extract<MethodMessage, { payload: unknown }>;

export type AnyHandler = (payload: unknown, context: CallContext<Schema>) => Outcome | PromiseLike<Outcome>;

export interface ServingDeps {
  schema: Schema;
  /** Posts bytes. A post the provider throws on is already reported when it returns the error. */
  post: (data: ArrayBuffer, leg: Leg) => Result<void, unknown>;
  /** The context of a call from the peer, or null before the handshake has told who the peer is. */
  context: () => CallContext<Schema> | null;
  /** Whether the transport has closed, after which the peer hears nothing. */
  closed: () => boolean;
  /** Reports a call this side cannot serve and must not answer. */
  refuse: (cause: Error) => void;
}

export interface Serving {
  /** One handler per method. Returns what unregisters it. */
  handleRequest(address: Address, name: string, handler: AnyHandler): () => void;
  onRequest(message: CallMessage): void;
  onStart(message: CallMessage): void;
  /** Answers a call whose payload did not decode. */
  onMalformed(header: Header, cause: unknown): void;
  /** Answers a message for an address this schema lacks on the protocol error address. */
  onUnknownAddress(message: UnknownAddressMessage): void;
}

// Trait and method ids are each a byte, so this key is unique per method.
const keyOf = ({ trait, method }: Address): number => trait * 256 + method;

export function createServing(deps: ServingDeps): Serving {
  const { schema, post, context, closed, refuse } = deps;
  const requestHandlers = new Map<number, AnyHandler>();
  // Runs the request handlers. The pool answers a handler that throws at once like one that rejects.
  const handlers = createAsyncTaskPool({ poolSize: Number.POSITIVE_INFINITY });

  const answer = (header: Header & { leg: 'response' | 'interrupt' }, outcome: Outcome): void => {
    if (closed()) {
      return;
    }
    const message = { kind: 'method', ...header } as const;
    let data: ArrayBuffer;
    try {
      data = encodeMessage(schema, { ...message, outcome });
    } catch (error) {
      // An outcome the wire cannot carry, such as a domain error the method does not declare, is the handler's fault.
      data = encodeMessage(schema, { ...message, outcome: err(hostFailure(failureReason(error))) });
    }
    post(data, header.leg);
  };

  const answerCall = (header: Header, outcome: Outcome): void => {
    const { id, trait, method } = header;
    if (header.leg === 'request') {
      answer({ id, trait, method, leg: 'response' }, outcome);
    } else if (header.leg === 'start') {
      answer({ id, trait, method, leg: 'interrupt' }, outcome);
    }
  };

  return {
    handleRequest(address, name, handler) {
      const key = keyOf(address);
      if (requestHandlers.has(key)) {
        throw new Error(`${name} already has a handler`);
      }
      requestHandlers.set(key, handler);
      return () => {
        if (requestHandlers.get(key) === handler) {
          requestHandlers.delete(key);
        }
      };
    },

    onRequest(message) {
      const callContext = context();
      if (callContext === null) {
        refuse(new Error('A request came before the handshake'));
        return;
      }
      const handler = requestHandlers.get(keyOf(message));
      if (handler === undefined) {
        answerCall(message, err(unsupported()));
        return;
      }
      void handlers
        .call(() => handler(message.payload, callContext))
        .then(
          outcome => {
            answerCall(message, outcome);
          },
          (error: unknown) => {
            answerCall(message, err(hostFailure(failureReason(error))));
          },
        );
    },

    onStart(message) {
      answerCall(message, err(unsupported()));
    },

    onMalformed(header, cause) {
      answerCall(header, err(malformedFrame(decodeReason(cause))));
    },

    onUnknownAddress(message) {
      if (closed()) {
        return;
      }
      const data = encodeMessage(schema, {
        kind: 'protocolError',
        id: message.id,
        unsupportedMessage: message.unknownAddress,
      });
      post(data, 'response');
    },
  };
}
