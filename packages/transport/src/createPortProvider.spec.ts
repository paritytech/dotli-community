// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { catchError } from '@dotli/shared/testing';
import { matchInstance } from './testing/matchers.js';
import { createPortProvider } from './createPortProvider.js';

describe('createPortProvider', () => {
  it('As a port owner, I exchange bytes over a port in a correct environment and transfer them', async () => {
    // Given
    const { port1, port2 } = new MessageChannel();
    const left = createPortProvider({ port: port1 });
    const right = createPortProvider({ port: port2 });
    onTestFinished(() => {
      left.dispose();
      right.dispose();
    });
    const received = new Promise<Uint8Array>(resolve => right.subscribe(resolve));
    const data = new Uint8Array([1, 2, 3]);

    // When
    left.postMessage(data);
    const message = await received;

    // Then
    expect([...message]).toEqual([1, 2, 3]);
    expect(data.byteLength).toBe(0);
    expect(left.isCorrectEnvironment()).toBe(true);
  });

  it('As a port owner, I post after I dispose and am refused', () => {
    // Given
    const { port1, port2 } = new MessageChannel();
    const provider = createPortProvider({ port: port1 });

    // When
    provider.dispose();
    port2.close();
    const thrown = catchError(() => {
      provider.postMessage(new Uint8Array(1));
    });

    // Then
    expect(thrown).toEqual(matchInstance(Error));
  });

  it('As a port owner, I dispose a provider and keep its port open when I own the close', () => {
    // Given a port provider that leaves closing to its owner, and one that does not
    const { port1, port2 } = new MessageChannel();
    onTestFinished(() => {
      port1.close();
    });
    const close1 = vi.spyOn(port1, 'close');
    const close2 = vi.spyOn(port2, 'close');
    const kept = createPortProvider({ port: port1, closeOnDispose: false });
    const closed = createPortProvider({ port: port2 });

    // When both are disposed
    kept.dispose();
    closed.dispose();

    // Then only the default one closed its port
    expect(close1).not.toHaveBeenCalled();
    expect(close2).toHaveBeenCalledTimes(1);
  });
});
