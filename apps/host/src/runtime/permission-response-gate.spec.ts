// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeWireMessage, MESSAGE_TYPE_REQUEST, MESSAGE_TYPE_RESPONSE } from '@parity/truapi';
import { ACCOUNT_REQUEST_LOGIN, PERMISSIONS_REQUEST_DEVICE_PERMISSION } from '@parity/truapi/wire-table';
import { createPermissionResponseGate } from './permission-response-gate.js';

const WAIT_MS = 3_000;

function frame(method: { trait: number; method: number }, messageType: number): Uint8Array {
  const encoded = encodeWireMessage({
    requestId: 'request-1',
    payload: { traitId: method.trait, methodId: method.method, messageType, value: new Uint8Array() },
  });
  if (encoded.isErr()) {
    throw encoded.error;
  }
  return encoded.value;
}

const PERMISSION_ANSWER = frame(PERMISSIONS_REQUEST_DEVICE_PERMISSION, MESSAGE_TYPE_RESPONSE);
// Another method of the permissions trait, such as a remote permission request.
const OTHER_PERMISSION_ANSWER = frame(
  { trait: PERMISSIONS_REQUEST_DEVICE_PERMISSION.trait, method: PERMISSIONS_REQUEST_DEVICE_PERMISSION.method + 1 },
  MESSAGE_TYPE_RESPONSE,
);

afterEach(() => {
  vi.useRealTimers();
});

describe('permission response gate', () => {
  it('As a product, a reload that waits on my permission answer runs once that answer has been forwarded to me', () => {
    // Given
    const gate = createPermissionResponseGate({ signal: new AbortController().signal, timeoutMs: WAIT_MS });
    const reload = vi.fn();
    gate.afterResponse(reload);

    // When other traffic passes first
    gate.forwarded(frame(ACCOUNT_REQUEST_LOGIN, MESSAGE_TYPE_RESPONSE));
    gate.forwarded(frame(PERMISSIONS_REQUEST_DEVICE_PERMISSION, MESSAGE_TYPE_REQUEST));
    gate.forwarded(new Uint8Array([0xff]));

    // Then
    expect(reload).not.toHaveBeenCalled();

    // When
    gate.forwarded(PERMISSION_ANSWER);
    gate.forwarded(PERMISSION_ANSWER);

    // Then
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('As a product, a reload that waits on my device permission answer does not run on a remote permission answer', () => {
    // Given a gate on fake timers, so its pending wait ends with the test
    vi.useFakeTimers();
    const gate = createPermissionResponseGate({ signal: new AbortController().signal, timeoutMs: WAIT_MS });
    const reload = vi.fn();
    gate.afterResponse(reload);

    // When
    gate.forwarded(OTHER_PERMISSION_ANSWER);

    // Then
    expect(reload).not.toHaveBeenCalled();
  });

  it('As a product whose permission answer never arrives, the reload that waited on it runs once the wait is over', () => {
    // Given
    vi.useFakeTimers();
    const gate = createPermissionResponseGate({ signal: new AbortController().signal, timeoutMs: WAIT_MS });
    const reload = vi.fn();
    gate.afterResponse(reload);

    // When
    vi.advanceTimersByTime(WAIT_MS);

    // Then
    expect(reload).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('As a product whose answer arrives in time, the wait leaves no timer behind', () => {
    // Given
    vi.useFakeTimers();
    const gate = createPermissionResponseGate({ signal: new AbortController().signal, timeoutMs: WAIT_MS });
    const reload = vi.fn();
    gate.afterResponse(reload);

    // When
    gate.forwarded(PERMISSION_ANSWER);

    // Then
    expect(reload).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('As a product whose frame is gone, a reload that waited on my answer never runs, even after the wait', () => {
    // Given
    vi.useFakeTimers();
    const frameLifetime = new AbortController();
    const gate = createPermissionResponseGate({ signal: frameLifetime.signal, timeoutMs: WAIT_MS });
    const waiting = vi.fn();
    gate.afterResponse(waiting);

    // When
    frameLifetime.abort();
    const late = vi.fn();
    gate.afterResponse(late);
    gate.forwarded(PERMISSION_ANSWER);
    vi.advanceTimersByTime(WAIT_MS);

    // Then
    expect(waiting).not.toHaveBeenCalled();
    expect(late).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
