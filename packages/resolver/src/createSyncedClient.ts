// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One chain client kept synced over its connection: built on the first ask, kept while its follow runs, dropped when
// the follow stops, and built again on the next ask.

import { createReporter, defineCount, m, spans } from '@dotli/metrics';
import { createStateMachine, log, withTimeout, type HandlerOf, type MachineTypes } from '@dotli/shared';

import { ApiStoppedError } from './apiStoppedError.js';
import type { Api } from './createRawApi.js';
import { NetworkSyncTimeoutError } from './networkSyncTimeoutError.js';

/** A chain client: its raw reads, and the teardown of its follow and connection. */
export type ChainClient = {
  /** The raw reads over this client's follow. */
  readonly api: Api;
  /** Tears down the follow and the connection. Never throws. */
  destroy: () => void;
};

/**
 * Where the client stands. `asker` is the token of the call whose ask started the build, so its failure goes to that
 * call only. `startedAt` and `syncStartedAt` mark the build's steps for its timings.
 */
export type SyncedClientState =
  | { kind: 'idle' }
  | { kind: 'connecting'; asker: symbol; startedAt: number }
  | { kind: 'syncing'; asker: symbol; client: ChainClient; startedAt: number; syncStartedAt: number }
  | { kind: 'ready'; client: ChainClient }
  | { kind: 'failed'; asker: symbol; error: unknown };

type SyncedClientEvent =
  | { kind: 'asked'; asker: symbol }
  | { kind: 'connect' }
  | { kind: 'synced' }
  | { kind: 'syncFailed'; error: unknown }
  | { kind: 'stopped' };

type SyncedClientEffect =
  | { kind: 'synced'; syncMs: number; totalMs: number }
  | { kind: 'syncFailed'; error: unknown; totalMs: number }
  | { kind: 'stopped' }
  | { kind: 'destroy'; client: ChainClient };

type SyncedClientMachine = MachineTypes<SyncedClientState, SyncedClientEvent, SyncedClientEffect>;

type Params = {
  /** The chain's name, for its sync timeout error and its reports. */
  chain: string;
  /** How long a build waits for the follow's first block. */
  syncTimeoutMs: number;
  /** Whether the light client's sync timings are recorded. A gateway's would skew its dashboards. */
  timed: boolean;
  /** Opens a client on a fresh connection. */
  openClient: () => ChainClient;
};

type GetApiOptions = {
  /** Aborted once the caller stops waiting, so it starts no build nobody waits for. */
  signal?: AbortSignal | undefined;
};

const report = createReporter({ flow: 'resolve' });

/** From client creation to first finalized block. */
const SMOLDOT_FINALIZED_BLOCK = 'smoldot.finalized_block';

/**
 * Count. A transition of a chain client's lifecycle threw, a bug. Tagged `outcome` (error) and `reason` (the error's
 * name).
 */
const syncedClientTransitionMetric = defineCount<'error'>('resolve.synced_client_transition');

/**
 * Keeps one synced client on the connection `openClient` opens.
 *
 * @example
 * const assetHub = createSyncedClient({ chain: 'Asset Hub', syncTimeoutMs: 180_000, timed: true, openClient });
 * const api = await assetHub.getApi({ signal }); // later calls get the kept client's reads
 */
