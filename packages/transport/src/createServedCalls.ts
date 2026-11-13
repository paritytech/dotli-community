// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The calls this side serves. Each method's handler decodes the peer's messages with the method's own codec, answers a
// request with its `Result` and streams a subscription until one side ends it. The library's own outcomes, no handler,
// a message that does not decode and a handler that throws, go back as a failure frame. Only calls the transport
// admitted reach this side, once the handshake told who the peer is.

import { toError } from '@dotli/shared';
import type { ResultPayload } from 'scale-ts';
import type { CallError } from './callError.js';
import type { Connection } from './createConnection.js';
import type { IssueReport } from './createIssueReport.js';
import { decodeOr } from './decodeOr.js';
import { isSameMethod, type Address, type Schema, type Sections } from './defineSchema.js';
import { hostFailure, malformedFrame, unsupported, type Failure } from './failure.js';
import { encodeCall, encodeFrame, type Call, type EncodeCallParams } from './frame.js';
import type { FrameBytes } from './frameBytes.js';
import type { MessageBytes } from './messageBytes.js';
import type { AnyMethod, Request, Subscription } from './method.js';
import type { CallContext, Running, Served, ServedCall } from './types.js';

/** What a subscription handler sends on. Both do nothing once the subscription has ended. */
export type Sink<Value, Interrupt> = {
  /** Sends a value. One the wire cannot carry ends the subscription with `HostFailure`. */
  send(value: Value): void;
  /** Ends the subscription with `reason`, the method's own interrupt type, which the subscriber hears as it is. */
  interrupt(reason: Interrupt): void;
};

/** Serves one request method. It answers with a `Result`, and a throw or rejection answers `HostFailure`. */
export type RequestHandler<Payload, Response, Domain, Hello> = (
  payload: Payload,
  context: CallContext<Hello>,
) => ResultPayload<Response, CallError<Domain>> | PromiseLike<ResultPayload<Response, CallError<Domain>>>;

/**
 * Serves one subscription method. It starts the subscription, sends on the sink, and returns what stops it, which runs
 * once on the peer's stop, an interrupt, a start that reuses its id, or a close. A throw on start interrupts with
 * `HostFailure`.
 */
export type SubscriptionHandler<Start, Value, Interrupt, Hello> = (
  start: Start,
  context: CallContext<Hello>,
  sink: Sink<Value, Interrupt>,
) => () => void;

/** The calls one transport serves. */
export type ServedCalls<Hello> = ReturnType<typeof createServedCalls<Hello>>;

type Params = {
  schema: Pick<Schema<unknown, Sections>, 'addressOf' | 'methodAt'>;
  connection: Pick<Connection<unknown>, 'post'>;
  issues: IssueReport;
};

type RegisterParams<Hello> = {
  method: AnyMethod;
  /** Where `method` sits, which the error for a second handler names. */
  address: Address;
  served: Served<Hello>;
};

type PostFailedParams = {
  id: number;
  failure: Failure;
  /** The call's method, if its message named one of this schema's. */
  address?: Address | undefined;
};

type AnswerMalformedParams = {
  id: number;
  /** Why the call's message does not decode. */
  cause: Error;
  address: Address;
};

type StartParams<Start, Hello> = {
  id: number;
  start: Start;
  context: CallContext<Hello>;
};

type HearParams<Hello> = {
  id: number;
  call: Call<MessageBytes>;
  context: CallContext<Hello>;
};

