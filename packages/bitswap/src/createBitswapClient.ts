// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Fetches blocks with `bitswap_v1_get` over one Bulletin connection, held while a fetch runs and closed after the last.

import type { JsonRpcConnection, JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import { TIMEOUTS } from '@dotli/config';
import { createReporter, defineCount } from '@dotli/metrics';
import {
  createDeferred,
  createStateMachine,
  listen,
  noop,
  setErrorName,
  realTimers,
  toError,
  type MachineTypes,
  type Timers,
  type Transition,
} from '@dotli/shared';

import { createBitswapRequests } from './createBitswapRequests.js';
import { BITSWAP_ERRORS, createAbortError } from './errors.js';

const report = createReporter({ flow: 'content' });

/**
 * A Bulletin connection the bitswap client failed to close after its last fetch. Tag `outcome` (`error`) and `reason`
 * (the error name).
 */
const contentBitswapReleaseMetric = defineCount<'error'>('content.bitswap_release');
const bitswapClientTransitionMetric = defineCount<'error'>('bitswap_client.transition');

type Params = {
  /**
   * The Bulletin chain's provider, read at each dial, or null when the caller has no connection for Bulletin. Its
   * connections take the rebuilt chain after a halt and answer the requests the halt cut with the halted marker.
   */
  provider: () => JsonRpcProvider | null;
  /** The clock and timers the budget, the per-call timeout and the retry waits run on. */
  timers?: Timers;
};

export type BitswapClient = ReturnType<typeof createBitswapClient>;

/** One call of `get`, with the budget it spends on its own and the promise it settles. */
type Caller = {
  deadline: number;
  signal: AbortSignal | undefined;
  resolve: (bytes: Uint8Array) => void;
  reject: (error: unknown) => void;
};

/** The fetch of one CID. Its runner is the caller whose fetch runs, and the others wait behind it. */
type SharedFetch = { runner: Caller; queued: readonly Caller[] };

/**
 * The connection is dialed by the first fetch, held while any fetch runs, retry waits included, and closed after the
 * last. An ended fetch leaves `fetches`.
 */
type ClientState =
  { kind: 'idle' } | { kind: 'dialed'; connection: JsonRpcConnection; fetches: ReadonlyMap<string, SharedFetch> };

type Dialed = Extract<ClientState, { kind: 'dialed' }>;

type ClientEvent =
  | { kind: 'asked'; cid: string; caller: Caller }
  | { kind: 'callerAborted'; cid: string; caller: Caller }
  | { kind: 'blockFetched'; cid: string; runner: Caller; bytes: Uint8Array }
  | { kind: 'fetchFailed'; cid: string; runner: Caller; error: unknown };

type ClientEffect =
  | { kind: 'resolve'; caller: Caller; bytes: Uint8Array }
  | { kind: 'reject'; caller: Caller; error: unknown }
  | { kind: 'disconnect'; connection: JsonRpcConnection };

type ClientMachine = MachineTypes<ClientState, ClientEvent, ClientEffect>;

/** Creates a client that fetches blocks by CID over the provider's bitswap JSON-RPC, sharing one fetch per CID. */
export function createBitswapClient({ provider, timers = realTimers }: Params) {
  const requests = createBitswapRequests({ timers });

  const client = createStateMachine<ClientMachine>({
    initial: { kind: 'idle' },
    handlers: {
      idle: {
        asked(_state, { cid, caller }, transition) {
          let connection: JsonRpcConnection;
          // A dial that fails fails this caller at once, and the next one dials again.
          try {
            connection = dial();
          } catch (error) {
            transition.emitSideEffect({ kind: 'reject', caller, error: toError(error) });
            return;
          }
          startFetch(
            { kind: 'dialed', connection, fetches: new Map() },
            { cid, runner: caller, queued: [] },
            transition,
          );
        },
      },
      dialed: {
        // A CID with no fetch gets the caller as its runner, and a CID with one queues the caller behind it.
        asked(state, { cid, caller }, transition) {
          const fetch = state.fetches.get(cid);
          if (fetch !== undefined) {
            transition.emitState(withFetch(state, cid, { ...fetch, queued: [...fetch.queued, caller] }));
            return;
          }
          startFetch(state, { cid, runner: caller, queued: [] }, transition);
        },
        // Either settle of a runner that already left finds nothing.
        blockFetched(state, { cid, runner, bytes }, transition) {
          const fetch = state.fetches.get(cid);
          if (fetch?.runner !== runner) {
            return;
          }
          transition.emitSideEffect({ kind: 'resolve', caller: runner, bytes });
          for (const caller of fetch.queued) {
            // A copy each, since a caller may transfer its buffer away.
            transition.emitSideEffect({ kind: 'resolve', caller, bytes: bytes.slice() });
          }
          endFetch(state, cid, transition);
        },
        fetchFailed(state, { cid, runner, error }, transition) {
          const fetch = state.fetches.get(cid);
          if (fetch?.runner !== runner) {
            return;
          }
          transition.emitSideEffect({ kind: 'reject', caller: runner, error });
          passFetchOn(state, { cid, queued: fetch.queued }, transition);
        },
        callerAborted(state, { cid, caller }, transition) {
          const fetch = state.fetches.get(cid);
          if (fetch === undefined) {
            return;
          }
          const error = createAbortError(cid, caller.signal?.reason);
          if (fetch.runner === caller) {
            transition.emitSideEffect({ kind: 'reject', caller, error });
            passFetchOn(state, { cid, queued: fetch.queued }, transition);
            return;
          }
          if (!fetch.queued.includes(caller)) {
            return;
          }
          const queued = fetch.queued.filter(other => other !== caller);
          transition.emitState(withFetch(state, cid, { ...fetch, queued }));
          transition.emitSideEffect({ kind: 'reject', caller, error });
        },
      },
    },
    onEffect: effect => {
      switch (effect.kind) {
        case 'resolve':
          effect.caller.resolve(effect.bytes);
          return;
        case 'reject':
          effect.caller.reject(effect.error);
          return;
        case 'disconnect':
          try {
            effect.connection.disconnect();
          } catch (error) {
            report.defect(error, {
              step: 'bitswap_release',
              metric: contentBitswapReleaseMetric,
              message: '[dot.li bitswap] closing the Bulletin connection failed:',
            });
          }
          return;
      }
    },
    onError: error => {
      report.defect(error, {
        step: 'transition',
        metric: bitswapClientTransitionMetric,
        message: '[dot.li bitswap] A bitswap client transition threw',
      });
    },
  });

  return {
    /**
     * Fetches one block. Pass `signal` from anything that can be torn down, since a retrying call runs for minutes. A
     * second call for a CID already being fetched waits for that fetch and gets a copy of its bytes. Rejects with an
     * abort error when `signal` fires, and with a coded error when the dial, the retries or the total budget fail.
     */
    get(cid: string, signal?: AbortSignal): Promise<Uint8Array> {
      if (signal?.aborted === true) {
        return Promise.reject(createAbortError(cid, signal.reason));
      }
      const { promise, resolve, reject } = createDeferred<Uint8Array>();
      // Taken at the call, so a caller queued behind another fetch of the CID spends its own budget while it waits.
      const caller: Caller = { deadline: timers.now() + TIMEOUTS.BITSWAP_TOTAL_BUDGET, signal, resolve, reject };
      const stopListening =
        signal === undefined
          ? noop
          : listen({
              target: signal,
              type: 'abort',
              handler: () => {
                client.update({ kind: 'callerAborted', cid, caller });
              },
            });
      client.update({ kind: 'asked', cid, caller });
      return promise.finally(stopListening);
    },
  };

  /**
   * Opens a connection to Bulletin. Throws an `UNAVAILABLE` error when the caller has no Bulletin, and what the
   * provider throws when the dial fails.
   */
  function dial(): JsonRpcConnection {
    const bulletin = provider();
    if (bulletin === null) {
      throw setErrorName(new Error('Bulletin is not in the supported chain set'), BITSWAP_ERRORS.UNAVAILABLE);
    }
    return bulletin(requests.hearReply);
  }

  /** Hands the fetch of `cid` to its next queued caller, who fetches again on its own budget, or ends it. */
  function passFetchOn(
    state: Dialed,
    { cid, queued }: { cid: string; queued: readonly Caller[] },
    transition: Transition<ClientMachine>,
  ): void {
    const [next, ...rest] = queued;
    if (next === undefined) {
      endFetch(state, cid, transition);
      return;
    }
    startFetch(state, { cid, runner: next, queued: rest }, transition);
  }

  /** Moves `state` to hold the fetch of `cid`, runs it for its runner, and sends its outcome to the machine. */
  function startFetch(
    state: Dialed,
    { cid, runner, queued }: SharedFetch & { cid: string },
    { emitState, update }: Transition<ClientMachine>,
  ): void {
    emitState(withFetch(state, cid, { runner, queued }));
    update(
      requests.fetchBlock({ cid, deadline: runner.deadline, signal: runner.signal, connection: state.connection }).then(
        bytes => ({ kind: 'blockFetched', cid, runner, bytes }),
        (error: unknown) => ({ kind: 'fetchFailed', cid, runner, error }),
      ),
    );
  }
}

function withFetch(state: Dialed, cid: string, fetch: SharedFetch): Dialed {
  return { ...state, fetches: new Map(state.fetches).set(cid, fetch) };
}

/** Removes the fetch of `cid`, and closes the connection once no fetch is left. */
function endFetch(state: Dialed, cid: string, { emitState, emitSideEffect }: Transition<ClientMachine>): void {
  const fetches = new Map(state.fetches);
  fetches.delete(cid);
  if (fetches.size === 0) {
    emitState({ kind: 'idle' });
    emitSideEffect({ kind: 'disconnect', connection: state.connection });
    return;
  }
  emitState({ ...state, fetches });
}
