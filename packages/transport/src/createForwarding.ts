// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The calls this side forwards. Each goes on to the upstream as a call of its own, numbered there, and every message
// crosses as the bytes it is, so only the far ends decode a payload. Only the leg of a message is read, to follow the
// call's life.

import type { Connection } from './createConnection.js';
import type { IssueReport } from './createIssueReport.js';
import type { ServedCalls } from './createServedCalls.js';
import type { Transport } from './createTransport.js';
import { decodeOr } from './decodeOr.js';
import { isSameMethod, type Address, type Schema, type Sections } from './defineSchema.js';
import { hostFailure } from './failure.js';
import { encodeCarriedCall } from './frame.js';
import type { MessageBytes } from './messageBytes.js';
import type { AnyMethod } from './method.js';
import { SUBSCRIPTION_STOP, wholeSubscriptionLeg } from './subscription.js';
import type { Heard, Running, Served, ServedCall } from './types.js';
import { getUpstream, type Upstream } from './upstreams.js';

type Params = {
  schema: Pick<Schema<unknown, Sections>, 'addressOf'>;
  served: Pick<
    ServedCalls<unknown>,
    'register' | 'postFailed' | 'answerMalformed' | 'holdRequest' | 'releaseRequest' | 'run' | 'end'
  >;
  connection: Pick<Connection<unknown>, 'post'>;
  issues: IssueReport;
};

type HandlerParams = {
  upstream: Upstream;
  method: AnyMethod;
  /** Where `method` sits, the same on this transport and on the upstream. */
  address: Address;
};

type ForwardRequestParams = HandlerParams & {
  /** The peer's call id. */
  id: number;
  /** The peer's request, as its bytes. */
  request: MessageBytes;
};

type ForwardSubscriptionParams = HandlerParams & {
  /** The peer's call id. */
  id: number;
  /** The peer's start, as its bytes. */
  start: MessageBytes;
};

type AnswerEndParams = {
  id: number;
  address: Address;
  /** Ends the call here. Returns whether it was still open. */
  leave: () => boolean;
};

/** Forwarding of the peer's calls of chosen methods to another transport of the same schema. */
export function createForwarding({ schema, served, connection, issues }: Params) {
  function forward(methods: readonly AnyMethod[], upstream: Transport<unknown>): () => void {
    const reached = getUpstream(upstream);
    if (reached === null) {
      throw new Error('The upstream transport was not built by this library');
    }
    const placed = methods.map(method => {
      const address = schema.addressOf(method);
      if (!isSameMethod(reached.addressOf(method), address)) {
        throw new Error(`${address.section}.${address.method} sits elsewhere in the upstream`);
      }
      return { method, address };
    });
    const unregisters: (() => void)[] = [];

    function unregisterAll(): void {
      for (const unregister of unregisters) {
        unregister();
      }
    }

    // A method refused partway leaves none of the others forwarded.
    try {
      for (const { method, address } of placed) {
        unregisters.push(
          served.register({ method, address, served: createForwardingHandler({ upstream: reached, method, address }) }),
        );
      }
    } catch (error) {
      unregisterAll();
      throw error;
    }
    return unregisterAll;
  }

  /** Serves `method` by forwarding each call the peer opens to `upstream`, a request or a subscription by its leg. */
  function createForwardingHandler({ upstream, method, address }: HandlerParams): Served<unknown> {
    function serve({ id, message }: ServedCall<unknown>): void {
      const leg = decodeOr({
        decoder: method.leg,
        data: message,
        onError: cause => {
          served.answerMalformed({ id, cause, address });
        },
      });
      if (leg === undefined) {
        return;
      }
      switch (leg.tag) {
        case 'request':
          forwardRequest({ upstream, method, address, id, request: message });
          return;
        case 'start':
          forwardSubscription({ upstream, method, address, id, start: message });
          return;
        default:
          issues.refuse('invalid', new Error(`A ${leg.tag} names call ${String(id)}, which is not open`));
      }
    }

    return serve;
  }

  /** Forwards a peer's request, and posts the upstream's answer back on its id. */
  function forwardRequest({ upstream, method, address, id, request }: ForwardRequestParams): void {
    const call = upstream.open({
      address,
      message: request,
      heard: {
        message(answer) {
          const leg = decodeOr({ decoder: method.leg, data: answer, onError: () => undefined });
          // An answer whose leg cannot be read goes back, so the peer refuses it as one it cannot decode.
          if (leg !== undefined && leg.tag !== 'response') {
            issues.refuse('invalid', new Error(`A ${leg.tag} answers forwarded call ${String(id)}`));
            return;
          }
          call.forget();
          if (served.releaseRequest(id)) {
            connection.post({ data: encodeCarriedCall({ address, id, message: answer }), address });
          }
        },
        ...answerEnd({ id, address, leave: () => served.releaseRequest(id) }),
      },
    });
    served.holdRequest(id, () => {
      call.forget();
    });
  }

  /** Forwards a peer's subscription, and posts what the upstream sends back on its id until either side ends it. */
  function forwardSubscription({ upstream, method, address, id, start }: ForwardSubscriptionParams): void {
    /** Ends it here once. Returns whether it was still running. */
    function finish(): boolean {
      return served.end(id, entry);
    }

    function stopWith(stop: MessageBytes): void {
      if (finish()) {
        call.send(stop);
        call.forget();
      }
    }

    function refuseMalformed(error: Error): void {
      issues.refuse('malformed', error);
    }

    const entry: Running = {
      address,
      hear(message) {
        const leg = decodeOr({ decoder: method.leg, data: message, onError: refuseMalformed });
        if (leg === undefined) {
          return;
        }
        if (leg.tag !== 'stop') {
          issues.refuse('invalid', new Error(`A ${leg.tag} names subscription ${String(id)}, which is running`));
          return;
        }
        // A stop the far end refuses would leave its subscription running with nothing here to stop it, so it goes on
        // only once it reads whole.
        if (decodeOr({ decoder: wholeSubscriptionLeg, data: message, onError: refuseMalformed }) !== undefined) {
          stopWith(message);
        }
      },
      // The upstream is still open, so the subscription it holds there is told to stop, with a stop of this side's own.
      drop: () => {
        stopWith(SUBSCRIPTION_STOP);
      },
    };
    const call = upstream.open({
      address,
      message: start,
      heard: {
        message(sent) {
          const leg = decodeOr({ decoder: method.leg, data: sent, onError: () => undefined });
          // A message whose leg cannot be read counts as a value and goes back, so the peer refuses it as one it cannot
          // decode.
          const tag = leg?.tag ?? 'receive';
          if (tag === 'start' || tag === 'stop') {
            issues.refuse(
              'invalid',
              new Error(`A ${tag} names forwarded subscription ${String(id)}, which this side made`),
            );
            return;
          }
          if (tag === 'interrupt') {
            call.forget();
            if (!finish()) {
              return;
            }
          }
          connection.post({ data: encodeCarriedCall({ address, id, message: sent }), address });
        },
        ...answerEnd({ id, address, leave: finish }),
      },
    });
    served.run(id, entry);
  }

  /**
   * How a forwarded call answers the peer when the upstream ends it: with the upstream's failure, or `HostFailure` when
   * the upstream closed.
   */
  function answerEnd({ id, address, leave }: AnswerEndParams): Pick<Heard, 'fail' | 'close'> {
    return {
      fail(error) {
        if (leave()) {
          served.postFailed({ id, failure: error, address });
        }
      },
      close(error) {
        if (leave()) {
          served.postFailed({ id, failure: hostFailure(error), address });
        }
      },
    };
  }

  return { forward };
}