/** The calls this side serves: one handler per method, the requests in flight and the subscriptions running. */
export function createServedCalls<Hello>({ schema, connection, issues }: Params) {
  const handlers = new Map<AnyMethod, Served<Hello>>();
  // The peer's requests whose handlers have not settled, by id, with what drops each. A close drops them, so none is
  // answered.
  const inFlight = new Map<number, () => void>();
  const running = new Map<number, Running>();

  function handleRequest<Payload, Response, Domain>(
    method: Request<Payload, Response, Domain>,
    handler: RequestHandler<NoInfer<Payload>, NoInfer<Response>, NoInfer<Domain>, Hello>,
  ): () => void {
    const address = schema.addressOf(method);

    function serve({ id, message: bytes, context }: ServedCall<Hello>): void {
      const message = decodeOr({
        decoder: method.wholeMessage,
        data: bytes,
        onError: cause => {
          answerMalformed({ id, cause, address });
        },
      });
      if (message === undefined) {
        return;
      }
      if (message.tag !== 'request') {
        issues.refuse('invalid', new Error(`A response names call ${String(id)}, which the peer made`));
        return;
      }
      const payload = message.value;
      // A handler's late answer finds its id gone, so dropping it needs nothing more.
      inFlight.set(id, () => undefined);
      // Run in the turn the call arrives, and a handler that throws answers like one that rejects.
      void new Promise<ResultPayload<Response, CallError<Domain>>>(resolve => {
        resolve(handler(payload, context));
      }).then(
        outcome => {
          // A closed transport dropped the call, and answers nothing.
          if (inFlight.delete(id)) {
            reply({ method, address, id, message: { tag: 'response', value: outcome } });
          }
        },
        (error: unknown) => {
          if (inFlight.delete(id)) {
            postFailed({ id, failure: hostFailure(toError(error)), address });
          }
        },
      );
    }

    return register({ method, address, served: serve });
  }

  function handleSubscription<Start, Value, Interrupt>(
    method: Subscription<Start, Value, Interrupt>,
    handler: SubscriptionHandler<NoInfer<Start>, NoInfer<Value>, NoInfer<Interrupt>, Hello>,
  ): () => void {
    const address = schema.addressOf(method);

    /** Runs the handler, and keeps the subscription running until either side ends it. */
    function startSubscription({ id, start, context }: StartParams<Start, Hello>): void {
      let stop: (() => void) | null = null;

      /**
       * Ends the subscription once: `send`, if any, tells the peer, then the stop function runs. The peer hears it
       * first, so a stop function that disposes the transport cannot keep it from the peer.
       */
      function finish(send?: () => void): void {
        if (!end(id, entry)) {
          return;
        }
        send?.();
        if (stop !== null) {
          issues.runListener(stop);
        }
      }

      /** Ends it with a failure the peer hears. */
      function failWith(failure: Failure): void {
        finish(() => {
          postFailed({ id, failure, address });
        });
      }

      const entry: Running = {
        address,
        hear(bytes) {
          const message = decodeOr({
            decoder: method.wholeMessage,
            data: bytes,
            onError: error => {
              issues.refuse('malformed', error);
            },
          });
          if (message === undefined) {
            return;
          }
          if (message.tag !== 'stop') {
            issues.refuse('invalid', new Error(`A ${message.tag} names subscription ${String(id)}, which is running`));
            return;
          }
          finish();
        },
        drop: () => {
          finish();
        },
      };
      running.set(id, entry);

      const sink: Sink<Value, Interrupt> = {
        send(value) {
          if (running.get(id) !== entry) {
            return;
          }
          let data: FrameBytes;
          try {
            data = encodeCall({ method, address, id, message: { tag: 'receive', value } });
          } catch (error) {
            failWith(hostFailure(toError(error)));
            return;
          }
          connection.post({ data, address });
        },
        interrupt(reason) {
          finish(() => {
            reply({ method, address, id, message: { tag: 'interrupt', value: reason } });
          });
        },
      };
      try {
        stop = handler(start, context, sink);
      } catch (error) {
        failWith(hostFailure(toError(error)));
        return;
      }
      if (running.get(id) !== entry) {
        // Ended while the handler ran, before it could say how to stop.
        issues.runListener(stop);
      }
    }

    function serve({ id, message: bytes, context }: ServedCall<Hello>): void {
      const message = decodeOr({
        decoder: method.wholeMessage,
        data: bytes,
        onError: cause => {
          answerMalformed({ id, cause, address });
        },
      });
      if (message === undefined) {
        return;
      }
      if (message.tag !== 'start') {
        issues.refuse('invalid', new Error(`A ${message.tag} names subscription ${String(id)}, which is not running`));
        return;
      }
      startSubscription({ id, start: message.value, context });
    }

    return register({ method, address, served: serve });
  }

  function register({ method, address, served }: RegisterParams<Hello>): () => void {
    if (handlers.has(method)) {
      throw new Error(`${address.section}.${address.method} already has a handler`);
    }
    handlers.set(method, served);
    return () => {
      if (handlers.get(method) === served) {
        handlers.delete(method);
      }
    };
  }

  function postFailed({ id, failure, address }: PostFailedParams): void {
    connection.post({ data: encodeFrame({ id, body: { tag: 'failed', value: failure } }), address });
  }

  function answerMalformed({ id, cause, address }: AnswerMalformedParams): void {
    issues.refuse('malformed', cause);
    postFailed({ id, failure: malformedFrame(cause), address });
  }

  /** Sends `message` on call `id`, or answers `HostFailure` for one the wire cannot carry. Never throws. */
  function reply<Message>({ method, address, id, message }: EncodeCallParams<Message>): void {
    let data: FrameBytes;
    try {
      data = encodeCall({ method, address, id, message });
    } catch (error) {
      postFailed({ id, failure: hostFailure(toError(error)), address });
      return;
    }
    connection.post({ data, address });
  }

  function hear({ id, call, context }: HearParams<Hello>): void {
    const entry = running.get(id);
    const method = schema.methodAt(call.sectionId, call.methodId);
    const leg = readLeg(method, call.message);
    if (entry !== undefined && leg !== 'start') {
      if (!isSameMethod(entry.address, call)) {
        issues.refuse('invalid', new Error(`A message for subscription ${String(id)} names another method`));
        return;
      }
      entry.hear(call.message);
      return;
    }
    if (inFlight.has(id)) {
      // As truapi refuses a reused id, the request in flight keeps it, and its one answer.
      issues.refuse('invalid', new Error(`A ${leg ?? 'message'} names call ${String(id)}, which is still in flight`));
      return;
    }
    if (entry !== undefined) {
      // A start on a running id subscribes anew, as truapi does: the running one stops with nothing sent.
      entry.drop();
    } else if (leg === 'stop') {
      // A stop for a subscription that is not running stops nothing, such as one that crossed this side's end.
      return;
    }
    if (!isOpeningLeg(leg)) {
      issues.refuse(
        'invalid',
        new Error(`A ${leg ?? 'message'} names call ${String(id)}, which the peer never opened`),
      );
      return;
    }
    const served = method === undefined ? undefined : handlers.get(method);
    if (served === undefined) {
      postFailed({ id, failure: unsupported(), address: method === undefined ? undefined : schema.addressOf(method) });
      return;
    }
    served({ id, message: call.message, context });
  }

  function answerEarly(id: number, call: Call<MessageBytes>): void {
    issues.refuse('invalid', new Error('A call came before the handshake'));
    if (isOpeningLeg(readLeg(schema.methodAt(call.sectionId, call.methodId), call.message))) {
      postFailed({ id, failure: hostFailure('The handshake is not over') });
    }
  }

  function dropAll(): void {
    const dropped = [...inFlight.values()];
    inFlight.clear();
    for (const drop of dropped) {
      drop();
    }
    for (const entry of [...running.values()]) {
      entry.drop();
    }
  }

  function holdRequest(id: number, drop: () => void): void {
    inFlight.set(id, drop);
  }

  function releaseRequest(id: number): boolean {
    return inFlight.delete(id);
  }

  function run(id: number, entry: Running): void {
    running.set(id, entry);
  }

  function end(id: number, entry: Running): boolean {
    if (running.get(id) !== entry) {
      return false;
    }
    running.delete(id);
    return true;
  }

  return {
    /**
     * Serves one method. One handler per method, and calling the returned function unregisters it. Throws for a method
     * this schema lacks, and for a method that already has a handler.
     */
    handleRequest,
    /**
     * Serves one subscription method. One handler per method, and calling the returned function unregisters it. Throws
     * for a method this schema lacks, and for a method that already has a handler.
     */
    handleSubscription,
    /** Hands a message of the peer's call `id` to what serves it. Never throws. */
    hear,
    /**
     * Answers a call of the peer's that came before the handshake was over, whose handler never runs, with
     * `HostFailure`. A message that reads as no request or start opens no call, so it is only refused. Never throws.
     */
    answerEarly,
    /** Drops the peer's requests in flight, so none is answered, and stops each subscription served. */
    dropAll,
    /** Stores one handler per method, and returns what unregisters it. Throws for a method that already has one. */
    register,
    /** Answers call `id` with a failure of the library's own. Never throws. */
    postFailed,
    /** Answers a call whose message does not decode, and reports it. Never throws. */
    answerMalformed,
    /** Keeps the peer's request `id` in flight, with what drops it on a close. */
    holdRequest,
    /** Ends the peer's request `id`. Returns whether it was still in flight, so its one answer goes out. */
    releaseRequest,
    /** Keeps `entry` as the subscription the peer opened on `id`. */
    run,
    /** Ends the subscription `entry` on `id`. Returns whether it was still the one running there. */
    end,
  };
}

/** Whether a message opens a call this side answers. One whose leg does not read is answered too, as malformed. */
function isOpeningLeg(leg: string | undefined): boolean {
  return leg === undefined || leg === 'request' || leg === 'start';
}

/** The leg a message of `method` reads as, or undefined when the schema has no such method or it reads as none. */
function readLeg(method: AnyMethod | undefined, message: MessageBytes): string | undefined {
  if (method === undefined) {
    return undefined;
  }
  // A message whose leg does not read has none.
  return decodeOr({ decoder: method.leg, data: message, onError: () => undefined })?.tag;
}
