// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { catchError } from '@dotli/shared/testing';
import { createWindowProvider } from './createWindowProvider.js';
import type { MessageTarget, WindowLike, WindowMessage } from './provider.js';
import { matchInstance } from './testing/matchers.js';

type FakeWindow = {
  posted: { message: unknown; targetOrigin: string; transfer: Transferable[] }[];
} & WindowLike;

function createFakeWindow(): FakeWindow {
  const posted: FakeWindow['posted'] = [];
  return {
    posted,
    postMessage(message, targetOrigin, transfer) {
      posted.push({ message, targetOrigin, transfer });
    },
  };
}

/** A page's message target, driven from the test. */
function createTarget(): MessageTarget & { dispatchEvent(message: WindowMessage): void } {
  const listeners = new Set<(message: WindowMessage) => void>();
  return {
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
    dispatchEvent: message => {
      for (const listener of [...listeners]) {
        listener(message);
      }
    },
  };
}

/** A message with the `source` and `origin` a browser would set. */
function messageFrom(source: unknown, origin: string, data: unknown): WindowMessage {
  return { source, origin, data };
}

describe('createWindowProvider', () => {
  it('As an embedder, I hear only the embedded window at its origin', () => {
    // Given
    const listen = createTarget();
    const frame = createFakeWindow();
    const provider = createWindowProvider({ listen, peer: () => frame, origin: 'https://peer.example' });
    const heard = vi.fn();
    provider.subscribe(heard);
    const bytes = new ArrayBuffer(1);

    // When
    listen.dispatchEvent(messageFrom(createFakeWindow(), 'https://peer.example', bytes));
    listen.dispatchEvent(messageFrom(frame, 'https://evil.example', bytes));

    // Then
    expect(heard).not.toHaveBeenCalled();

    // When
    listen.dispatchEvent(messageFrom(frame, 'https://peer.example', bytes));

    // Then
    expect(heard).toHaveBeenCalledExactlyOnceWith(new Uint8Array(bytes));
  });

  it("As an embedded page, I lock to my parent's first allowed origin and answer only there", () => {
    // Given
    const listen = createTarget();
    const parent = createFakeWindow();
    const provider = createWindowProvider({
      listen,
      peer: () => parent,
      origin: origin => origin.endsWith('.peer.example'),
    });
    const heard = vi.fn();
    provider.subscribe(heard);

    // When
    listen.dispatchEvent(messageFrom(parent, 'https://a.peer.example', new ArrayBuffer(1)));
    listen.dispatchEvent(messageFrom(parent, 'https://b.peer.example', new ArrayBuffer(2)));
    provider.postMessage(new Uint8Array(3));

    // Then
    expect(heard).toHaveBeenCalledTimes(1);
    expect(parent.posted.map(p => p.targetOrigin)).toEqual(['https://a.peer.example']);
  });

  it('As an embedded page, I hear an object from an allowed origin and stay unlocked to that origin', () => {
    // Given
    const listen = createTarget();
    const parent = createFakeWindow();
    const onNotBytes = vi.fn();
    const provider = createWindowProvider({
      listen,
      peer: () => parent,
      origin: origin => origin.endsWith('.peer.example'),
      onNotBytes,
    });
    const heard = vi.fn();
    provider.subscribe(heard);
    const bytes = new ArrayBuffer(1);

    // When
    listen.dispatchEvent(messageFrom(parent, 'https://a.peer.example', { type: 'hello' }));
    const thrown = catchError(() => {
      provider.postMessage(new Uint8Array(1));
    });

    // Then
    expect(onNotBytes).toHaveBeenCalledOnce();
    expect(thrown).toEqual(matchInstance(Error));

    // When
    listen.dispatchEvent(messageFrom(parent, 'https://b.peer.example', bytes));
    provider.postMessage(new Uint8Array(2));

    // Then
    expect(heard).toHaveBeenCalledExactlyOnceWith(new Uint8Array(bytes));
    expect(parent.posted.map(p => p.targetOrigin)).toEqual(['https://b.peer.example']);
  });

  it('As an embedded page, I refuse to post before any parent origin is admitted', () => {
    // Given
    const parent = createFakeWindow();
    const provider = createWindowProvider({ listen: createTarget(), peer: () => parent, origin: () => true });

    // When
    const thrown = catchError(() => {
      provider.postMessage(new Uint8Array(1));
    });

    // Then
    expect(thrown).toEqual(matchInstance(Error));
  });

  it("As an embedded page, I answer my parent's first bytes from inside my listener and the answer goes to its origin", () => {
    // Given
    const listen = createTarget();
    const parent = createFakeWindow();
    const provider = createWindowProvider({ listen, peer: () => parent, origin: () => true });
    provider.subscribe(() => {
      provider.postMessage(new Uint8Array(1));
    });

    // When
    listen.dispatchEvent(messageFrom(parent, 'https://parent.example', new ArrayBuffer(1)));

    // Then
    expect(parent.posted.map(p => p.targetOrigin)).toEqual(['https://parent.example']);
  });

  it('As an embedded page, I count objects from my parent and drop them', () => {
    // Given
    const listen = createTarget();
    const parent = createFakeWindow();
    const onNotBytes = vi.fn();
    const provider = createWindowProvider({ listen, peer: () => parent, origin: () => true, onNotBytes });
    const heard = vi.fn();
    provider.subscribe(heard);

    // When
    listen.dispatchEvent(messageFrom(parent, 'https://a.peer.example', { type: 'hello' }));
    listen.dispatchEvent(messageFrom(createFakeWindow(), 'https://a.peer.example', { type: 'stranger' }));

    // Then
    expect(onNotBytes).toHaveBeenCalledTimes(1);
    expect(heard).not.toHaveBeenCalled();
  });

  it('As an embedded page, I hear an object from an origin my predicate rejects and do not count it', () => {
    // Given
    const listen = createTarget();
    const parent = createFakeWindow();
    const onNotBytes = vi.fn();
    createWindowProvider({ listen, peer: () => parent, origin: () => false, onNotBytes });

    // When
    listen.dispatchEvent(messageFrom(parent, 'https://evil.example', {}));

    // Then
    expect(onNotBytes).not.toHaveBeenCalled();
  });

  it('As an embedded page, I hear bytes from an origin my predicate refuses and never deliver them, before or after my lock', () => {
    // Given
    const listen = createTarget();
    const parent = createFakeWindow();
    const provider = createWindowProvider({
      listen,
      peer: () => parent,
      origin: origin => origin.endsWith('.peer.example'),
    });
    const heard = vi.fn();
    provider.subscribe(heard);

    // When my parent speaks the wire from a refused origin
    listen.dispatchEvent(messageFrom(parent, 'https://evil.example', Uint8Array.of(1).buffer));
    const thrown = catchError(() => {
      provider.postMessage(new Uint8Array(1));
    });

    // Then nothing is delivered and nothing is locked
    expect(heard).not.toHaveBeenCalled();
    expect(thrown).toEqual(matchInstance(Error));

    // When my parent locks an allowed origin and then speaks from a refused one
    listen.dispatchEvent(messageFrom(parent, 'https://a.peer.example', Uint8Array.of(2).buffer));
    listen.dispatchEvent(messageFrom(parent, 'https://evil.example', Uint8Array.of(3).buffer));

    // Then only the bytes from the allowed origin are delivered
    expect(heard).toHaveBeenCalledExactlyOnceWith(Uint8Array.of(2));
  });

  it('As an embedded page, I hear bytes from any window at an origin I refuse and report them, before or after my lock, and nothing else', () => {
    // Given
    const listen = createTarget();
    const parent = createFakeWindow();
    const onRefusedOrigin = vi.fn();
    const provider = createWindowProvider({
      listen,
      peer: () => parent,
      origin: origin => origin.endsWith('.peer.example'),
      onRefusedOrigin,
    });
    const heard = vi.fn();
    provider.subscribe(heard);

    // When a stranger frame and the parent speak the wire from refused origins, and the parent sends an object
    listen.dispatchEvent(messageFrom(createFakeWindow(), 'https://evil.example', new ArrayBuffer(1)));
    listen.dispatchEvent(messageFrom(parent, 'https://evil.example', new ArrayBuffer(1)));
    listen.dispatchEvent(messageFrom(parent, 'https://evil.example', { type: 'hello' }));

    // Then only the bytes are reported, under their origin
    expect(onRefusedOrigin.mock.calls).toEqual([['https://evil.example'], ['https://evil.example']]);

    // When the parent locks the origin and another allowed origin speaks
    listen.dispatchEvent(messageFrom(parent, 'https://a.peer.example', new ArrayBuffer(1)));
    listen.dispatchEvent(messageFrom(parent, 'https://b.peer.example', new ArrayBuffer(1)));

    // Then the second origin is refused as well, and only the locked one is heard
    expect(onRefusedOrigin).toHaveBeenLastCalledWith('https://b.peer.example');
    expect(onRefusedOrigin).toHaveBeenCalledTimes(3);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('As an embedded page, I hear a stranger window at an origin I admit and report nothing', () => {
    // Given
    const listen = createTarget();
    const onRefusedOrigin = vi.fn();
    const provider = createWindowProvider({
      listen,
      peer: () => createFakeWindow(),
      origin: () => true,
      onRefusedOrigin,
    });
    const heard = vi.fn();
    provider.subscribe(heard);

    // When
    listen.dispatchEvent(messageFrom(createFakeWindow(), 'https://a.peer.example', new ArrayBuffer(1)));

    // Then
    expect(onRefusedOrigin).not.toHaveBeenCalled();
    expect(heard).not.toHaveBeenCalled();
  });

  it('As an embedder, I post to an embedded window that is gone and am refused', () => {
    // Given
    const provider = createWindowProvider({
      listen: createTarget(),
      peer: () => null,
      origin: 'https://peer.example',
    });

    // When
    const thrown = catchError(() => {
      provider.postMessage(new Uint8Array(1));
    });

    // Then
    expect(thrown).toEqual(matchInstance(Error));
  });

  it('As either side, I post bytes and transfer their buffer', () => {
    // Given
    const frame = createFakeWindow();
    const provider = createWindowProvider({
      listen: createTarget(),
      peer: () => frame,
      origin: 'https://peer.example',
    });
    const data = new Uint8Array(4);
    const { buffer } = data;

    // When
    provider.postMessage(data);

    // Then
    expect(frame.posted).toEqual([{ message: buffer, targetOrigin: 'https://peer.example', transfer: [buffer] }]);
  });

  it('As either side, I post a view into a larger buffer as a copy of its bytes and leave the buffer whole', () => {
    // Given
    const frame = createFakeWindow();
    const provider = createWindowProvider({
      listen: createTarget(),
      peer: () => frame,
      origin: 'https://peer.example',
    });
    const whole = Uint8Array.of(1, 2, 3, 4);

    // When
    provider.postMessage(whole.subarray(1, 3));

    // Then
    const [posted] = frame.posted;
    expect(posted?.message).not.toBe(whole.buffer);
    expect(posted?.message).toEqual(Uint8Array.of(2, 3).buffer);
    expect(posted?.transfer).toEqual([posted?.message]);
  });

  it('As a frame app opened at the top, I check my environment and am not in a correct one, as my own parent', () => {
    // Given
    const page = Object.assign(createTarget(), createFakeWindow());
    const parent = createFakeWindow();
    const atTop = createWindowProvider({ listen: page, peer: () => page, origin: () => true });
    const framed = createWindowProvider({ listen: page, peer: () => parent, origin: () => true });

    // When
    const environments = [atTop.isCorrectEnvironment(), framed.isCorrectEnvironment()];

    // Then
    expect(environments).toEqual([false, true]);
  });

  it('As either side, I dispose and then hear nothing and cannot post', () => {
    // Given
    const listen = createTarget();
    const frame = createFakeWindow();
    const provider = createWindowProvider({ listen, peer: () => frame, origin: 'https://peer.example' });
    const heard = vi.fn();
    provider.subscribe(heard);

    // When
    provider.dispose();
    listen.dispatchEvent(messageFrom(frame, 'https://peer.example', new ArrayBuffer(1)));
    const thrown = catchError(() => {
      provider.postMessage(new Uint8Array(1));
    });

    // Then
    expect(heard).not.toHaveBeenCalled();
    expect(thrown).toEqual(matchInstance(Error));
  });
});
