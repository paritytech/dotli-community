// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Requests to the protocol frame, each on its own budget, with the metrics and trail every call to the frame shares.

import { m, spans as S } from '@dotli/metrics';
import { errorName, log, realTimers, toError, withTimeout, type Timers } from '@dotli/shared';
import { isSharedAuthRequestMethod, isSharedModeRequestMethod, isSharedWalletRequestMethod } from './auth-storage.js';
import { ProtocolRequestError } from './errors.js';
import type { ProtocolFrame } from './frame.js';
import { budgetOf } from './method-timeouts.js';
import type { Answer, RequestMethod, RequestPayload, SubscriptionMethod } from './methods.js';
import type { ConsumerTransport } from './transport-consumer.js';

type CalledMethod = RequestMethod | SubscriptionMethod;

/**
 * Page load steps, breadcrumbed when sent and settled so a failed load's trail names what it waited on.
 * Storage and chain traffic is per product call and would crowd them out.
 */
const TRAILED_METHODS: ReadonlySet<CalledMethod> = new Set<CalledMethod>([
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
export function callTimeoutError(method: CalledMethod, budgetMs: number): ProtocolRequestError {
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
    ? new ProtocolRequestError(err.message, 'ProtocolResponseError', err.method, err.remoteStack)
    : err;
}

export type CallOutcome = 'ok' | 'error' | 'timeout';

/** Measures one call from when it is handed to the transport, and settles once. */
export interface CallTrail {
  settled(outcome: CallOutcome, error?: Error): void;
}

/** Measured on `now`, a monotonic clock apart from the deadline clock, which a spec moves by hand. */
function startCallTrail(method: CalledMethod, budgetMs: number | null, now: () => number): CallTrail {
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
export type RpcFrame = Pick<ProtocolFrame, 'whenUp' | 'transport'>;

export interface FrameRpc {
  /**
   * Sends once the frame can answer: listening for the shared store, ready for everything else. A shared store
   * request's budget runs from the call, so it also bounds the wait for a frame that never loads. Any other budget runs
   * from when the frame is ready, since such a request also waits for the light client, which has deadlines of its
   * own. Rejects when the frame goes down before the answer. A call is timed and counted from when it goes out. One
   * whose budget runs out before it goes out is counted as a timeout. A boot that fails is otherwise counted once, by
   * the frame.
   */
  request<M extends RequestMethod>(method: M, payload: RequestPayload<M>): Promise<Answer<M>>;
  /** Starts the trail of a call made on the transport itself, timed on the same clock as every request. */
  trail(method: CalledMethod, budgetMs: number | null): CallTrail;
}

function isSharedStoreMethod(method: RequestMethod): boolean {
  return isSharedAuthRequestMethod(method) || isSharedModeRequestMethod(method) || isSharedWalletRequestMethod(method);
}

/**
 * Deadlines read `timers`, which cross to the frame, and call trails `now`, a monotonic clock that a spec may set to
 * its own timers.
 */
export function createFrameRpc(
  frame: RpcFrame,
  timers: Timers = realTimers,
  now: () => number = () => performance.now(),
): FrameRpc {
  return {
    trail: (method, budgetMs) => startCallTrail(method, budgetMs, now),
    async request<M extends RequestMethod>(method: M, payload: RequestPayload<M>): Promise<Answer<M>> {
      const budgetMs = budgetOf(method);
      // Ends the call on its budget. The transport drops it, and a late answer is ignored.
      const giveUp = new AbortController();
      let timedOut: Error | undefined;
      // Set once the call is handed to a connected transport, which the frame wait may never reach.
      const sent: { trail: CallTrail | null } = { trail: null };
      const bounded = <T>(work: Promise<T>): Promise<T> =>
        budgetMs === null
          ? work
          : withTimeout(
              work,
              budgetMs,
              () => {
                timedOut = callTimeoutError(method, budgetMs);
                giveUp.abort(timedOut);
                return timedOut;
              },
              timers,
            );
      const send = (transport: ConsumerTransport, deadlineMs: number | null): Promise<Answer<M>> => {
        // The budget ran out while the frame was asked for, so nothing goes out.
        if (giveUp.signal.aborted) {
          return Promise.reject(toError(giveUp.signal.reason));
        }
        sent.trail = startCallTrail(method, budgetMs, now);
        return transport.request(method, payload, {
          signal: giveUp.signal,
          ...(deadlineMs === null ? {} : { deadlineMs }),
        });
      };
      const deadlineFromNow = (): number | null => (budgetMs === null ? null : timers.now() + budgetMs);

      try {
        let answer: Answer<M>;
        if (isSharedStoreMethod(method)) {
          const deadlineMs = deadlineFromNow();
          // The transport queues a call until its handshake, and the wait for it is the boot's, not the call's.
          answer = await bounded(
            frame.transport().then(async transport => {
              await transport.whenConnected();
              return send(transport, deadlineMs);
            }),
          );
        } else {
          const transport = await frame.whenUp('ready');
          answer = await bounded(send(transport, deadlineFromNow()));
        }
        sent.trail?.settled('ok');
        return answer;
      } catch (reason: unknown) {
        const err = asCallError(reason);
        const outcome: CallOutcome = reason === timedOut ? 'timeout' : 'error';
        if (sent.trail !== null) {
          sent.trail.settled(outcome, err);
        } else if (outcome === 'timeout') {
          // Never sent, since the frame did not come up within the budget.
          m.count(S.PROTOCOL_REQUEST, { outcome, method, reason: errorName(err) ?? 'unknown' });
        }
        throw err;
      }
    },
  };
}
