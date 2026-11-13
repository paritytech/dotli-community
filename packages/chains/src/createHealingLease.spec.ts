// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import type { JsonRpcMessage, JsonRpcRequest } from '@polkadot-api/json-rpc-provider';
import { bindRecordingSentry, recordReports } from '@dotli/metrics/testing';
import { catchError, createManualTimers, must } from '@dotli/shared/testing';
import { createChainHaltedError } from './createChainHaltedError.js';
import { createChainRedial } from './createChainRedial.js';
import { createHealingLease, type AttachAnswer } from './createHealingLease.js';
import type { ConnectionStatus } from './transportHooks.js';

/**
 * What one `attach` does: take a lease, find no transport, take a lease that halts before it returns, throw, throw
 * while the chain it rebuilt is up, or take a lease while the consumer releases its own.
 */
type AttachStep = 'lease' | 'none' | 'halts' | 'throws' | 'refuses' | 'releases';

type FakeLease = {
  sent: JsonRpcRequest[];
  disconnects: number;
  halt: (error?: unknown) => void;
};

type Params = {
  /** What each `attach` does in turn, a lease once they run out. */
  steps?: AttachStep[];
};

const REQUEST = { jsonrpc: '2.0', id: 1, method: 'chainHead_v1_follow', params: [true] } as const;

