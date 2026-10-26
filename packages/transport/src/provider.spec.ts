// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { createProviderPair } from './provider.fake.js';
import {
  createPortProvider,
  createWindowProvider,
  type MessageTarget,
  type WindowLike,
  type WindowMessage,
} from './provider.js';

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

  it('As an embedded page, an object from an allowed origin does not lock me to that origin', () => {
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

    // Then
    expect(onNotBytes).toHaveBeenCalledOnce();
    expect(() => {
      provider.postMessage(new Uint8Array(1));
    }).toThrow();

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

    // When / Then
    expect(() => {
      provider.postMessage(new Uint8Array(1));
    }).toThrow();
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

  it('As an embedded page, I do not count objects from an origin my predicate rejects', () => {
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

  it('As an embedded page, I never deliver bytes from an origin my predicate refuses, before or after my lock', () => {
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

    // Then nothing is delivered and nothing is locked
    expect(heard).not.toHaveBeenCalled();
    expect(() => {
      provider.postMessage(new Uint8Array(1));
    }).toThrow();

    // When my parent locks an allowed origin and then speaks from a refused one
    listen.dispatchEvent(messageFrom(parent, 'https://a.peer.example', Uint8Array.of(2).buffer));
    listen.dispatchEvent(messageFrom(parent, 'https://evil.example', Uint8Array.of(3).buffer));

    // Then only the bytes from the allowed origin are delivered
    expect(heard).toHaveBeenCalledExactlyOnceWith(Uint8Array.of(2));
  });

  it('As an embedded page, I report bytes from any window at an origin I refuse, before or after my lock, and nothing else', () => {
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

  it('As an embedded page, I report nothing for a stranger window at an origin I admit', () => {
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

  it('As an embedder, I cannot post to an embedded window that is gone', () => {
    // Given
    const provider = createWindowProvider({
      listen: createTarget(),
      peer: () => null,
      origin: 'https://peer.example',
    });

    // When / Then
    expect(() => {
      provider.postMessage(new Uint8Array(1));
    }).toThrow();
  });

  it('As either side, I transfer what I post', () => {
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

  it('As a frame app opened at the top, I am my own parent and not in a correct environment', () => {
    // Given
    const page = Object.assign(createTarget(), createFakeWindow());
    const parent = createFakeWindow();

    // When
    const atTop = createWindowProvider({ listen: page, peer: () => page, origin: () => true });
    const framed = createWindowProvider({ listen: page, peer: () => parent, origin: () => true });

    // Then
    expect(atTop.isCorrectEnvironment()).toBe(false);
    expect(framed.isCorrectEnvironment()).toBe(true);
  });

  it('As either side, I hear nothing after I dispose and cannot post', () => {
    // Given
    const listen = createTarget();
    const frame = createFakeWindow();
    const provider = createWindowProvider({ listen, peer: () => frame, origin: 'https://peer.example' });
    const heard = vi.fn();
    provider.subscribe(heard);

    // When
    provider.dispose();
    listen.dispatchEvent(messageFrom(frame, 'https://peer.example', new ArrayBuffer(1)));

    // Then
    expect(heard).not.toHaveBeenCalled();
    expect(() => {
      provider.postMessage(new Uint8Array(1));
    }).toThrow();
  });

  it('As either side, a listener that disposes me stops the message reaching the others', () => {
    // Given
    const listen = createTarget();
    const frame = createFakeWindow();
    const provider = createWindowProvider({ listen, peer: () => frame, origin: 'https://peer.example' });
    const disposing = vi.fn(() => {
      provider.dispose();
    });
    const sibling = vi.fn();
    provider.subscribe(disposing);
    provider.subscribe(sibling);

    // When
    listen.dispatchEvent(messageFrom(frame, 'https://peer.example', new ArrayBuffer(1)));

    // Then
    expect(disposing).toHaveBeenCalledOnce();
    expect(sibling).not.toHaveBeenCalled();
  });

  it('As either side, a listener I add after I dispose hears nothing', () => {
    // Given
    const listen = createTarget();
    const frame = createFakeWindow();
    const provider = createWindowProvider({ listen, peer: () => frame, origin: 'https://peer.example' });
    provider.dispose();
    const heard = vi.fn();

    // When
    provider.subscribe(heard);
    listen.dispatchEvent(messageFrom(frame, 'https://peer.example', new ArrayBuffer(1)));

    // Then
    expect(heard).not.toHaveBeenCalled();
  });

  it('As either side, I stop hearing once I unsubscribe', () => {
    // Given
    const listen = createTarget();
    const frame = createFakeWindow();
    const provider = createWindowProvider({ listen, peer: () => frame, origin: 'https://peer.example' });
    const heard = vi.fn();
    const unsubscribe = provider.subscribe(heard);

    // When
    unsubscribe();
    listen.dispatchEvent(messageFrom(frame, 'https://peer.example', new ArrayBuffer(1)));

    // Then
    expect(heard).not.toHaveBeenCalled();
  });
});

describe('createPortProvider', () => {
  it('As a port owner, I exchange bytes over a port in a correct environment and transfer them', async () => {
    // Given
    const { port1, port2 } = new MessageChannel();
    const left = createPortProvider(port1);
    const right = createPortProvider(port2);
    const received = new Promise<Uint8Array>(resolve => right.subscribe(resolve));
    const data = new Uint8Array([1, 2, 3]);

    // When
    left.postMessage(data);

    // Then
    expect([...(await received)]).toEqual([1, 2, 3]);
    expect(data.byteLength).toBe(0);
    expect(left.isCorrectEnvironment()).toBe(true);

    left.dispose();
    right.dispose();
  });

  it('As a port owner, a listener that disposes me stops the message reaching the others', async () => {
    // Given
    const { port1, port2 } = new MessageChannel();
    const provider = createPortProvider(port1);
    const sender = createPortProvider(port2);
    const sibling = vi.fn();
    const disposed = new Promise<void>(resolve => {
      provider.subscribe(() => {
        provider.dispose();
        resolve();
      });
    });
    provider.subscribe(sibling);

    // When
    sender.postMessage(new Uint8Array(1));
    await disposed;

    // Then
    expect(sibling).not.toHaveBeenCalled();
    sender.dispose();
  });

  it('As a port owner, I cannot post after I dispose', () => {
    // Given
    const { port1, port2 } = new MessageChannel();
    const provider = createPortProvider(port1);

    // When
    provider.dispose();
    port2.close();

    // Then
    expect(() => {
      provider.postMessage(new Uint8Array(1));
    }).toThrow();
  });

  it('As a port owner, I dispose a provider and keep its port open when I own the close', () => {
    // Given a port provider that leaves closing to its owner, and one that does not
    const { port1, port2 } = new MessageChannel();
    const close1 = vi.spyOn(port1, 'close');
    const close2 = vi.spyOn(port2, 'close');
    const kept = createPortProvider(port1, { closeOnDispose: false });
    const closed = createPortProvider(port2);

    // When both are disposed
    kept.dispose();
    closed.dispose();

    // Then only the default one closed its port
    expect(close1).not.toHaveBeenCalled();
    expect(close2).toHaveBeenCalledTimes(1);
    port1.close();
  });
});

describe('createProviderPair', () => {
  it('As a test, I see a reused buffer fail as in a browser', () => {
    // Given
    const { left } = createProviderPair();
    const data = new Uint8Array(8);

    // When
    left.postMessage(data);

    // Then
    expect(() => {
      left.postMessage(data);
    }).toThrow();
  });

  it('As a test, a listener that disposes its side stops the message reaching the others', async () => {
    // Given
    const { left, right } = createProviderPair();
    const sibling = vi.fn();
    const disposed = new Promise<void>(resolve => {
      right.subscribe(() => {
        right.dispose();
        resolve();
      });
    });
    right.subscribe(sibling);

    // When
    left.postMessage(new Uint8Array(1));
    await disposed;

    // Then
    expect(sibling).not.toHaveBeenCalled();
  });

  it('As a test, a message posted before its sender closes arrives, and nothing reaches a closed receiver', async () => {
    // Given
    const { left, right } = createProviderPair();
    const heard = vi.fn();
    const arrived = new Promise<Uint8Array>(resolve => right.subscribe(resolve));
    right.postMessage(new Uint8Array(1));
    left.postMessage(new Uint8Array(2));

    // When
    left.dispose();
    left.subscribe(heard);

    // Then left's message arriving means right's earlier one has already reached the closed left
    expect((await arrived).byteLength).toBe(2);
    expect(heard).not.toHaveBeenCalled();
  });

  it('As a test, I get bytes in order on a microtask, in a correct environment', async () => {
    // Given
    const { left, right, delivered } = createProviderPair();
    const heard: number[] = [];
    right.subscribe(message => heard.push(message.byteLength));

    // When
    left.postMessage(new Uint8Array(1));
    left.postMessage(new Uint8Array(2));

    // Then
    expect(heard).toEqual([]);
    await Promise.resolve();
    expect(heard).toEqual([1, 2]);
    expect(delivered).toHaveLength(2);
    expect([left.isCorrectEnvironment(), right.isCorrectEnvironment()]).toEqual([true, true]);
  });
});
