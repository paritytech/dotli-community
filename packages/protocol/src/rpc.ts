// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Requests to the protocol frame, each on its own budget, with the metrics and trail every call to the frame shares.

import { m, spans as S } from '@dotli/metrics';
import { errorName, log, realTimers, toError, withTimeout, type Timers } from '@dotli/shared';
import type { CallError, MethodTypes, RequestMethodName, Result, TraitName } from '@dotli/transport';
import { callName, type CallName } from './call-names.js';
import { ProtocolRequestError } from './errors.js';
import type { ProtocolFrame } from './frame.js';
import { budgetOf } from './method-timeouts.js';
import { callFailure, fromTransportError, type DomainFailure } from './outcomes.js';
import type { ProtocolSchema, ProtocolTransport } from './schema.js';

type S = ProtocolSchema;

/** What a request of `method` in `trait` sends. */
export type RequestPayload<T extends TraitName<S>, M extends RequestMethodName<S, T>> =
  MethodTypes<S, T, M> extends { request: infer P } ? P : never;

/** What a request of `method` in `trait` answers when it succeeds. */
export type Reply<T extends TraitName<S>, M extends RequestMethodName<S, T>> =
  MethodTypes<S, T, M> extends { response: Result<infer R, CallError<unknown>> } ? R : never;

/**
 * Page load steps, breadcrumbed when sent and settled so a failed load's trail names what it waited on.
 * Storage and chain traffic is per product call and would crowd them out.
 */
const TRAILED_METHODS: ReadonlySet<CallName> = new Set<CallName>([
  'warmup',
  'chainConnect',
  'resolveDotName',
  'resolveOwner',
  'resolveExecutableManifest',
  'resolveRootManifest',
]);

export function createRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** The error a call that outlived its budget fails with. */
export function callTimeoutError(method: CallName, budgetMs: number): ProtocolRequestError {
  return new ProtocolRequestError(
    `Protocol request "${method}" timed out after ${String(budgetMs)}ms`,
    'ProtocolTimeoutError',
    method,
  );
}

/**
 * A remote failure as callers see it. A bare `"Error"` carries nothing, and would cost the "crossed the protocol
 * boundary" signal dashboards filter on.
 */
export function asCallError(error: unknown): Error {
  const err = toError(error);
  return err instanceof ProtocolRequestError && err.name === 'Error'
    ? new ProtocolRequestError(err.message, 'ProtocolResponseError', err.method)
    : err;
}

export type CallOutcome = 'ok' | 'error' | 'timeout';

/** Measures one call from when it is handed to the transport, and settles once. */
export interface CallTrail {
  settled(outcome: CallOutcome, error?: Error): void;
}

/** Measured on `now`, a monotonic clock apart from the budget timers, which a spec moves by hand. */
function startCallTrail(method: CallName, budgetMs: number | null, now: () => number): CallTrail {
  // `chainSend` is fire-and-ack, one per product JSON-RPC message: timed, it would swamp the resolution and connect
  // round trips this span measures.
  const stop = method === 'chainSend' ? (): number => 0 : m.timer(S.PROTOCOL_REQUEST, now);
  const trailed = TRAILED_METHODS.has(method);
  const sentAt = now();
  if (trailed) {
    log.event(`${method} sent`, { flow: 'protocol', ...(budgetMs === null ? {} : { timeout_ms: budgetMs }) });
  }
  let done = false;
  return {
    settled(outcome, error) {
      if (done) {
        return;
      }
      done = true;
      stop();
      if (outcome !== 'ok') {
        m.count(S.PROTOCOL_REQUEST, { outcome, method, reason: errorName(error) ?? 'unknown' });
      }
      if (trailed) {
        log.event(`${method} ${outcome === 'ok' ? 'done' : outcome === 'timeout' ? 'timed out' : 'failed'}`, {
          flow: 'protocol',
          ms: Math.round(now() - sentAt),
          ...(error !== undefined ? { error: `${error.name}: ${error.message}`.slice(0, 200) } : {}),
        });
      }
    },
  };
}

/** What requests need of the frame. */
export type RpcFrame = Pick<ProtocolFrame, 'whenReady' | 'transport'>;

