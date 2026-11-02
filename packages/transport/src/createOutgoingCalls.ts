// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The calls this side makes: requests and subscriptions, and the calls it opens for a forwarder. Each waits for the
// handshake to be over, then goes out. What comes back carries the call's id, and the call decodes it with its own
// method's codec.

import { toError } from '@dotli/shared';
import type { ResultPayload } from 'scale-ts';
import type { CallError } from './callError.js';
import type { CallIds } from './createCallIds.js';
import type { Connection } from './createConnection.js';
import type { IssueReport } from './createIssueReport.js';
import { createRecentIds } from './createRecentIds.js';
import { decodeOr } from './decodeOr.js';
import { isSameMethod, type Address, type Schema, type Sections } from './defineSchema.js';
import { cancelled, malformedFrame, type Failure } from './failure.js';
import { encodeCall, encodeCarriedCall, type Call } from './frame.js';
import type { FrameBytes } from './frameBytes.js';
import type { MessageBytes } from './messageBytes.js';
import type { Request, Subscription } from './method.js';
import { err } from './result.js';
import { TransportMalformedResponseError } from './transportMalformedResponseError.js';
import type { Heard } from './types.js';

/** What hears a call opened for a forwarder, and what sends on it. */
export type Forwarded = ReturnType<ReturnType<typeof createOutgoingCalls>['open']>;

/** What a subscriber hears: each value, then one end, unless it stops first. */
export type SubscriptionListeners<Value, Interrupt> = {
  /** A value the peer sent. */
  receive(value: Value): void;
  /** The peer's own end, the method's own interrupt reason as it is. */
  interrupt(reason: Interrupt): void;
  /** A failure of the library's: one the peer answered with, or `Cancelled` or `MalformedFrame` raised on this side. */
  fail(failure: Failure): void;
  /** The end raised on this side with an error: the transport closed, a failed post among the ways it does. */
  close(error: Error): void;
};

export type RequestParams = {
  /** Gives up on the call: it resolves `Cancelled` and a late answer is ignored. The peer is not told. */
  signal?: AbortSignal | undefined;
};

export type SubscribeParams<Start, Value, Interrupt> = {
  /** The subscription method, as the schema holds it. */
  method: Subscription<Start, Value, Interrupt>;
  /** What the subscription starts with, typed by the method. */
  start: NoInfer<Start>;
  /** What hears each value and the one end. */
  listeners: SubscriptionListeners<NoInfer<Value>, NoInfer<Interrupt>>;
  /** Gives up on the subscription: the peer is told to stop and `fail` hears `Cancelled`, once. */
  signal?: AbortSignal | undefined;
};

type Params = {
  /** Places each method a call names. Throws for a method the schema lacks. */
  schema: Pick<Schema<unknown, Sections>, 'addressOf'>;
  /** Numbers this side's calls. */
  ids: CallIds;
  /** Tells whether the transport is closed, posts the calls, and holds them until the handshake is over. */
  connection: Pick<Connection<unknown>, 'getPhase' | 'post' | 'place'>;
  /** Hears a message this side refuses, and runs each listener so its throw is reported. */
  issues: IssueReport;
  /** Starts the opener's handshake, and does nothing once it started or on the accepter. Never throws. */
  startHandshake: () => void;
};

/** What a call opened for a forwarder carries, and what hears the peer it goes to. */
export type OpenParams = {
  /** Where the call's method sits, on this transport and on the one that forwards to it. */
  address: Address;
  /** The call's first message, as its bytes. */
  message: MessageBytes;
  /** Hears each message on the call and its one end. */
  heard: Heard;
};

/** A call that went out, as the peer's messages reach it. */
type OutCall = {
  /** Where the call's method sits. */
  address: Address;
  /** Hands it a message of the peer's, as its bytes. */
  hear(message: MessageBytes): void;
  /** Ends it with the failure the peer answered it with. */
  fail(error: Failure): void;
  /** Ends it with the error the transport closed with. */
  close(error: Error): void;
};

