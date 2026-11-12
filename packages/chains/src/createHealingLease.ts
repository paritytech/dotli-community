// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A halt still ends the lease's in-flight requests and follows, and a request sent while no chain can be had is
// answered with the halted marker, since no follow state survives a rebuild and the consumer has to ask again.

import type { JsonRpcConnection, JsonRpcMessage, JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import { createReporter, defineCount } from '@dotli/metrics';
import { createStateMachine, type MachineTypes, type Timers, type Transition } from '@dotli/shared';
import { getHaltReason, type RemoteChainHalt } from './chainHaltError.js';
import { createChainHaltedError } from './createChainHaltedError.js';
import type { ChainRedial } from './createChainRedial.js';
import { createJsonRpcError } from './createJsonRpcError.js';

/** What a take of a chain found, holding the lease's `Connection` when it attached. */
export type AttachAnswer<Connection = JsonRpcConnection> =
  { kind: 'attached'; connection: Connection } | { kind: 'halted'; error: unknown } | { kind: 'unreachable' };

type Params = {
  /** The chain, lowercase. */
  key: string;
  /**
   * Takes a lease on the chain as the pool holds it now, and answers what it found. A halt heard while it takes the
   * lease comes back as `halted`, and only a later one reaches `onHalt`. Throws what the pool's connect throws.
   */
  attach: (onMessage: (message: JsonRpcMessage) => void, onHalt: (error?: unknown) => void) => AttachAnswer;
  /** The pool's redial. */
  redial: Pick<ChainRedial, 'noteHalt' | 'tryDial' | 'waitMs' | 'tryDialGate' | 'gateWaitMs'>;
  /** The timers each wait to heal runs on. */
  timers: Pick<Timers, 'setTimeout' | 'clearTimeout'>;
  /** Names the lease in debug logs. */
  holder: string;
  /** Hears every message of every lease the connection takes, and the answers it gives itself. */
  onMessage: (message: JsonRpcMessage) => void;
};

/** One attach, minted for it, so a halt from an earlier lease finds the state moved on. */
type Take = object;

/**
 * `taking` is a take whose attach runs or whose answer is queued. `detached` waits on its `heal` timer, and `tried`
 * says whether a take failed since the halt. `releasing` is a retake released before its answer came.
 */
type LeaseState =
  | { kind: 'taking'; take: Take; haltedBy: RemoteChainHalt }
  | { kind: 'attached'; take: Take; connection: JsonRpcConnection }
  | { kind: 'detached'; tried: boolean; haltedBy: RemoteChainHalt; heal: unknown }
  | { kind: 'releasing' }
  | { kind: 'released' };

type DetachedState = Extract<LeaseState, { kind: 'detached' }>;

type LeaseEvent =
  | { kind: 'taken'; answer: AttachAnswer }
  | { kind: 'takeThrew'; error: unknown }
  | { kind: 'leaseHalted'; take: Take; error: unknown }
  | { kind: 'healDue'; detached: DetachedState }
  | { kind: 'sendAsked'; message: JsonRpcRequest }
  | { kind: 'releaseAsked' };

type LeaseEffect =
  { kind: 'healed'; outcome: 'ok' | 'halted' | 'no_transport' } | { kind: 'healFailed'; error: unknown };

type LeaseMachine = MachineTypes<LeaseState, LeaseEvent, LeaseEffect>;

const report = createReporter({ flow: 'protocol' });

// Prefixes this lease's debug lines, which print only with VITE_APP_DEBUG, and its defect messages, which always do.
const LEASE_TAG = '[dot.li chain-lease]';

/**
 * A lease's new take of its chain after a halt, for every holder. Tagged `outcome` and, on error, `reason`:
 * `no_transport` when the pool has no transport for the chain, `halted` when the new lease halted as it attached, or
 * the error's name.
 */
const chainPoolHealMetric = defineCount<'error' | 'ok'>('chain_pool.heal');

/**
 * A connection that takes the rebuilt chain after a halt. Throws when the first attach finds no transport, or as
 * `attach` throws.
 */
export function createHealingLease({ key, attach, redial, timers, holder, onMessage }: Params): JsonRpcConnection {
  const first: Take = {};
  const answer = attach(onMessage, error => {
    lease.update({ kind: 'leaseHalted', take: first, error });
  });
  if (answer.kind === 'unreachable') {
    throw new Error(`No chain transport for ${key}`);
  }
  const lease = createStateMachine<LeaseMachine>({
    // The first take that holds the chain is no heal, so it counts none.
    initial:
      answer.kind === 'attached'
        ? { kind: 'attached', take: first, connection: answer.connection }
        : { kind: 'taking', take: first, haltedBy: getHaltReason(answer.error) },
    handlers: {
      taking: {
        taken({ take, haltedBy }, { answer: found }, transition) {
          transition.emitSideEffect(getHealedEffect(found));
          switch (found.kind) {
            case 'attached':
              transition.emitState({ kind: 'attached', take, connection: found.connection });
              return;
            case 'halted': {
              const reason = getHaltReason(found.error);
              redial.noteHalt(key, reason);
              detach({ tried: true, haltedBy: reason }, transition);
              return;
            }
            case 'unreachable':
              detach({ tried: true, haltedBy }, transition);
              return;
          }
        },
        takeThrew({ haltedBy }, { error }, transition) {
          transition.emitSideEffect({ kind: 'healFailed', error });
          detach({ tried: true, haltedBy }, transition);
        },
        sendAsked(_state, { message }) {
          answerHalted(message);
        },
        releaseAsked(_state, _event, { emitState }) {
          emitState({ kind: 'releasing' });
        },
      },
      attached: {
        leaseHalted({ take: held }, { take, error }, transition) {
          if (take !== held) {
            return;
          }
          const haltedBy = getHaltReason(error);
          redial.noteHalt(key, haltedBy);
          detach({ tried: false, haltedBy }, transition);
        },
        sendAsked({ connection }, { message }) {
          connection.send(message);
        },
        releaseAsked(_state, _event, { emitState }) {
          emitState({ kind: 'released' });
        },
      },
      detached: {
        healDue(state, { detached }, transition) {
          // A timer from a wait that was left heals nothing.
          if (detached !== state) {
            return;
          }
          if (!pickDial(state.tried).tryDial(key, state.haltedBy)) {
            waitToHeal(state, transition);
            return;
          }
          startTake(state.haltedBy, transition);
        },
        // A send tries once and starts no wait, since the state's own wait is still pending.
        sendAsked(state, { message }, transition) {
          if (!pickDial(state.tried).tryDial(key, state.haltedBy)) {
            answerHalted(message);
            return;
          }
          startTake(state.haltedBy, transition);
          timers.clearTimeout(state.heal);
          // Sent again so it is handled after the take's answer.
          transition.update({ kind: 'sendAsked', message });
        },
        releaseAsked({ heal }, _event, { emitState }) {
          emitState({ kind: 'released' });
          timers.clearTimeout(heal);
        },
      },
      releasing: {
        taken(_state, { answer: found }, { emitState, emitSideEffect }) {
          emitState({ kind: 'released' });
          emitSideEffect(getHealedEffect(found));
          // A release while it attached leaves nothing to keep the new lease.
          if (found.kind === 'attached') {
            found.connection.disconnect();
          }
        },
        takeThrew(_state, { error }, { emitState, emitSideEffect }) {
          emitState({ kind: 'released' });
          emitSideEffect({ kind: 'healFailed', error });
        },
      },
      released: null,
    },
    onEffect: effect => {
      switch (effect.kind) {
        case 'healed':
          report.log.debug(`${LEASE_TAG} ${key} taken again by ${holder}: ${effect.outcome}`);
          chainPoolHealMetric.count(
            effect.outcome === 'ok' ? { outcome: 'ok' } : { outcome: 'error', reason: effect.outcome },
          );
          return;
        case 'healFailed':
          reportHealDefect(effect.error, `${LEASE_TAG} ${holder} could not take ${key} again:`);
          return;
      }
    },
    onError: error => {
      reportHealDefect(error, `${LEASE_TAG} ${holder}'s heal of ${key} failed:`);
    },
  });
  // The first take's answer is queued like a retake's, so its halt is counted and followed as one.
  if (answer.kind === 'halted') {
    lease.update({ kind: 'taken', answer });
  }

  return {
    /**
     * Sends on the chain held now, taking it again first when its gate allows, and otherwise answers a request with the
     * halted marker and drops a notification. Throws only as the held lease's `send` throws.
     */
    send(message: JsonRpcRequest): void {
      const state = lease.state.get();
      if (state.kind === 'attached') {
        state.connection.send(message);
        return;
      }
      lease.update({ kind: 'sendAsked', message });
    },
    /** Releases the lease held now, once, and stops healing. Throws only as that lease's `disconnect` throws. */
    disconnect(): void {
      const state = lease.state.get();
      lease.update({ kind: 'releaseAsked' });
      if (state.kind === 'attached') {
        state.connection.disconnect();
      }
    },
  };

  /** Takes the chain at once when its dial passes with no wait, as a heal inside the halt, and waits for it otherwise. */
  function detach(
    { tried, haltedBy }: Pick<DetachedState, 'tried' | 'haltedBy'>,
    transition: Transition<LeaseMachine>,
  ): void {
    const dial = pickDial(tried);
    if (dial.waitMs(key, haltedBy) === 0 && dial.tryDial(key, haltedBy)) {
      startTake(haltedBy, transition);
      return;
    }
    waitToHeal({ tried, haltedBy }, transition);
  }

  /** Moves to a new `detached`, whose timer heals that wait only. */
  function waitToHeal(
    { tried, haltedBy }: Pick<DetachedState, 'tried' | 'haltedBy'>,
    { emitState, update }: Transition<LeaseMachine>,
  ): void {
    const detached: DetachedState = {
      kind: 'detached',
      tried,
      haltedBy,
      heal: timers.setTimeout(
        () => {
          update({ kind: 'healDue', detached });
        },
        pickDial(tried).waitMs(key, haltedBy),
      ),
    };
    emitState(detached);
  }

  /** Takes the chain again. Its answer is queued, so a release or a send heard during the attach is handled first. */
  function startTake(haltedBy: RemoteChainHalt, { emitState, update }: Transition<LeaseMachine>): void {
    const take: Take = {};
    emitState({ kind: 'taking', take, haltedBy });
    try {
      const found = attach(onMessage, error => {
        update({ kind: 'leaseHalted', take, error });
      });
      update({ kind: 'taken', answer: found });
    } catch (error) {
      update({ kind: 'takeThrew', error });
    }
  }

  // A lease whose take failed since its halt waits on the gate even while the chain is up, since that chain refused
  // this lease and a free join would take it again at once.
  function pickDial(tried: boolean): Pick<ChainRedial, 'tryDial' | 'waitMs'> {
    return tried ? { tryDial: redial.tryDialGate, waitMs: redial.gateWaitMs } : redial;
  }

  function reportHealDefect(error: unknown, message: string): void {
    report.defect(error, { step: 'chain_heal', metric: chainPoolHealMetric, message });
  }

  function answerHalted(message: JsonRpcRequest): void {
    // A notification has nothing to answer.
    if (message.id === undefined || message.id === null) {
      return;
    }
    onMessage(createJsonRpcError(message.id, createChainHaltedError()));
  }
}

function getHealedEffect(answer: AttachAnswer): LeaseEffect {
  switch (answer.kind) {
    case 'attached':
      return { kind: 'healed', outcome: 'ok' };
    case 'halted':
      return { kind: 'healed', outcome: 'halted' };
    case 'unreachable':
      return { kind: 'healed', outcome: 'no_transport' };
  }
}
