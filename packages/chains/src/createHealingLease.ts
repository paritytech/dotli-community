// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A halt still ends the lease's in-flight requests and follows, and a request sent while no chain can be had is
// answered with the halted marker, since no follow state survives a rebuild and the consumer has to ask again.

import type { JsonRpcConnection, JsonRpcMessage, JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import { createReporter, defineCount } from '@dotli/metrics';
import { createStateMachine, type MachineTypes, type Timers, type Transition } from '@dotli/shared';
import { getHaltReason, type RemoteChainHalt } from './chainHaltError.js';
import { createChainHaltedError } from './createChainHaltedError.js';
import type { ChainRedial, LeaseHalt } from './createChainRedial.js';
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
  redial: ChainRedial;
  /** The timers each wait to heal runs on. */
  timers: Pick<Timers, 'setTimeout' | 'clearTimeout'>;
  /** Names the lease in debug logs. */
  holder: string;
  /** Hears every message of every lease the connection takes, and the answers it gives itself. */
  onMessage: (message: JsonRpcMessage) => void;
};

/** One attach, minted for it, so a halt from an earlier lease finds the state moved on. */
type Take = object;

/** What a take found, or its throw. */
type TakeAnswer = AttachAnswer | { kind: 'threw'; error: unknown };

/**
 * `taking` holds the sends that wait for its take's answer, and the halt it heals. `detached` waits for its dial to open
 * until `wait` aborts. `releasing` is a take released before its answer came.
 */
type LeaseState =
  | { kind: 'taking'; reason: RemoteChainHalt; sends: JsonRpcRequest[] }
  | { kind: 'attached'; take: Take; connection: JsonRpcConnection }
  | { kind: 'detached'; halt: LeaseHalt; wait: AbortController }
  | { kind: 'releasing' }
  | { kind: 'released' };

type LeaseEvent =
  | { kind: 'taken'; take: Take; answer: TakeAnswer }
  | { kind: 'leaseHalted'; take: Take; error: unknown }
  | { kind: 'healDue' }
  | { kind: 'sendAsked'; message: JsonRpcRequest }
  | { kind: 'releaseAsked' };

type LeaseEffect =
  | { kind: 'take' }
  | { kind: 'waitToHeal'; wait: AbortController; ms: number }
  | { kind: 'stopWait'; wait: AbortController }
  | { kind: 'send'; connection: JsonRpcConnection; message: JsonRpcRequest }
  | { kind: 'answerHalted'; message: JsonRpcRequest }
  | { kind: 'disconnect'; connection: JsonRpcConnection }
  | { kind: 'answered'; answer: TakeAnswer };

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

const HEAL_OUTCOMES = { attached: 'ok', halted: 'halted', unreachable: 'no_transport' } as const;

/**
 * A connection that takes the rebuilt chain after a halt. Throws when the first attach finds no transport, or as
 * `attach` throws.
 */