describe('createHealingLease', () => {
  it('As a chain consumer, my first lease finds no transport and I hear it thrown', () => {
    // Given
    const { connect } = setup({ steps: ['none'] });

    // When
    const error = catchError(connect);

    // Then
    expect(error).toEqual(new Error('No chain transport for 0xaa'));
  });

  it('As a chain consumer, my first lease halts while it attaches and I get the rebuilt chain without sending', () => {
    // Given
    const { connect, attach } = setup({ steps: ['halts'] });

    // When
    connect();

    // Then
    expect(attach.calls()).toBe(2);
  });

  it('As a chain consumer, my chain halts and my next request goes on the rebuilt chain', () => {
    // Given
    const { connect, attach } = setup();
    const connection = connect();
    must(attach.leases[0], 'first lease').halt();

    // When
    connection.send(REQUEST);

    // Then
    expect(attach.calls()).toBe(2);
    expect(attach.leases.map(l => l.sent)).toEqual([[], [REQUEST]]);
  });

  it('As a chain consumer, my chain halts and I get it back without sending', async () => {
    // Given
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const { connect, attach, timers } = setup();
    connect();

    // When
    must(attach.leases[0], 'first lease').halt();
    await timers.advance(60_000);

    // Then
    expect(attach.leases).toHaveLength(2);
    expect(metrics.counted('chain_pool.heal')).toEqual([{ outcome: 'ok' }]);
  });

  it('As a chain consumer, my chain halts after each rebuild and I ask while its gate is shut and am answered at once', () => {
    // Given the chain halted, was rebuilt at once, and halted again
    const { connect, attach, heard } = setup();
    const connection = connect();
    must(attach.leases[0], 'first lease').halt();
    must(attach.leases[1], 'second lease').halt();

    // When a request and a notification go out
    connection.send({ jsonrpc: '2.0', id: 7, method: 'chainSpec_v1_chainName', params: [] });
    connection.send({ jsonrpc: '2.0', method: 'chainSpec_v1_chainName', params: [] });

    // Then the request is answered with the halted marker, and the notification reaches nothing
    expect(heard).toEqual([{ jsonrpc: '2.0', id: 7, error: createChainHaltedError() }]);
    expect(attach.leases.map(l => l.sent)).toEqual([[], []]);
  });

  it('As a chain consumer, my rebuild finds no transport and I wait for the gate before the next try', async () => {
    // Given
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const { connect, attach, timers } = setup({ steps: ['lease', 'none'] });
    connect();

    // When
    must(attach.leases[0], 'first lease').halt();
    await timers.advance(999);
    const beforeASecond = attach.calls();
    await timers.advance(1);
    const atASecond = attach.calls();

    // Then
    expect([beforeASecond, atASecond]).toEqual([2, 3]);
    expect(metrics.counted('chain_pool.heal')).toEqual([
      { outcome: 'error', reason: 'no_transport' },
      { outcome: 'ok' },
    ]);
  });

  it('As a chain consumer, my rebuild throws and the failure is reported and I try again after the gate', async () => {
    // Given
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const { connect, attach, timers } = setup({ steps: ['lease', 'throws'] });
    connect();

    // When
    must(attach.leases[0], 'first lease').halt();
    await timers.advance(999);
    const beforeASecond = attach.calls();
    await timers.advance(1);
    const atASecond = attach.calls();

    // Then
    expect([beforeASecond, atASecond]).toEqual([2, 3]);
    expect(captured).toMatchObject([{ step: 'chain_heal' }]);
    expect(metrics.counted('chain_pool.heal')).toEqual([{ outcome: 'error', reason: 'Error' }, { outcome: 'ok' }]);
  });

  it('As a chain consumer, my rebuilt chain is up but refuses my lease and I wait for the gate before the next try', async () => {
    // Given
    const { connect, attach, timers } = setup({ steps: ['lease', 'refuses', 'refuses'] });
    connect();

    // When
    must(attach.leases[0], 'first lease').halt();
    await timers.advance(999);
    const beforeASecond = attach.calls();
    await timers.advance(1);
    const atASecond = attach.calls();

    // Then
    expect([beforeASecond, atASecond]).toEqual([2, 3]);
  });

  it('As a chain consumer, my rebuilt chain halts while it attaches and I wait for the gate', async () => {
    // Given
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const { connect, attach, timers } = setup({ steps: ['lease', 'halts'] });
    const connection = connect();

    // When
    must(attach.leases[0], 'first lease').halt();
    connection.send(REQUEST);
    await timers.advance(999);
    const beforeASecond = attach.calls();
    await timers.advance(1);
    const atASecond = attach.calls();

    // Then
    expect([beforeASecond, atASecond]).toEqual([2, 3]);
    expect(metrics.counted('chain_pool.heal')).toEqual([{ outcome: 'error', reason: 'halted' }, { outcome: 'ok' }]);
  });

  it('As a chain consumer, I release my lease while its redial waits and no chain is taken again', async () => {
    // Given the chain halted, was rebuilt at once, and halted again, so the next heal waits 1 s
    const { connect, attach, timers } = setup();
    const connection = connect();
    must(attach.leases[0], 'first lease').halt();
    must(attach.leases[1], 'second lease').halt();

    // When
    connection.disconnect();
    const pendingAfterRelease = timers.countPending();
    await timers.advance(60_000);

    // Then
    expect(pendingAfterRelease).toBe(0);
    expect(attach.calls()).toBe(2);
  });

  it("As a chain consumer, I send while my chain's gate is shut and my sends start no extra redial", () => {
    // Given the chain halted, was rebuilt at once, and halted again
    const { connect, attach, timers } = setup();
    const connection = connect();
    must(attach.leases[0], 'first lease').halt();
    must(attach.leases[1], 'second lease').halt();

    // When
    for (const id of [1, 2, 3]) {
      connection.send({ ...REQUEST, id });
    }

    // Then
    expect(timers.countPending()).toBe(1);
    expect(attach.calls()).toBe(2);
  });

  it('As a chain consumer, my send joins the rebuilt chain while a heal waits, and its halt leaves one wait', () => {
    // Given the chain halted after its rebuild, so a heal waits, and another holder rebuilt it
    const { connect, attach, timers, setStatus } = setup();
    const connection = connect();
    must(attach.leases[0], 'first lease').halt();
    must(attach.leases[1], 'second lease').halt();
    setStatus('connected');

    // When a request joins the rebuilt chain, and that chain halts too
    connection.send(REQUEST);
    setStatus('disconnected');
    must(attach.leases[2], 'joined lease').halt();

    // Then
    expect(timers.countPending()).toBe(1);
    expect(must(attach.leases[2], 'joined lease').sent).toEqual([REQUEST]);
  });

  it('As a chain consumer, a late halt from a lease I already replaced touches nothing', () => {
    // Given the first lease halted and the rebuild gave a second
    const { connect, attach } = setup();
    const connection = connect();
    const first = must(attach.leases[0], 'first lease');
    first.halt();

    // When the first lease's halt is heard again, and a request goes out
    first.halt();
    connection.send(REQUEST);

    // Then
    expect(attach.calls()).toBe(2);
    expect(attach.leases.map(l => l.sent)).toEqual([[], [REQUEST]]);
  });

  it('As a chain consumer, I release my lease while its rebuild attaches and the rebuilt lease is released', () => {
    // Given the chain halted and the next attach releases the consumer's lease before it returns
    const { connect, attach } = setup({ steps: ['lease', 'releases'] });
    const connection = connect();
    must(attach.leases[0], 'first lease').halt();

    // When a request retakes the chain
    connection.send(REQUEST);

    // Then
    expect(attach.leases.map(l => l.disconnects)).toEqual([0, 1]);
  });

  it('As a chain consumer, I release my lease and the lease I hold is released once', () => {
    // Given
    const { connect, attach } = setup();
    const connection = connect();

    // When
    connection.disconnect();
    connection.disconnect();
    connection.send(REQUEST);

    // Then
    expect(attach.leases.map(l => [l.disconnects, l.sent.length])).toEqual([[1, 0]]);
  });
});

