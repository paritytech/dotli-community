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

/** Why the lease last halted, and whether a take has failed since. */
type Halt = { haltedBy: RemoteChainHalt; tried: boolean };

/**
 * `taking` holds the sends that wait for its take's answer. `detached` waits for its dial to open until `wait` aborts.
 * `releasing` is a take released before its answer came.
 */
type LeaseState =
  | { kind: 'taking'; take: Take; haltedBy: RemoteChainHalt; sends: JsonRpcRequest[] }
  | { kind: 'attached'; take: Take; connection: JsonRpcConnection }
  | { kind: 'detached'; halt: Halt; wait: AbortController }
  | { kind: 'releasing' }
  | { kind: 'released' };

type LeaseEvent =
  | { kind: 'taken'; answer: AttachAnswer }
  | { kind: 'takeThrew'; error: unknown }
  | { kind: 'leaseHalted'; take: Take; error: unknown }
  | { kind: 'healDue' }
  | { kind: 'sendAsked'; message: JsonRpcRequest }
  | { kind: 'releaseAsked' };

type LeaseEffect =
  | { kind: 'take'; take: Take }
  | { kind: 'waitToHeal'; wait: AbortController; ms: number }
  | { kind: 'stopWait'; wait: AbortController }
  | { kind: 'send'; connection: JsonRpcConnection; message: JsonRpcRequest }
  | { kind: 'answerHalted'; message: JsonRpcRequest }
  | { kind: 'disconnect'; connection: JsonRpcConnection }
  | { kind: 'healed'; found: AttachAnswer['kind'] }
  | { kind: 'healFailed'; error: unknown };

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
        : { kind: 'taking', take: first, haltedBy: getHaltReason(answer.error), sends: [] },
    handlers: {
      taking: {
        taken(state, { answer: found }, transition) {
          transition.emitSideEffect({ kind: 'healed', found: found.kind });
          switch (found.kind) {
            case 'attached':
              transition.emitState({ kind: 'attached', take: state.take, connection: found.connection });
              for (const message of state.sends) {
                transition.emitSideEffect({ kind: 'send', connection: found.connection, message });
              }
              return;
            case 'halted': {
              const haltedBy = getHaltReason(found.error);
              redial.noteHalt(key, haltedBy);
              failTake(state, { haltedBy, tried: true }, transition);
              return;
            }
            case 'unreachable':
              failTake(state, { haltedBy: state.haltedBy, tried: true }, transition);
              return;
          }
        },
        takeThrew(state, { error }, transition) {
          transition.emitSideEffect({ kind: 'healFailed', error });
          failTake(state, { haltedBy: state.haltedBy, tried: true }, transition);
        },
        sendAsked(state, { message }, { emitState }) {
          emitState({ ...state, sends: [...state.sends, message] });
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
          retake({ haltedBy, tried: false }, transition);
        },
        sendAsked({ connection }, { message }, { emitSideEffect }) {
          emitSideEffect({ kind: 'send', connection, message });
        },
        releaseAsked(_state, _event, { emitState }) {
          emitState({ kind: 'released' });
        },
      },
      detached: {
        healDue({ halt }, _event, transition) {
          retake(halt, transition);
        },
        // A send tries once and starts no wait, since the state's own wait is still pending.
        sendAsked({ halt, wait }, { message }, transition) {
          if (!pickDial(halt.tried).tryDial(key, halt.haltedBy)) {
            transition.emitSideEffect({ kind: 'answerHalted', message });
            return;
          }
          transition.emitSideEffect({ kind: 'stopWait', wait });
          startTake(halt.haltedBy, [message], transition);
        },
        releaseAsked({ wait }, _event, { emitState, emitSideEffect }) {
          emitState({ kind: 'released' });
          emitSideEffect({ kind: 'stopWait', wait });
        },
      },
      releasing: {
        taken(_state, { answer: found }, { emitState, emitSideEffect }) {
          emitState({ kind: 'released' });
          emitSideEffect({ kind: 'healed', found: found.kind });
          // A release while it attached leaves nothing to keep the new lease.
          if (found.kind === 'attached') {
            emitSideEffect({ kind: 'disconnect', connection: found.connection });
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
        case 'take': {
          const { take } = effect;
          try {
            const found = attach(onMessage, error => {
              lease.update({ kind: 'leaseHalted', take, error });
            });
            lease.update({ kind: 'taken', answer: found });
          } catch (error) {
            lease.update({ kind: 'takeThrew', error });
          }
          return;
        }
        case 'waitToHeal': {
          const handle = timers.setTimeout(() => {
            lease.update({ kind: 'healDue' });
          }, effect.ms);
          effect.wait.signal.addEventListener('abort', () => {
            timers.clearTimeout(handle);
          });
          return;
        }
        case 'stopWait':
          effect.wait.abort();
          return;
        case 'send':
          effect.connection.send(effect.message);
          return;
        case 'answerHalted': {
          const { id } = effect.message;
          // A notification has nothing to answer.
          if (id !== undefined && id !== null) {
            onMessage(createJsonRpcError(id, createChainHaltedError()));
          }
          return;
        }
        case 'disconnect':
          effect.connection.disconnect();
          return;
        case 'healed': {
          const outcome = getHealOutcome(effect.found);
          report.log.debug(`${LEASE_TAG} ${key} taken again by ${holder}: ${outcome}`);
          chainPoolHealMetric.count(outcome === 'ok' ? { outcome: 'ok' } : { outcome: 'error', reason: outcome });
          return;
        }
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
      // Sent here, not as an effect, so the held lease's throw reaches the caller.
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
      // Released here, not as an effect, so the held lease's throw reaches the caller.
      if (state.kind === 'attached') {
        state.connection.disconnect();
      }
    },
  };

  /** Takes the chain again when its dial passes now, and otherwise waits in `detached` for the dial to open. */
  function retake(halt: Halt, transition: Transition<LeaseMachine>): void {
    const dial = pickDial(halt.tried);
    if (dial.tryDial(key, halt.haltedBy)) {
      startTake(halt.haltedBy, [], transition);
      return;
    }
    const wait = new AbortController();
    transition.emitState({ kind: 'detached', halt, wait });
    transition.emitSideEffect({ kind: 'waitToHeal', wait, ms: dial.waitMs(key, halt.haltedBy) });
  }

  /** Answers the take's waiting sends with the halted marker, and takes the chain again or waits. */
  function failTake(
    { sends }: Extract<LeaseState, { kind: 'taking' }>,
    halt: Halt,
    transition: Transition<LeaseMachine>,
  ): void {
    for (const message of sends) {
      transition.emitSideEffect({ kind: 'answerHalted', message });
    }
    retake(halt, transition);
  }

  /** Takes the chain again. Its answer is queued, so a release or a send heard during the attach is handled first. */
  function startTake(
    haltedBy: RemoteChainHalt,
    sends: JsonRpcRequest[],
    { emitState, emitSideEffect }: Transition<LeaseMachine>,
  ): void {
    const take: Take = {};
    emitState({ kind: 'taking', take, haltedBy, sends });
    emitSideEffect({ kind: 'take', take });
  }

  // A lease whose take failed since its halt waits on the gate even while the chain is up, since that chain refused
  // this lease and a free join would take it again at once.
  function pickDial(tried: boolean): Pick<ChainRedial, 'tryDial' | 'waitMs'> {
    return tried ? { tryDial: redial.tryDialGate, waitMs: redial.gateWaitMs } : redial;
  }

  function reportHealDefect(error: unknown, message: string): void {
    report.defect(error, { step: 'chain_heal', metric: chainPoolHealMetric, message });
  }
}

function getHealOutcome(found: AttachAnswer['kind']): 'ok' | 'halted' | 'no_transport' {
  switch (found) {
    case 'attached':
      return 'ok';
    case 'halted':
      return 'halted';
    case 'unreachable':
      return 'no_transport';
  }
}