export function createSyncedClient({ chain, syncTimeoutMs, timed, openClient }: Params) {
  const startBuild: HandlerOf<SyncedClientMachine, 'idle' | 'failed', 'asked'> = (
    _state,
    { asker },
    { emitState, update },
  ) => {
    // The open runs in the next transition, so `connecting` is told before the open's own calls log.
    update({ kind: 'connect' });
    emitState({ kind: 'connecting', asker, startedAt: performance.now() });
  };

  const machine = createStateMachine<SyncedClientMachine>({
    initial: { kind: 'idle' },
    // Each handler starts the work its next state waits on before it emits that state. A store listener that throws
    // during the emit leaves the state moved and its work running, so no state is left with nothing pending.
    handlers: {
      idle: { asked: startBuild },
      connecting: {
        connect({ asker, startedAt }, _event, { emitState, emitSideEffect, update }) {
          let client: ChainClient;
          try {
            client = openClient();
          } catch (error) {
            emitSideEffect({ kind: 'syncFailed', error, totalMs: performance.now() - startedAt });
            emitState({ kind: 'failed', asker, error });
            return;
          }
          update(waitForSync(client));
          emitState({ kind: 'syncing', asker, client, startedAt, syncStartedAt: performance.now() });
        },
      },
      syncing: {
        synced({ client, startedAt, syncStartedAt }, _event, { emitState, emitSideEffect, update }) {
          // A dead follow would otherwise make every later read return `null`, which reads as "name not found".
          client.api.onStop(() => {
            update({ kind: 'stopped' });
          });
          const now = performance.now();
          emitSideEffect({ kind: 'synced', syncMs: now - syncStartedAt, totalMs: now - startedAt });
          emitState({ kind: 'ready', client });
        },
        syncFailed({ asker, client, startedAt }, { error }, { emitState, emitSideEffect }) {
          emitSideEffect({ kind: 'destroy', client });
          emitSideEffect({ kind: 'syncFailed', error, totalMs: performance.now() - startedAt });
          emitState({ kind: 'failed', asker, error });
        },
      },
      ready: {
        stopped({ client }, _event, { emitState, emitSideEffect }) {
          emitSideEffect({ kind: 'destroy', client });
          emitSideEffect({ kind: 'stopped' });
          emitState({ kind: 'idle' });
        },
      },
      failed: { asked: startBuild },
    },
    onEffect: runEffect,
    onError: error => {
      report.defect(error, {
        step: 'synced_client_transition',
        metric: syncedClientTransitionMetric,
        message: '[dot.li resolve] A chain client transition threw',
      });
    },
  });

  return {
    /** Where the client stands, for a caller that tells its own listeners the phases. */
    state: machine.state,
    /**
     * The synced client's reads, built when no client is kept or building. Rejects with the build's error when this
     * call's build fails, such as `NetworkSyncTimeoutError`, with `ApiStoppedError` when the client stops as it syncs,
     * and with the reason of `signal` once it is aborted.
     */
    async getApi({ signal }: GetApiOptions = {}): Promise<Api> {
      const asker = Symbol('asker');
      // Waiters wake in the order they called `await()`. One that wakes to another call's failure asks again, and
      // either builds or waits on the build another waiter started.
      for (;;) {
        signal?.throwIfAborted();
        machine.update({ kind: 'asked', asker });
        await machine.await();
        const settled = machine.state.get();
        switch (settled.kind) {
          case 'ready':
            return settled.client.api;
          // The client this call waited for stopped as it synced, which the caller's halt retry counts.
          case 'idle':
            throw new ApiStoppedError();
          case 'failed':
            if (settled.asker === asker) {
              throw settled.error;
            }
            continue;
          // Relies on every build ending in a transition: `syncing` is left by the sync's own event, and `onStop` never
          // throws. Without that, a settled machine here would make this loop spin.
          case 'connecting':
          case 'syncing':
            continue;
        }
      }
    },
  };

  /** Waits for the follow's first block. Never rejects: any failure, a synchronous one too, is `syncFailed`. */
  async function waitForSync(client: ChainClient): Promise<SyncedClientEvent> {
    // `api.whenReady()` never settles without reachable peers, so the wait is bounded and its error names the cause.
    const waitForFirstBlock = () =>
      withTimeout({
        work: client.api.whenReady(),
        ms: syncTimeoutMs,
        timeoutError: () => new NetworkSyncTimeoutError(chain, syncTimeoutMs),
      });
    try {
      await (timed ? m.span(SMOLDOT_FINALIZED_BLOCK, waitForFirstBlock) : waitForFirstBlock());
      return { kind: 'synced' };
    } catch (error) {
      return { kind: 'syncFailed', error };
    }
  }

  function runEffect(effect: SyncedClientEffect): void {
    switch (effect.kind) {
      case 'synced': {
        const { syncMs, totalMs } = effect;
        if (timed) {
          m.measure(SMOLDOT_FINALIZED_BLOCK, syncMs);
          m.distribution(SMOLDOT_FINALIZED_BLOCK, syncMs);
          m.measure(spans.SMOLDOT_PRESYNC, totalMs);
          m.distribution(spans.SMOLDOT_PRESYNC, totalMs, { unit: 'millisecond', attributes: { outcome: 'ok' } });
        }
        report.log.event('Chain client ready', { chain, sync_ms: Math.round(syncMs), total_ms: Math.round(totalMs) });
        return;
      }
      case 'syncFailed':
        if (timed) {
          const outcome = effect.error instanceof NetworkSyncTimeoutError ? 'timeout' : 'error';
          m.distribution(spans.SMOLDOT_PRESYNC, effect.totalMs, { unit: 'millisecond', attributes: { outcome } });
        }
        return;
      case 'stopped':
        log.warn('[dot.li resolve] chainHead follow stopped, dropping its client', { chain });
        return;
      case 'destroy':
        effect.client.destroy();
        return;
    }
  }
}