/** The calls this side makes, each kept by its id until it ends. */
export function createOutgoingCalls({ schema, ids, connection, issues, startHandshake }: Params) {
  // The calls that went out and wait for the peer.
  const out = new Map<number, OutCall>();
  const ended = createRecentIds();

  function request<Payload, Response, Domain>(
    method: Request<Payload, Response, Domain>,
    payload: NoInfer<Payload>,
    { signal }: RequestParams = {},
  ): Promise<ResultPayload<Response, CallError<Domain>>> {
    const address = schema.addressOf(method);
    return new Promise<ResultPayload<Response, CallError<Domain>>>((resolve, reject) => {
      const phase = connection.getPhase();
      // A closed transport is never a call outcome, so its error wins over an aborted signal.
      if (phase.name === 'closed') {
        reject(phase.error);
        return;
      }
      startHandshake();
      if (signal?.aborted === true) {
        resolve(err(cancelled()));
        return;
      }
      const id = ids.takeNext();
      let done = false;

      /** Ends the call once. Returns whether it was still going. */
      function leave(): boolean {
        if (done) {
          return false;
        }
        done = true;
        signal?.removeEventListener('abort', cancel);
        if (out.delete(id)) {
          ended.add(id);
        }
        return true;
      }

      function answer(outcome: ResultPayload<Response, CallError<Domain>>): void {
        if (leave()) {
          resolve(outcome);
        }
      }

      function abandon(error: Error): void {
        if (leave()) {
          reject(error);
        }
      }

      function cancel(): void {
        answer(err(cancelled()));
      }

      function refuseAnswer(error: Error): void {
        issues.refuse('malformed', error);
        abandon(new TransportMalformedResponseError(address, error));
      }

      /** Posts the request once the handshake is over, unless the call ended meanwhile. */
      function postRequest(): void {
        if (done) {
          return;
        }
        let data: FrameBytes;
        try {
          data = encodeCall({ method, address, id, message: { tag: 'request', value: payload } });
        } catch (error) {
          abandon(toError(error));
          return;
        }
        out.set(id, call);
        // A post the provider throws on closes the transport, which rejects this call with why.
        connection.post({ data, address });
      }

      const call: OutCall = {
        address,
        hear(bytes) {
          const message = decodeOr({ decoder: method.wholeMessage, data: bytes, onError: refuseAnswer });
          if (message === undefined) {
            return;
          }
          if (message.tag === 'response') {
            answer(message.value);
          } else {
            issues.refuse('invalid', new Error(`A request names call ${String(id)}, which this side made`));
          }
        },
        fail(error) {
          answer(err(error));
        },
        close: abandon,
      };
      signal?.addEventListener('abort', cancel, { once: true });
      connection.place({ send: postRequest, fail: abandon });
    });
  }

  function subscribe<Start, Value, Interrupt>({
    method,
    start,
    listeners,
    signal,
  }: SubscribeParams<Start, Value, Interrupt>): () => void {
    const address = schema.addressOf(method);
    let state: 'queued' | 'open' | 'ended' = 'queued';
    const id = ids.takeNext();

    /** Ends the subscription once, and tells `heard`, if any. `tellPeer` stops an open one at the peer. */
    function finish(tellPeer: boolean, heard: (() => void) | null): void {
      const was = state;
      if (was === 'ended') {
        return;
      }
      state = 'ended';
      signal?.removeEventListener('abort', cancel);
      out.delete(id);
      if (tellPeer && was === 'open') {
        ended.add(id);
        // A stop carries nothing, so it always encodes.
        const data = encodeCall({ method, address, id, message: { tag: 'stop', value: undefined } });
        connection.post({ data, address });
      }
      if (heard !== null) {
        issues.runListener(heard);
      }
    }

    function interrupt(reason: Interrupt): void {
      finish(false, () => {
        listeners.interrupt(reason);
      });
    }

    function fail(failure: Failure, tellPeer: boolean): void {
      finish(tellPeer, () => {
        listeners.fail(failure);
      });
    }

    // A closed transport posts nothing, so the peer is not told.
    function close(error: Error): void {
      finish(false, () => {
        listeners.close(error);
      });
    }

    function cancel(): void {
      fail(cancelled(), true);
    }

    function unsubscribe(): void {
      finish(true, null);
    }

    // What was lost may be a value, which leaves the subscriber behind the peer, so the subscription ends and the peer
    // is told to stop. A stop after the peer's own end is a race it drops. Nothing follows an interrupt, so the peer
    // that sent one hears no stop. A message whose leg cannot be read counts as a value.
    function failMalformed(bytes: MessageBytes, error: Error): void {
      issues.refuse('malformed', error);
      const leg = decodeOr({ decoder: method.leg, data: bytes, onError: () => undefined });
      fail(malformedFrame(error), leg?.tag !== 'interrupt');
    }

    /** The start's frame. Throws an error when the wire cannot carry the start. */
    function encodeStart(): FrameBytes {
      try {
        return encodeCall({ method, address, id, message: { tag: 'start', value: start } });
      } catch (error) {
        // A codec of the owner's may throw a value that is no error, and the caller hears an error.
        throw toError(error);
      }
    }

    /** Posts the start once the handshake is over, unless the subscription ended meanwhile. */
    function postStart(): void {
      if (state !== 'queued') {
        return;
      }
      out.set(id, call);
      // A post the provider throws on closes the transport, which closes this subscription with why.
      if (!connection.post({ data, address })) {
        return;
      }
      // Open only once the start went out, so a stop from the issue hook of a failed post sees nothing the peer could
      // stop. A post that succeeds hears nothing before it returns.
      state = 'open';
    }

    const call: OutCall = {
      address,
      hear(bytes) {
        const message = decodeOr({
          decoder: method.wholeMessage,
          data: bytes,
          onError: error => {
            failMalformed(bytes, error);
          },
        });
        if (message === undefined) {
          return;
        }
        switch (message.tag) {
          case 'receive':
            issues.runListener(() => {
              listeners.receive(message.value);
            });
            return;
          case 'interrupt':
            interrupt(message.value);
            return;
          case 'start':
          case 'stop':
            issues.refuse(
              'invalid',
              new Error(`A ${message.tag} names subscription ${String(id)}, which this side made`),
            );
        }
      },
      fail(error) {
        fail(error, false);
      },
      close,
    };

    // Encoded at once, so a start the wire refuses throws to the caller. It is posted once, so the buffer stays whole.
    const data = encodeStart();
    startHandshake();
    if (signal?.aborted === true) {
      // Heard on a microtask, so no listener runs before the caller holds its `unsubscribe`.
      queueMicrotask(cancel);
      return unsubscribe;
    }
    signal?.addEventListener('abort', cancel, { once: true });
    connection.place({ send: postStart, fail: close });
    return unsubscribe;
  }

  /**
   * Opens a call for a transport that forwards its peer's calls here. It starts the handshake and waits for it with the
   * other calls, as `subscribe` does, and its messages cross as the bytes they are. Never throws.
   */
  function open({ address, message, heard }: OpenParams) {
    let state: 'queued' | 'open' | 'ended' = 'queued';
    const id = ids.takeNext();

    function end(): void {
      state = 'ended';
      if (out.delete(id)) {
        ended.add(id);
      }
    }

    /** Posts the call's first message once the handshake is over, unless it ended meanwhile. */
    function postOpening(): void {
      if (state !== 'queued') {
        return;
      }
      out.set(id, call);
      // A post the provider throws on closes the transport, which ends this call with why.
      if (connection.post({ data: encodeCarriedCall({ address, id, message }), address })) {
        state = 'open';
      }
    }

    function closeQueued(error: Error): void {
      if (state === 'queued') {
        state = 'ended';
        heard.close(error);
      }
    }

    const call: OutCall = {
      address,
      hear(bytes) {
        heard.message(bytes);
      },
      fail(error) {
        end();
        heard.fail(error);
      },
      close(error) {
        end();
        heard.close(error);
      },
    };
    startHandshake();
    connection.place({ send: postOpening, fail: closeQueued });
    return {
      /** Posts a further message on the call once it went out, and nothing while it waits for the handshake. */
      send(bytes: MessageBytes): void {
        if (state === 'open') {
          connection.post({ data: encodeCarriedCall({ address, id, message: bytes }), address });
        }
      },
      /** Ends the call with nothing posted, so a late message on it is dropped and one still waiting never goes out. */
      forget: end,
    };
  }

  /** Hands a message the peer sent on call `id` to the call. Never throws. */
  function hearOwn(id: number, call: Call<MessageBytes>): void {
    const outCall = out.get(id);
    if (outCall === undefined) {
      refuseStray(id);
      return;
    }
    if (!isSameMethod(outCall.address, call)) {
      issues.refuse('invalid', new Error(`A message for call ${String(id)} names another method than the call`));
      return;
    }
    outCall.hear(call.message);
  }

  /** Ends call `id` with a failure the peer answered it with. Never throws. */
  function failOwn(id: number, failure: Failure): void {
    const outCall = out.get(id);
    if (outCall === undefined) {
      refuseStray(id);
      return;
    }
    outCall.fail(failure);
  }

  /** Ends every call that went out or waits to, with the error the transport closed with. */
  function closeAll(error: Error): void {
    for (const outCall of [...out.values()]) {
      outCall.close(error);
    }
  }

  /** Reports a message on a call this side is not waiting on, unless it ended that call lately. */
  function refuseStray(id: number): void {
    if (!ended.has(id)) {
      issues.refuse('invalid', new Error(`A message names call ${String(id)}, which this side is not waiting on`));
    }
  }

  return { request, subscribe, open, hear: hearOwn, fail: failOwn, closeAll };
}