export interface FrameRpc {
  /**
   * Sends once the frame can answer: listening for the shared store, ready for everything else. A shared store
   * request's budget runs from the call, so it also bounds the wait for a frame that never loads. Any other budget runs
   * from when the frame is ready, since such a request also waits for the light client, which has deadlines of its
   * own. Rejects when the frame goes down before the answer. A call is timed and counted from when it goes out. One
   * whose budget runs out before it goes out is counted as a timeout. A boot that fails is otherwise counted once, by
   * the frame.
   */
  request<T extends TraitName<S>, M extends RequestMethodName<S, T>>(
    trait: T,
    method: M,
    payload: RequestPayload<T, M>,
  ): Promise<Reply<T, M>>;
  /** Starts the trail of a call made on the transport itself, timed on the same clock as every request. */
  trail(method: CallName, budgetMs: number | null): CallTrail;
}

/** The shared store answers once the frame listens, long before its light client is ready. */
function isSharedStoreTrait(trait: TraitName<S>): boolean {
  return trait === 'storage' || trait === 'wallet';
}

/** Budgets run on `timers`, and call trails on `now`, a monotonic clock that a spec may set to its own timers. */
export function createFrameRpc(
  frame: RpcFrame,
  timers: Timers = realTimers,
  now: () => number = () => performance.now(),
): FrameRpc {
  return {
    trail: (method, budgetMs) => startCallTrail(method, budgetMs, now),
    async request<T extends TraitName<S>, M extends RequestMethodName<S, T>>(
      trait: T,
      method: M,
      payload: RequestPayload<T, M>,
    ): Promise<Reply<T, M>> {
      const name = callName(trait, method);
      const budgetMs = budgetOf(trait, method);
      // Ends the call on its budget. The transport drops it, and a late answer is ignored.
      const giveUp = new AbortController();
      let timedOut: Error | undefined;
      // Set once the call is handed to a connected transport, which the frame wait may never reach.
      const sent: { trail: CallTrail | null } = { trail: null };
      const bounded = <V>(work: Promise<V>): Promise<V> =>
        budgetMs === null
          ? work
          : withTimeout(
              work,
              budgetMs,
              () => {
                timedOut = callTimeoutError(name, budgetMs);
                giveUp.abort(timedOut);
                return timedOut;
              },
              timers,
            );
      const send = async (transport: ProtocolTransport): Promise<Reply<T, M>> => {
        // The budget ran out while the frame was asked for, so nothing goes out.
        if (giveUp.signal.aborted) {
          throw toError(giveUp.signal.reason);
        }
        sent.trail = startCallTrail(name, budgetMs, now);
        // Every domain error the schema declares is a `DomainFailure`.
        const outcome = (await transport.request(trait, method, payload, { signal: giveUp.signal })) as Result<
          Reply<T, M>,
          CallError<DomainFailure>
        >;
        if (outcome.ok) {
          return outcome.value;
        }
        throw callFailure(outcome.error, name, giveUp.signal);
      };

      try {
        let answer: Reply<T, M>;
        if (isSharedStoreTrait(trait)) {
          // The transport queues a call until its handshake, and the wait for it is the boot's, not the call's.
          answer = await bounded(
            frame.transport().then(async transport => {
              await transport.whenConnected();
              return send(transport);
            }),
          );
        } else {
          const transport = await frame.whenReady();
          answer = await bounded(send(transport));
        }
        sent.trail?.settled('ok');
        return answer;
      } catch (reason: unknown) {
        // A transport that closed rejects with its own error, which the host knows by the protocol's class.
        const err = asCallError(reason instanceof Error ? fromTransportError(reason) : reason);
        const outcome: CallOutcome = reason === timedOut ? 'timeout' : 'error';
        if (sent.trail !== null) {
          sent.trail.settled(outcome, err);
        } else if (outcome === 'timeout') {
          // Never sent, since the frame did not come up within the budget.
          m.count(S.PROTOCOL_REQUEST, { outcome, method: name, reason: errorName(err) ?? 'unknown' });
        }
        throw err;
      }
    },
  };
}
