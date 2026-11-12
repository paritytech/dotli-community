// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { ACCOUNT_REQUEST_LOGIN, PERMISSIONS_REQUEST_DEVICE_PERMISSION } from '@parity/truapi/wire-table';
import { recordReports } from '@dotli/metrics/testing';
import { createManualTimers } from '@dotli/shared/testing';
import { encodeRequestFrame } from '../testing/encodeRequestFrame.js';
import { encodeResponseFrame } from '../testing/encodeResponseFrame.js';
import { createPermissionResponseGate, PERMISSION_ANSWER_WAIT_MS } from './createPermissionResponseGate.js';

type Params = {
  /** The frame's lifetime, one that never ends by default. */
  signal?: AbortSignal;
  /** The first run held, a spy by default. */
  reload?: () => void;
};

const REQUEST_ID = 'request-1';

const PERMISSION_ANSWER = encodeResponseFrame({
  requestId: REQUEST_ID,
  method: PERMISSIONS_REQUEST_DEVICE_PERMISSION,
  value: new Uint8Array(),
});
// Another method of the permissions trait, such as a remote permission request.
const OTHER_PERMISSION_ANSWER = encodeResponseFrame({
  requestId: REQUEST_ID,
  method: {
    trait: PERMISSIONS_REQUEST_DEVICE_PERMISSION.trait,
    method: PERMISSIONS_REQUEST_DEVICE_PERMISSION.method + 1,
  },
  value: new Uint8Array(),
});

describe('permission response gate', () => {
  it('As a dApp user, I answer a permission prompt and the reload that waited runs once my answer reaches the app', () => {
    // Given
    const { gate, reload } = createWaitingGate();

    // When other traffic passes first, then the answer twice
    gate.noteForwarded(
      encodeResponseFrame({ requestId: REQUEST_ID, method: ACCOUNT_REQUEST_LOGIN, value: new Uint8Array() }),
    );
    gate.noteForwarded(
      encodeRequestFrame({
        requestId: REQUEST_ID,
        method: PERMISSIONS_REQUEST_DEVICE_PERMISSION,
        value: new Uint8Array(),
      }),
    );
    gate.noteForwarded(new Uint8Array([0xff]));
    const runsBeforeAnswer = reload.mock.calls.length;
    gate.noteForwarded(PERMISSION_ANSWER);
    gate.noteForwarded(PERMISSION_ANSWER);

    // Then
    expect({ runsBeforeAnswer, runs: reload.mock.calls.length }).toEqual({ runsBeforeAnswer: 0, runs: 1 });
  });

  it('As a dApp user, I answer a remote permission prompt and the reload waiting on my device permission answer does not run', () => {
    // Given a gate on manual timers, so its pending wait ends with the test
    const { gate, reload } = createWaitingGate();

    // When
    gate.noteForwarded(OTHER_PERMISSION_ANSWER);

    // Then
    expect(reload).not.toHaveBeenCalled();
  });

  it('As a dApp user whose permission answer never arrives, I wait out the limit and the reload that waited on it runs', async () => {
    // Given
    const { timers, reload } = createWaitingGate();

    // When
    await timers.advance(PERMISSION_ANSWER_WAIT_MS);

    // Then
    expect(reload).toHaveBeenCalledTimes(1);
    expect(timers.countPending()).toBe(0);
  });

  it('As a dApp user, I answer in time and the wait leaves no timer behind', () => {
    // Given
    const { gate, timers, reload } = createWaitingGate();

    // When
    gate.noteForwarded(PERMISSION_ANSWER);

    // Then
    expect(reload).toHaveBeenCalledTimes(1);
    expect(timers.countPending()).toBe(0);
  });

  it('As a dApp user who leaves the app, I answer too late and the reload that waited never runs, even after the wait', async () => {
    // Given
    const frameLifetime = new AbortController();
    const { gate, timers, reload: waiting } = createWaitingGate({ signal: frameLifetime.signal });
    const late = vi.fn();

    // When
    frameLifetime.abort();
    gate.runAfterResponse(late);
    gate.noteForwarded(PERMISSION_ANSWER);
    await timers.advance(PERMISSION_ANSWER_WAIT_MS);

    // Then
    expect(waiting).not.toHaveBeenCalled();
    expect(late).not.toHaveBeenCalled();
    expect(timers.countPending()).toBe(0);
  });

  it('As a dApp user, I answer a permission prompt while one waiting reload throws, and the reload after it still runs while the throw is reported', () => {
    // Given
    const reports = recordReports({ onFinished: onTestFinished });
    const { gate, reload } = createWaitingGate({
      reload: () => {
        throw new Error('rebuild failed');
      },
    });
    const second = vi.fn();
    gate.runAfterResponse(second);

    // When
    gate.noteForwarded(PERMISSION_ANSWER);

    // Then
    expect(second).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reports.exceptions).toMatchObject([{ step: 'response_gate_transition' }]);
  });
});

/** A gate on manual timers with one reload waiting on the permission answer. */
function createWaitingGate({ signal = new AbortController().signal, reload: run = () => {} }: Params = {}) {
  const timers = createManualTimers();
  const gate = createPermissionResponseGate({ signal, timers });
  const reload = vi.fn(run);
  gate.runAfterResponse(reload);
  return { gate, timers, reload };
}
