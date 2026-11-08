// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A halt still ends the lease's in-flight requests and follows, and a request sent while no chain can be had is
// answered with the halted marker, since no follow state survives a rebuild and the consumer has to ask again.

import type { JsonRpcConnection, JsonRpcMessage, JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import { createReporter, defineCount } from '@dotli/metrics';
import type { AsyncTaskPool } from '@dotli/shared';
import { getHaltReason, type RemoteChainHalt } from './chainHaltError.js';
import { createChainHaltedError } from './createChainHaltedError.js';
import type { ChainRedial } from './createChainRedial.js';
import { createJsonRpcError } from './createJsonRpcError.js';

type Params = {
  /** The chain, lowercase. */
  key: string;
  /**
   * Takes a lease on the chain as the pool holds it now, its halt to `onHalt`. Returns null when the pool has no
   * transport for it. Throws what the pool's connect throws.
   */
  attach: (onMessage: (message: JsonRpcMessage) => void, onHalt: (error?: unknown) => void) => JsonRpcConnection | null;
  /** The pool's redial. */
  redial: Pick<ChainRedial, 'noteHalt' | 'tryDial' | 'waitMs' | 'tryDialGate' | 'gateWaitMs'>;
  /** Where each redial waits. */
  waits: Pick<AsyncTaskPool, 'call'>;
  /** The pool name of this lease's own waits, so its heals queue one after another and never hold another lease's. */
  waitPool: string;
  /** The prefix of this lease's log lines. */
  logTag: string;
  /** Names the lease in debug logs. */
  holder: string;
  /** Hears every message of every lease the connection takes, and the answers it gives itself. */
  onMessage: (message: JsonRpcMessage) => void;
};

/** One attach's own state, so a halt heard inside its attach, or late from a replaced lease, touches no other. */
type LeaseSlot = {
  connection: JsonRpcConnection | null;
  haltedBy: RemoteChainHalt | null;
};

/** One detached spell, from a halt until a take holds the chain again. */
type Spell = {
  /** Aborted once a take holds the chain or the lease is released, which cancels the spell's pending wait. */
  ended: AbortController;
  /** Whether the spell tried a take. A take that holds the chain ends the spell, so each one it tried failed. */
  tried: boolean;
};

type AttachOutcome = 'ok' | 'halted' | 'no_transport';

const report = createReporter({ flow: 'protocol' });

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
export function createHealingLease({
  key,
  attach,
  redial,
  waits,
  waitPool,
  logTag,
  holder,
  onMessage,
}: Params): JsonRpcConnection {
  const released = new AbortController();
  let current: JsonRpcConnection | null = null;
  // Why the last lease halted, so the next try waits on that reason's gate.
  let haltedBy: RemoteChainHalt = 'chain';
  // The factory's first take runs in a spell of its own, which a halted first take keeps.
  let spell = createSpell();

  takeFirst();

  return {
    /**
     * Sends on the chain held now, taking it again first when its gate allows, and otherwise answers a request with the
     * halted marker and drops a notification. Throws only as the held lease's `send` throws.
     */
    send(message: JsonRpcRequest): void {
      if (released.signal.aborted) {
        return;
      }
      const connection = current ?? tryHealOnSend();
      if (connection === null) {
        answerHalted(message);
        return;
      }
      connection.send(message);
    },
    /** Releases the lease held now, once, and stops healing. Throws only as that lease's `disconnect` throws. */
    disconnect(): void {
      if (released.signal.aborted) {
        return;
      }
      released.abort();
      spell.ended.abort();
      const connection = current;
      current = null;
      connection?.disconnect();
    },
  };

  function takeFirst(): void {
    const outcome = take();
    switch (outcome) {
      case 'ok':
        return;
      case 'no_transport':
        throw new Error(`No chain transport for ${key}`);
      case 'halted':
        countHeal(outcome);
        schedule();
        return;
    }
  }

  function take(): AttachOutcome {
    spell.tried = true;
    const slot: LeaseSlot = { connection: null, haltedBy: null };
    const connection = attach(onMessage, error => {
      onLeaseHalt(slot, error);
    });
    if (connection === null) {
      return 'no_transport';
    }
    if (slot.haltedBy !== null) {
      noteHalt(slot.haltedBy);
      return 'halted';
    }
    // A release while it attached leaves nothing to keep the new lease.
    if (released.signal.aborted) {
      connection.disconnect();
      return 'ok';
    }
    slot.connection = connection;
    current = connection;
    spell.ended.abort();
    return 'ok';
  }

  function onLeaseHalt(slot: LeaseSlot, error: unknown): void {
    if (slot.haltedBy !== null) {
      return;
    }
    slot.haltedBy = getHaltReason(error);
    // A halt inside `attach` is noted once it returns, and a late one from a replaced lease touches nothing.
    if (slot.connection === null || slot.connection !== current) {
      return;
    }
    current = null;
    spell = createSpell();
    noteHalt(slot.haltedBy);
    schedule();
  }

  function noteHalt(reason: RemoteChainHalt): void {
    haltedBy = reason;
    redial.noteHalt(key, reason);
  }

  // Only a halt and a failed heal schedule, and the wait ends with its spell, so a detached lease has one at a time.
  function schedule(): void {
    const { signal } = spell.ended;
    void waits.call(heal, { pool: waitPool, delay: waitMs(), signal }).catch((error: unknown) => {
      // A take that holds the chain, or a release, cancels the waiting heal, which is no failure.
      if (signal.aborted && error === signal.reason) {
        return;
      }
      reportHealDefect(error, `${logTag} ${holder}'s heal of ${key} failed:`);
    });
  }

  // A heal queued behind one that took the chain, or left after the release, finds the work done.
  function heal(): void {
    if (current !== null || released.signal.aborted) {
      return;
    }
    if (!tryDial()) {
      schedule();
      return;
    }
    if (retake() !== 'ok') {
      schedule();
    }
  }

  // A send tries once and never schedules, since the wait a halt scheduled is still pending.
  function tryHealOnSend(): JsonRpcConnection | null {
    if (!tryDial()) {
      return null;
    }
    retake();
    return current;
  }

  // A spell whose take failed waits on the gate even while the chain is up, since that chain refused this lease and a
  // free join would take it again at once.
  function pickDial(): Pick<ChainRedial, 'tryDial' | 'waitMs'> {
    return spell.tried ? { tryDial: redial.tryDialGate, waitMs: redial.gateWaitMs } : redial;
  }

  function tryDial(): boolean {
    return pickDial().tryDial(key, haltedBy);
  }

  function waitMs(): number {
    return pickDial().waitMs(key, haltedBy);
  }

  function retake(): AttachOutcome | 'error' {
    try {
      const outcome = take();
      countHeal(outcome);
      return outcome;
    } catch (error: unknown) {
      reportHealDefect(error, `${logTag} ${holder} could not take ${key} again:`);
      return 'error';
    }
  }

  function reportHealDefect(error: unknown, message: string): void {
    report.defect(error, { step: 'chain_heal', metric: chainPoolHealMetric, message });
  }

  function countHeal(outcome: AttachOutcome): void {
    report.log.debug(`${logTag} ${key} taken again by ${holder}: ${outcome}`);
    switch (outcome) {
      case 'ok':
        chainPoolHealMetric.count({ outcome: 'ok' });
        return;
      case 'halted':
        chainPoolHealMetric.count({ outcome: 'error', reason: 'halted' });
        return;
      case 'no_transport':
        chainPoolHealMetric.count({ outcome: 'error', reason: 'no_transport' });
        return;
    }
  }

  function createSpell(): Spell {
    return { ended: new AbortController(), tried: false };
  }

  function answerHalted(message: JsonRpcRequest): void {
    // A notification has nothing to answer.
    if (message.id === undefined || message.id === null) {
      return;
    }
    onMessage(createJsonRpcError(message.id, createChainHaltedError()));
  }
}
