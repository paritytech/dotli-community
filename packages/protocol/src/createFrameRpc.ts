// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Requests to the protocol frame, each on its own budget, with the metrics and trail every call to the frame shares.

import { m, spans as S } from '@dotli/metrics';
import { getErrorName, log, realTimers, toError, withTimeout, type Timers } from '@dotli/shared';
import { getFailureReason, type AnyMethod, type Request } from '@dotli/transport';
import { ProtocolRequestError, callFailure, fromTransportError } from './errors.js';
import type { ProtocolFrame } from './frameTypes.js';
import { getCallName, getPolicy, type CallName, type MethodPolicy } from './methodPolicy.js';
import type { DomainFailure, ProtocolTransport } from './schema.js';

export type CallOutcome = 'ok' | 'error' | 'timeout';

/** What requests need of the frame. */
export type RpcFrame = Pick<ProtocolFrame, 'waitUntilReady' | 'getTransport' | 'checkAlive'>;

/** Requests to the frame, each on its own budget. */
export type FrameRpc = ReturnType<typeof createFrameRpc>;

type Params = {
  frame: RpcFrame;
  /** The clock the budgets run on. */
  timers?: Timers;
  /** A monotonic clock the call trails are measured on, which a spec may set to its own timers. */
  now?: () => number;
};

type CallParams = {
  /** Ends the call early, as its budget running out does. */
  signal?: AbortSignal | undefined;
};

/** Measures one call from when it is handed to the transport, and settles once. */
type CallTrail = ReturnType<typeof startCallTrail>;

type StartBudgetParams = {
  policy: MethodPolicy;
  timers: Timers;
  /** The caller's signal, which aborts the budget's own signal too. */
  signal: AbortSignal | undefined;
};

/** Requests to the frame on `frame`, each budget on `timers` and each call trail on `now`. */
export function createFrameRpc({ frame, timers = realTimers, now = () => performance.now() }: Params) {
  async function call<V>(
    method: AnyMethod,
    run: (transport: ProtocolTransport, signal: AbortSignal) => Promise<V>,
    options: CallParams = {},
  ): Promise<V> {
    const policy = getPolicy(method);
    // Ends the call on its budget. The transport drops it, and a late answer is ignored.
    const { signal, withBudget, isOwnTimeout } = startBudget({ policy, timers, signal: options.signal });
    // Set once the call is handed to a connected transport, which the frame wait may never reach.
    const sent: { trail: CallTrail | null; transport: ProtocolTransport | null } = { trail: null, transport: null };

    function send(transport: ProtocolTransport): Promise<V> {
      // The budget ran out, or the caller left, while the frame was asked for, so nothing goes out.
      if (signal.aborted) {
        throw toError(signal.reason);
      }
      sent.trail = startCallTrail(policy, now);
      sent.transport = transport;
      return run(transport, signal);
    }

    try {
      let value: V;
      if (policy.whenListening) {
        // The transport queues a call until its handshake, and the wait for it is the boot's, not the call's.
        value = await withBudget(
          frame.getTransport().then(async transport => {
            await transport.whenConnected();
            return send(transport);
          }),
        );
      } else {
        const transport = await frame.waitUntilReady();
        value = await withBudget(send(transport));
      }
      sent.trail?.settle('ok');
      return value;
    } catch (reason: unknown) {
      const error = createCallError(reason);
      const outcome: CallOutcome = isOwnTimeout(reason) ? 'timeout' : 'error';
      if (sent.trail !== null) {
        sent.trail.settle(outcome, error);
      } else if (outcome === 'timeout') {
        // Never sent, since the frame did not come up within the budget.
        m.count(S.PROTOCOL_REQUEST, { outcome, method: policy.name, reason: getErrorName(error) ?? 'unknown' });
      }
      if (policy.whenListening && sent.transport !== null && outcome === 'timeout') {
        // A shared store call waits on no light client, so one the frame let run out may mean the frame stopped.
        frame.checkAlive(sent.transport);
      }
      throw error;
    }
  }

  function request<Payload, Response, Failure extends DomainFailure>(
    method: Request<Payload, Response, Failure>,
    payload: NoInfer<Payload>,
  ): Promise<Response> {
    return call(method, async (transport, signal) => {
      const outcome = await transport.request(method, payload, { signal });
      if (outcome.success) {
        return outcome.value;
      }
      throw callFailure(outcome.value, getCallName(method), signal);
    });
  }

  return {
    /**
     * Runs a call made on the transport itself, such as a subscription, as `request` runs its own. `run` gets the
     * frame's transport and the signal that aborts once the budget runs out or `options.signal` aborts, and settles
     * with the call. A call whose signal aborts before the frame can answer never goes out. Rejects with what `run`
     * rejects with, as the error host code sees. Rejects with a `ProtocolRequestError` named after why the frame failed
     * the call. Rejects with a `ProtocolRequestError` named `ProtocolTimeoutError` once its budget runs out. Rejects
     * with the error the boot it waits on failed with, and with an `Error` of the `FRAME_RESET` text when a config
     * change drops the frame. Rejects with the error the frame went down with, such as a `ProtocolFatalError` or an
     * `Error` with a `PROTOCOL_ERRORS` text.
     */
    call,
    /**
     * Sends once the frame can answer: listening for the shared store, ready for everything else. A shared store
     * request's budget runs from the call, so it also bounds the wait for a frame that never loads. Any other budget
     * runs from when the frame is ready, since such a request also waits for the light client, which has deadlines of
     * its own. Rejects with a `ProtocolRequestError` named after why the frame failed the call. Rejects with a
     * `ProtocolFatalError`, a `ProtocolInitFailedError`, a `ProtocolPortReleasedError` or a
     * `ProtocolVersionMismatchError` when the frame answers with that failure. Rejects with a `ProtocolRequestError`
     * named `ProtocolTimeoutError` once its budget runs out. Rejects with the error the boot it waits on failed with, and
     * with an `Error` of the `FRAME_RESET` text when a config change drops the frame. Rejects with the error the frame
     * went down with, such as a `ProtocolFatalError` or an `Error` with a `PROTOCOL_ERRORS` text. A call is timed and
     * counted from when it goes out. One whose budget runs out before it goes out is counted as a timeout. A boot that
     * fails is otherwise counted once, by the frame. A shared store request whose budget runs out after it went out asks
     * the frame to check that the transport it went out on still answers.
     */
    request,
  };
}

