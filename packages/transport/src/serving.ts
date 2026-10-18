// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The calls this side serves. It runs the handler registered for each method and answers with its `Result`, and
// answers the library's own outcomes itself: no handler, a payload that does not decode, a handler that throws, and an
// address this schema lacks. A call is served only once the handshake has told who the peer is, so a call before it, or
// after a failed one, is refused with no answer.

import { createAsyncTaskPool } from '@dotli/shared';
import { decodeReason, failureReason } from './errors.js';
import type { Address, Outcome, Post } from './parts.js';
import { err, hostFailure, malformedFrame, unsupported, type Result } from './result.js';
import type { HelloOf, Schema } from './schema.js';
import { encodeMessage, type Header, type MethodMessage, type UnknownAddressMessage } from './wire.js';

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
  post: Post;
  /** The context of a call from the peer, or why there is none: no handshake yet, or one that failed. */
  context: () => Result<CallContext<Schema>, Error>;
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
  /** Answers a call on a schema method whose payload did not decode. Its refusal is already reported. */
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

  /** The context of a call to serve, or undefined for a call refused before or after the handshake. */
  const admitted = (): CallContext<Schema> | undefined => {
    const callContext = context();
    if (!callContext.ok) {
      refuse(callContext.error);
      return undefined;
    }
    return callContext.value;
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
      const callContext = admitted();
      if (callContext === undefined) {
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
      if (admitted() !== undefined) {
        answerCall(message, err(unsupported()));
      }
    },

    onMalformed(header, cause) {
      // Refused as malformed already, so a call before the handshake is not reported a second time.
      if (context().ok) {
        answerCall(header, err(malformedFrame(decodeReason(cause))));
      }
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