export function createHealingLease({ key, attach, redial, timers, holder, onMessage }: Params): JsonRpcConnection {
  const first: Take = {};
  const answer = attachTake(first);
  if (answer.kind === 'unreachable') {
    throw new Error(`No chain transport for ${key}`);
  }
  const lease = createStateMachine<LeaseMachine>({
    // The first take that holds the chain is no heal, so it counts none. One that halted waits in `taking` only for its
    // queued answer below.
    initial:
      answer.kind === 'attached'
        ? { kind: 'attached', take: first, connection: answer.connection }
        : { kind: 'taking', reason: getHaltReason(answer.error), sends: [] },
    handlers: {
      taking: {
        taken({ reason, sends }, { take, answer: found }, transition) {
          transition.emitSideEffect({ kind: 'answered', answer: found });
          switch (found.kind) {
            case 'attached':
              transition.emitState({ kind: 'attached', take, connection: found.connection });
              for (const message of sends) {
                transition.emitSideEffect({ kind: 'send', connection: found.connection, message });
              }
              return;
            case 'halted': {
              const haltedBy = getHaltReason(found.error);
              redial.noteHalt(key, haltedBy);
              failTake(sends, haltedBy, transition);
              return;
            }
            case 'unreachable':
            case 'threw':
              failTake(sends, reason, transition);
              return;
          }
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
          const reason = getHaltReason(error);
          redial.noteHalt(key, reason);
          retake({ reason, tried: false }, transition);
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
          if (!redial.tryDial(key, halt)) {
            transition.emitSideEffect({ kind: 'answerHalted', message });
            return;
          }
          transition.emitSideEffect({ kind: 'stopWait', wait });
          startTake(halt.reason, [message], transition);
        },
        releaseAsked({ wait }, _event, { emitState, emitSideEffect }) {
          emitState({ kind: 'released' });
          emitSideEffect({ kind: 'stopWait', wait });
        },
      },
      releasing: {
        taken(_state, { answer: found }, { emitState, emitSideEffect }) {
          emitState({ kind: 'released' });
          emitSideEffect({ kind: 'answered', answer: found });
          // A release while it attached leaves nothing to keep the new lease.
          if (found.kind === 'attached') {
            emitSideEffect({ kind: 'disconnect', connection: found.connection });
          }
        },
      },
      released: null,
    },
    onEffect: effect => {
      switch (effect.kind) {
        case 'take': {
          const take: Take = {};
          let found: TakeAnswer;
          try {
            found = attachTake(take);
          } catch (error) {
            found = { kind: 'threw', error };
          }
          lease.update({ kind: 'taken', take, answer: found });
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
        case 'answered': {
          const { answer: found } = effect;
          if (found.kind === 'threw') {
            reportHealDefect(found.error, `${LEASE_TAG} ${holder} could not take ${key} again:`);
            return;
          }
          const outcome = HEAL_OUTCOMES[found.kind];
          report.log.debug(`${LEASE_TAG} ${key} taken again by ${holder}: ${outcome}`);
          chainPoolHealMetric.count(outcome === 'ok' ? { outcome: 'ok' } : { outcome: 'error', reason: outcome });
          return;
        }
      }
    },
    onError: error => {
      reportHealDefect(error, `${LEASE_TAG} ${holder}'s heal of ${key} failed:`);
    },
  });
  // The first take's answer is queued like a retake's, so its halt is counted and followed as one.
  if (answer.kind === 'halted') {
    lease.update({ kind: 'taken', take: first, answer });
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

  /** Attaches a lease whose later halt names `take`. Throws as `attach` throws. */
  function attachTake(take: Take): AttachAnswer {
    // A halt only reaches `onHalt` after the attach returned, so the machine exists by then.
    return attach(onMessage, error => {
      lease.update({ kind: 'leaseHalted', take, error });
    });
  }

  /** Takes the chain again when its dial passes now, and otherwise waits in `detached` for the dial to open. */
  function retake(halt: LeaseHalt, transition: Transition<LeaseMachine>): void {
    if (redial.tryDial(key, halt)) {
      startTake(halt.reason, [], transition);
      return;
    }
    const wait = new AbortController();
    transition.emitState({ kind: 'detached', halt, wait });
    transition.emitSideEffect({ kind: 'waitToHeal', wait, ms: redial.waitMs(key, halt) });
  }

  /** Answers the failed take's waiting sends with the halted marker, and takes the chain again or waits. */
  function failTake(sends: JsonRpcRequest[], reason: RemoteChainHalt, transition: Transition<LeaseMachine>): void {
    for (const message of sends) {
      transition.emitSideEffect({ kind: 'answerHalted', message });
    }
    retake({ reason, tried: true }, transition);
  }

  /** Takes the chain again. Its answer is queued, so a release or a send heard during the attach is handled first. */
  function startTake(
    reason: RemoteChainHalt,
    sends: JsonRpcRequest[],
    { emitState, emitSideEffect }: Transition<LeaseMachine>,
  ): void {
    emitState({ kind: 'taking', reason, sends });
    emitSideEffect({ kind: 'take' });
  }

  function reportHealDefect(error: unknown, message: string): void {
    report.defect(error, { step: 'chain_heal', metric: chainPoolHealMetric, message });
  }
}
