// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Requests to the protocol frame, each on its own budget, with the metrics and trail every call to the frame shares.

import { m, spans as S } from '@dotli/metrics';
import { errorName, log, realTimers, toError, withTimeout, type Timers } from '@dotli/shared';
import { failureReason, type AnyMethod, type Request } from '@dotli/transport';
import { callName, policyOf, type CallName, type MethodPolicy } from './method-policy.js';
import { ProtocolRequestError } from './errors.js';
import type { ProtocolFrame } from './frame.js';
import { callFailure, fromTransportError } from './outcomes.js';
import type { DomainFailure, ProtocolTransport } from './schema.js';

/** The error a call that outlived its budget fails with. */
function callTimeoutError(method: CallName, budgetMs: number): ProtocolRequestError {
  return new ProtocolRequestError(
    `Protocol request "${method}" timed out after ${String(budgetMs)}ms`,
    'ProtocolTimeoutError',
    method,
  );
}

/**
 * A call's failure as callers see it, under the protocol's class for a transport that closed. A bare `"Error"` from the
 * frame carries nothing, and would cost the "crossed the protocol boundary" signal dashboards filter on.
 */
function callError(reason: unknown): Error {
  const error = fromTransportError(toError(reason));
  return error instanceof ProtocolRequestError && error.name === 'Error'
    ? new ProtocolRequestError(error.message, 'ProtocolResponseError', error.method)
    : error;
}

export type CallOutcome = 'ok' | 'error' | 'timeout';

/** Measures one call from when it is handed to the transport, and settles once. */
interface CallTrail {
  settled(outcome: CallOutcome, error?: Error): void;
}

/** Measured on `now`, a monotonic clock apart from the budget timers, which a spec moves by hand. */
function startCallTrail(policy: MethodPolicy, now: () => number): CallTrail {
  const { name: method, budgetMs, timed, trailed } = policy;
  const stop = timed ? m.timer(S.PROTOCOL_REQUEST, now) : (): number => 0;
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
          ...(error !== undefined ? { error: failureReason(error).slice(0, 200) } : {}),
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
  request<P, R, E extends DomainFailure>(method: Request<P, R, E>, payload: NoInfer<P>): Promise<R>;
  /**
   * Runs a call made on the transport itself, such as a subscription, as `request` runs its own. `run` gets the frame's
   * transport and the signal that aborts once the budget runs out or `options.signal` aborts, and settles with the
   * call. A call whose signal aborts before the frame can answer never goes out.
   */
  call<V>(
    method: AnyMethod,
    run: (transport: ProtocolTransport, signal: AbortSignal) => Promise<V>,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<V>;
}

/**
 * A call's budget. Once it runs out, `signal` aborts with the timeout error, which `bounded` rejects with. It also
 * aborts with the caller's `signal`.
 */
interface Budget {
  signal: AbortSignal;
  bounded: <V>(work: Promise<V>) => Promise<V>;
  /** Whether `reason` is the timeout this budget raised. */
  timedOut: (reason: unknown) => boolean;
}

function startBudget({ name, budgetMs }: MethodPolicy, timers: Timers, signal: AbortSignal | undefined): Budget {
  const giveUp = new AbortController();
  let timeout: Error | undefined;
  return {
    signal: signal === undefined ? giveUp.signal : AbortSignal.any([signal, giveUp.signal]),
    bounded: work =>
      budgetMs === null
        ? work
        : withTimeout(
            work,
            budgetMs,
            () => {
              timeout = callTimeoutError(name, budgetMs);
              giveUp.abort(timeout);
              return timeout;
            },
            timers,
          ),
    timedOut: reason => timeout !== undefined && reason === timeout,
  };
}

/** Budgets run on `timers`, and call trails on `now`, a monotonic clock that a spec may set to its own timers. */
export function createFrameRpc(
  frame: RpcFrame,
  timers: Timers = realTimers,
  now: () => number = () => performance.now(),
): FrameRpc {
  async function call<V>(
    method: AnyMethod,
    run: (transport: ProtocolTransport, signal: AbortSignal) => Promise<V>,
    options: { signal?: AbortSignal | undefined } = {},
  ): Promise<V> {
    const policy = policyOf(method);
    // Ends the call on its budget. The transport drops it, and a late answer is ignored.
    const { signal, bounded, timedOut } = startBudget(policy, timers, options.signal);
    // Set once the call is handed to a connected transport, which the frame wait may never reach.
    const sent: { trail: CallTrail | null } = { trail: null };
    const send = (transport: ProtocolTransport): Promise<V> => {
      // The budget ran out, or the caller left, while the frame was asked for, so nothing goes out.
      if (signal.aborted) {
        throw toError(signal.reason);
      }
      sent.trail = startCallTrail(policy, now);
      return run(transport, signal);
    };

    try {
      let value: V;
      if (policy.whenListening) {
        // The transport queues a call until its handshake, and the wait for it is the boot's, not the call's.
        value = await bounded(
          frame.transport().then(async transport => {
            await transport.whenConnected();
            return send(transport);
          }),
        );
      } else {
        const transport = await frame.whenReady();
        value = await bounded(send(transport));
      }
      sent.trail?.settled('ok');
      return value;
    } catch (reason: unknown) {
      const error = callError(reason);
      const outcome: CallOutcome = timedOut(reason) ? 'timeout' : 'error';
      if (sent.trail !== null) {
        sent.trail.settled(outcome, error);
      } else if (outcome === 'timeout') {
        // Never sent, since the frame did not come up within the budget.
        m.count(S.PROTOCOL_REQUEST, { outcome, method: policy.name, reason: errorName(error) ?? 'unknown' });
      }
      throw error;
    }
  }

  return {
    call,
    request: (method, payload) =>
      call(method, async (transport, signal) => {
        const outcome = await transport.request(method, payload, { signal });
        if (outcome.success) {
          return outcome.value;
        }
        throw callFailure(outcome.value, callName(method), signal);
      }),
  };
}
