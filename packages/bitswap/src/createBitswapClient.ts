// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Fetches blocks with `bitswap_v1_get` over one Bulletin connection, held while a fetch runs and closed after the last.

import type { JsonRpcConnection, JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import { TIMEOUTS } from '@dotli/config';
import { createReporter, defineCount } from '@dotli/metrics';
import {
  createStateMachine,
  listen,
  noop,
  setErrorName,
  realTimers,
  toError,
  type HandlerOf,
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

type Fetches = ReadonlyMap<string, SharedFetch>;

/**
 * The connection is held while any fetch runs, retry waits included, and closed after the last. The first request
 * dials, so `undialed` may hold fetches. An ended fetch leaves `fetches`.
 */
type ClientState =
  { kind: 'undialed'; fetches: Fetches } | { kind: 'dialed'; connection: JsonRpcConnection; fetches: Fetches };

type ClientEvent =
  | { kind: 'asked'; cid: string; caller: Caller }
  | { kind: 'callerAborted'; cid: string; caller: Caller }
  | { kind: 'blockFetched'; cid: string; runner: Caller; bytes: Uint8Array }
  | { kind: 'fetchFailed'; cid: string; runner: Caller; error: unknown }
  | { kind: 'requested'; id: number; cid: string };

type ClientEffect =
  | { kind: 'resolve'; caller: Caller; bytes: Uint8Array }
  | { kind: 'reject'; caller: Caller; error: unknown }
  | { kind: 'send'; connection: JsonRpcConnection; id: number; cid: string }
  | { kind: 'requestFailed'; id: number; error: Error }
  | { kind: 'disconnect'; connection: JsonRpcConnection };

type ClientMachine = MachineTypes<ClientState, ClientEvent, ClientEffect>;

/** Creates a client that fetches blocks by CID over the provider's bitswap JSON-RPC, sharing one fetch per CID. */
export function createBitswapClient({ provider, timers = realTimers }: Params) {
  const requests = createBitswapRequests({ timers });

  /** A CID with no fetch gets the caller as its runner, and a CID with one queues the caller behind it. */
  const addCaller: HandlerOf<ClientMachine, 'undialed' | 'dialed', 'asked'> = (
    state,
    { cid, caller },
    { emitState, update },
  ) => {
    const fetch = state.fetches.get(cid);
    if (fetch !== undefined) {
      emitState({
        ...state,
        fetches: new Map(state.fetches).set(cid, { ...fetch, queued: [...fetch.queued, caller] }),
      });
      return;
    }
    emitState({ ...state, fetches: new Map(state.fetches).set(cid, { runner: caller, queued: [] }) });
    startFetch(cid, caller, update);
  };

  /** Hands the block to the runner and a copy to each queued caller. A settle of an earlier runner finds nothing. */
  const finishFetch: HandlerOf<ClientMachine, 'undialed' | 'dialed', 'blockFetched'> = (
    state,
    { cid, runner, bytes },
    transition,
  ) => {
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
  };

  /** Fails the runner, and hands the fetch to the next queued caller, who fetches again on its own budget. */
  const failFetch: HandlerOf<ClientMachine, 'undialed' | 'dialed', 'fetchFailed'> = (
    state,
    { cid, runner, error },
    transition,
  ) => {
    const fetch = state.fetches.get(cid);
    if (fetch?.runner !== runner) {
      return;
    }
    const failure = runner.signal?.aborted === true ? createAbortError(cid, error) : error;
    transition.emitSideEffect({ kind: 'reject', caller: runner, error: failure });
    const [next, ...rest] = fetch.queued;
    if (next === undefined) {
      endFetch(state, cid, transition);
      return;
    }
    transition.emitState({ ...state, fetches: new Map(state.fetches).set(cid, { runner: next, queued: rest }) });
    startFetch(cid, next, transition.update);
  };

  /** Drops a queued caller that aborted. A runner's abort ends its fetch instead, which `fetchFailed` hears. */
  const dropCaller: HandlerOf<ClientMachine, 'undialed' | 'dialed', 'callerAborted'> = (
    state,
    { cid, caller },
    { emitState, emitSideEffect },
  ) => {
    const fetch = state.fetches.get(cid);
    if (fetch?.queued.includes(caller) !== true) {
      return;
    }
    const queued = fetch.queued.filter(other => other !== caller);
    emitState({ ...state, fetches: new Map(state.fetches).set(cid, { ...fetch, queued }) });
    emitSideEffect({ kind: 'reject', caller, error: createAbortError(cid, caller.signal?.reason) });
  };

  const client = createStateMachine<ClientMachine>({
    initial: { kind: 'undialed', fetches: new Map() },
    handlers: {
      undialed: {
        asked: addCaller,
        blockFetched: finishFetch,
        fetchFailed: failFetch,
        callerAborted: dropCaller,
        requested(state, { id, cid }, { emitState, emitSideEffect }) {
          // A request of a fetch that has ended would dial with nothing to close the connection.
          if (!state.fetches.has(cid)) {
            return;
          }
          let connection: JsonRpcConnection;
          // A dial that throws fails this attempt at once, and the next request dials again.
          try {
            const bulletin = provider();
            if (bulletin === null) {
              const error = new Error('Bulletin is not in the supported chain set');
              emitSideEffect({ kind: 'requestFailed', id, error: setErrorName(error, BITSWAP_ERRORS.UNAVAILABLE) });
              return;
            }
            connection = bulletin(requests.hearReply);
          } catch (error) {
            emitSideEffect({ kind: 'requestFailed', id, error: toError(error) });
            return;
          }
          emitState({ kind: 'dialed', connection, fetches: state.fetches });
          emitSideEffect({ kind: 'send', connection, id, cid });
        },
      },
      dialed: {
        asked: addCaller,
        blockFetched: finishFetch,
        fetchFailed: failFetch,
        callerAborted: dropCaller,
        requested({ connection, fetches }, { id, cid }, { emitSideEffect }) {
          if (!fetches.has(cid)) {
            return;
          }
          emitSideEffect({ kind: 'send', connection, id, cid });
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
        case 'send':
          try {
            effect.connection.send({ jsonrpc: '2.0', id: effect.id, method: 'bitswap_v1_get', params: [effect.cid] });
          } catch (error) {
            requests.fail(effect.id, toError(error));
          }
          return;
        case 'requestFailed':
          requests.fail(effect.id, effect.error);
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
     * abort error when `signal` fires, and with a coded error when the retries or the total budget run out.
     */
    get(cid: string, signal?: AbortSignal): Promise<Uint8Array> {
      if (signal?.aborted === true) {
        return Promise.reject(createAbortError(cid, signal.reason));
      }
      // Taken at the call, so a caller queued behind another fetch of the CID spends its own budget while it waits.
      const deadline = timers.now() + TIMEOUTS.BITSWAP_TOTAL_BUDGET;
      let stopListening = noop;
      return new Promise<Uint8Array>((resolve, reject) => {
        const caller: Caller = { deadline, signal, resolve, reject };
        if (signal !== undefined) {
          stopListening = listen({
            target: signal,
            type: 'abort',
            handler: () => {
              client.update({ kind: 'callerAborted', cid, caller });
            },
          });
        }
        client.update({ kind: 'asked', cid, caller });
      }).finally(() => {
        stopListening();
      });
    },
  };

  /** Runs the fetch of `cid` for `runner`, and sends its outcome to the machine. */
  function startFetch(cid: string, runner: Caller, update: Transition<ClientMachine>['update']): void {
    update(
      requests
        .fetchBlock({
          cid,
          deadline: runner.deadline,
          signal: runner.signal,
          send: id => {
            update({ kind: 'requested', id, cid });
          },
        })
        .then(
          bytes => ({ kind: 'blockFetched', cid, runner, bytes }),
          (error: unknown) => ({ kind: 'fetchFailed', cid, runner, error }),
        ),
    );
  }
}

/** Removes the fetch of `cid`, and closes the connection once no fetch is left. */
function endFetch(
  state: ClientState,
  cid: string,
  { emitState, emitSideEffect }: Pick<Transition<ClientMachine>, 'emitState' | 'emitSideEffect'>,
): void {
  const fetches = new Map(state.fetches);
  fetches.delete(cid);
  if (state.kind === 'dialed' && fetches.size === 0) {
    emitState({ kind: 'undialed', fetches });
    emitSideEffect({ kind: 'disconnect', connection: state.connection });
    return;
  }
  emitState({ ...state, fetches });
}