function setup({ steps = [] }: Params = {}) {
  const timers = createManualTimers();
  let status: ConnectionStatus = 'disconnected';
  const redial = createChainRedial({ status: () => status, isFrameDown: () => false, timers });
  const heard: JsonRpcMessage[] = [];
  let connection: { disconnect: () => void } | undefined;
  const attach = createFakeAttach(steps, setStatus, () => {
    connection?.disconnect();
  });

  function connect() {
    const lease = createHealingLease({
      key: '0xaa',
      attach: attach.attach,
      redial,
      timers,
      holder: 'spec',
      onMessage: message => {
        heard.push(message);
      },
    });
    connection = lease;
    onTestFinished(() => {
      lease.disconnect();
    });
    return lease;
  }

  return { connect, attach, timers, heard, setStatus };

  function setStatus(next: ConnectionStatus): void {
    status = next;
  }
}

function createFakeAttach(
  steps: AttachStep[],
  setStatus: (status: ConnectionStatus) => void,
  releaseConsumer: () => void,
) {
  const leases: FakeLease[] = [];
  let calls = 0;

  function attach(onHalt: (error?: unknown) => void): AttachAnswer {
    calls += 1;
    const step = steps.shift() ?? 'lease';
    switch (step) {
      case 'none':
        return { kind: 'unreachable' };
      case 'throws':
        throw new Error('transport refused');
      case 'refuses':
        setStatus('connecting');
        throw new Error('transport refused');
      case 'lease':
        return { kind: 'attached', connection: takeLease(onHalt) };
      case 'releases': {
        const connection = takeLease(onHalt);
        releaseConsumer();
        return { kind: 'attached', connection };
      }
      case 'halts':
        return { kind: 'halted', error: undefined };
    }
  }

  function takeLease(onHalt: (error?: unknown) => void) {
    const lease: FakeLease = { sent: [], disconnects: 0, halt: onHalt };
    leases.push(lease);
    return {
      send(message: JsonRpcRequest): void {
        lease.sent.push(message);
      },
      disconnect(): void {
        lease.disconnects += 1;
      },
    };
  }

  return { attach, leases, calls: () => calls };
}
