// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Requests to the protocol frame, each on its own budget, with the metrics and trail every call to the frame shares.

import { m, spans as S } from '@dotli/metrics';
import { errorName, log, realTimers, toError, withTimeout, type Timers } from '@dotli/shared';
import type { AnyMethod, Request } from '@dotli/transport';
import { callName, type CallName } from './call-names.js';
import { ProtocolRequestError } from './errors.js';
import type { ProtocolFrame } from './frame.js';
import { budgetOf } from './method-timeouts.js';
import { callFailure, fromTransportError } from './outcomes.js';
import { protocolSchema, type DomainFailure, type ProtocolTransport } from './schema.js';

const { frame, resolve, chain } = protocolSchema.traits;

/**
 * Page load steps, breadcrumbed when sent and settled so a failed load's trail names what it waited on.
 * Storage and chain traffic is per product call and would crowd them out.
 */
const TRAILED_METHODS: ReadonlySet<AnyMethod> = new Set<AnyMethod>([
  frame.warmup,
  chain.connect,
  resolve.dotName,
  resolve.owner,
  resolve.executableManifest,
  resolve.rootManifest,
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
export function asCallError(error: Error): Error {
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
function startCallTrail(called: AnyMethod, budgetMs: number | null, now: () => number): CallTrail {
  const method = callName(called);
  // `chain.send` is fire-and-ack, one per product JSON-RPC message: timed, it would swamp the resolution and connect
  // round trips this span measures.
  const stop = called === chain.send ? (): number => 0 : m.timer(S.PROTOCOL_REQUEST, now);
  const trailed = TRAILED_METHODS.has(called);
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
  request<P, R, E extends DomainFailure>(method: Request<P, R, E>, payload: NoInfer<P>): Promise<R>;
  /**
   * Runs a call made on the transport itself, such as a subscription, within `method`'s budget, on the same trail as
   * every request. `run` gets the signal that aborts once the budget runs out, and settles with the call.
   */
  call<V>(method: AnyMethod, run: (signal: AbortSignal) => Promise<V>): Promise<V>;
}

/** A call's budget. Once it runs out, `signal` aborts with the timeout error, which `bounded` rejects with. */
interface Budget {
  signal: AbortSignal;
  bounded: <V>(work: Promise<V>) => Promise<V>;
  /** Whether `reason` is the timeout this budget raised. */
  timedOut: (reason: unknown) => boolean;
}

function startBudget(method: AnyMethod, timers: Timers): Budget {
  const name = callName(method);
  const budgetMs = budgetOf(method);
  const giveUp = new AbortController();
  let timeout: Error | undefined;
  return {
    signal: giveUp.signal,
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

/** A call's failure as callers see it, under the protocol's class for a transport that closed. */
function callError(reason: unknown): Error {
  return asCallError(fromTransportError(toError(reason)));
}

/** The shared store answers once the frame listens, long before its light client is ready. */
function isSharedStore(method: AnyMethod): boolean {
  const { trait } = protocolSchema.addressOf(method);
  return trait === 'storage' || trait === 'wallet';
}

/** Budgets run on `timers`, and call trails on `now`, a monotonic clock that a spec may set to its own timers. */
export function createFrameRpc(
  frame: RpcFrame,
  timers: Timers = realTimers,
  now: () => number = () => performance.now(),
): FrameRpc {
  return {
    async call(method, run) {
      const budget = startBudget(method, timers);
      const trail = startCallTrail(method, budgetOf(method), now);
      try {
        const value = await budget.bounded(run(budget.signal));
        trail.settled('ok');
        return value;
      } catch (reason: unknown) {
        const error = callError(reason);
        trail.settled(budget.timedOut(reason) ? 'timeout' : 'error', error);
        throw error;
      }
    },
    async request<P, R, E extends DomainFailure>(method: Request<P, R, E>, payload: P): Promise<R> {
      const name = callName(method);
      // Ends the call on its budget. The transport drops it, and a late answer is ignored.
      const { signal, bounded, timedOut } = startBudget(method, timers);
      // Set once the call is handed to a connected transport, which the frame wait may never reach.
      const sent: { trail: CallTrail | null } = { trail: null };
      const send = async (transport: ProtocolTransport): Promise<R> => {
        // The budget ran out while the frame was asked for, so nothing goes out.
        if (signal.aborted) {
          throw toError(signal.reason);
        }
        sent.trail = startCallTrail(method, budgetOf(method), now);
        const outcome = await transport.request(method, payload, { signal });
        if (outcome.success) {
          return outcome.value;
        }
        throw callFailure(outcome.value, name, signal);
      };

      try {
        let answer: R;
        if (isSharedStore(method)) {
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
        const err = callError(reason);
        const outcome: CallOutcome = timedOut(reason) ? 'timeout' : 'error';
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