/** The error a call that outlived its budget fails with. */
function createCallTimeoutError(method: CallName, budgetMs: number): ProtocolRequestError {
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
function createCallError(reason: unknown): Error {
  const error = fromTransportError(toError(reason));
  return error instanceof ProtocolRequestError && error.name === 'Error'
    ? new ProtocolRequestError(error.message, 'ProtocolResponseError', error.method)
    : error;
}

/** The word a call's trail settles with. */
function getOutcomeWord(outcome: CallOutcome): string {
  switch (outcome) {
    case 'ok':
      return 'done';
    case 'timeout':
      return 'timed out';
    case 'error':
      return 'failed';
  }
}

/** Measured on `now`, a monotonic clock apart from the budget timers, which a spec moves by hand. */
function startCallTrail(policy: MethodPolicy, now: () => number) {
  const { name: method, budgetMs, timed, trailed } = policy;
  const stop = timed ? m.timer(S.PROTOCOL_REQUEST, { now }) : (): number => 0;
  const sentAt = now();
  if (trailed) {
    log.event(`${method} sent`, { flow: 'protocol', ...(budgetMs === null ? {} : { timeout_ms: budgetMs }) });
  }
  let done = false;
  return {
    /** Stops the timer, counts a failure and ends the trail, the first time only. Never throws. */
    settle(outcome: CallOutcome, error?: Error): void {
      if (done) {
        return;
      }
      done = true;
      stop();
      if (outcome !== 'ok') {
        m.count(S.PROTOCOL_REQUEST, { outcome, method, reason: getErrorName(error) ?? 'unknown' });
      }
      if (trailed) {
        log.event(`${method} ${getOutcomeWord(outcome)}`, {
          flow: 'protocol',
          ms: Math.round(now() - sentAt),
          ...(error !== undefined ? { error: getFailureReason(error).slice(0, 200) } : {}),
        });
      }
    },
  };
}

/**
 * A call's budget. Once it runs out, `signal` aborts with the timeout error, which `withBudget` rejects with. It also
 * aborts with the caller's `signal`.
 */
function startBudget({ policy, timers, signal }: StartBudgetParams) {
  const { name, budgetMs } = policy;
  const giveUp = new AbortController();
  let timeout: Error | undefined;

  function createTimeout(limitMs: number): Error {
    timeout = createCallTimeoutError(name, limitMs);
    giveUp.abort(timeout);
    return timeout;
  }

  function withBudget<V>(work: Promise<V>): Promise<V> {
    if (budgetMs === null) {
      return work;
    }
    return withTimeout({ work, ms: budgetMs, timeoutError: () => createTimeout(budgetMs), timers });
  }

  function isOwnTimeout(reason: unknown): boolean {
    return timeout !== undefined && reason === timeout;
  }

  return {
    /** Aborts once the budget runs out or the caller's signal aborts. */
    signal: signal === undefined ? giveUp.signal : AbortSignal.any([signal, giveUp.signal]),
    /** `work`, rejecting with the timeout once the budget runs out. `work` itself for a method with no budget. */
    withBudget,
    /** Whether `reason` is the timeout this budget raised. */
    isOwnTimeout,
  };
}
