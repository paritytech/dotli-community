import { describe, expect, it, vi } from 'vitest';
import type { MessageTarget } from './frame.js';
import { createProviderPair } from './provider.fake.js';
import { createPortProvider, createWindowProvider, type WindowLike } from './provider.js';

interface FakeWindow extends WindowLike {
  posted: { message: unknown; targetOrigin: string; transfer: Transferable[] }[];
}

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
function createTarget(): MessageTarget & { dispatchEvent(event: Event): boolean } {
  const target = new EventTarget();
  return {
    addEventListener: (type, listener) => {
      target.addEventListener(type, listener as EventListener);
    },
    removeEventListener: (type, listener) => {
      target.removeEventListener(type, listener as EventListener);
    },
    dispatchEvent: event => target.dispatchEvent(event),
  };
}

/** A message event with the `source` and `origin` a browser would set. */
function messageFrom(source: unknown, origin: string, data: unknown): MessageEvent {
  const event = new Event('message');
  Object.defineProperties(event, {
    source: { value: source },
    origin: { value: origin },
    data: { value: data },
  });
  return event as MessageEvent;
}

describe('createWindowProvider', () => {
  it("As the host, I hear only the frame's window at the frame's origin", () => {
    // Given
    const listen = createTarget();
    const frame = createFakeWindow();
    const provider = createWindowProvider({ listen, peer: () => frame, origin: 'https://p.dot.li' });
    const heard = vi.fn();
    provider.subscribe(heard);
    const bytes = new ArrayBuffer(1);

    // When
    listen.dispatchEvent(messageFrom(createFakeWindow(), 'https://p.dot.li', bytes));
    listen.dispatchEvent(messageFrom(frame, 'https://evil.example', bytes));

    // Then
    expect(heard).not.toHaveBeenCalled();

    // When
    listen.dispatchEvent(messageFrom(frame, 'https://p.dot.li', bytes));

    // Then
    expect(heard).toHaveBeenCalledExactlyOnceWith(bytes);
  });

  it("As the iframe, I lock to my parent's first allowed origin and answer only there", () => {
    // Given
    const listen = createTarget();
    const parent = createFakeWindow();
    const provider = createWindowProvider({
      listen,
      peer: () => parent,
      origin: origin => origin.endsWith('.dot.li'),
    });
    const heard = vi.fn();
    provider.subscribe(heard);

    // When
    listen.dispatchEvent(messageFrom(parent, 'https://a.dot.li', new ArrayBuffer(1)));
    listen.dispatchEvent(messageFrom(parent, 'https://b.dot.li', new ArrayBuffer(2)));
    provider.post(new ArrayBuffer(3));

    // Then
    expect(heard).toHaveBeenCalledTimes(1);
    expect(provider.peerOrigin()).toBe('https://a.dot.li');
    expect(parent.posted.map(p => p.targetOrigin)).toEqual(['https://a.dot.li']);
  });

  it('As the iframe, an object from an allowed origin does not lock me to that origin', () => {
    // Given
    const listen = createTarget();
    const parent = createFakeWindow();
    const onNotBytes = vi.fn();
    const provider = createWindowProvider({
      listen,
      peer: () => parent,
      origin: origin => origin.endsWith('.dot.li'),
      onNotBytes,
    });
    const heard = vi.fn();
    provider.subscribe(heard);
    const bytes = new ArrayBuffer(1);

    // When
    listen.dispatchEvent(messageFrom(parent, 'https://a.dot.li', { type: 'hello' }));

    // Then
    expect(onNotBytes).toHaveBeenCalledOnce();
    expect(provider.peerOrigin()).toBeNull();

    // When
    listen.dispatchEvent(messageFrom(parent, 'https://b.dot.li', bytes));

    // Then
    expect(heard).toHaveBeenCalledExactlyOnceWith(bytes);
    expect(provider.peerOrigin()).toBe('https://b.dot.li');
  });

  it('As the iframe, I refuse to post before any parent origin is admitted', () => {
    // Given
    const parent = createFakeWindow();
    const provider = createWindowProvider({ listen: createTarget(), peer: () => parent, origin: () => true });

    // When / Then
    expect(provider.peerOrigin()).toBeNull();
    expect(() => {
      provider.post(new ArrayBuffer(1));
    }).toThrow();
  });

  it('As the iframe, I count objects from my parent and drop them', () => {
    // Given
    const listen = createTarget();
    const parent = createFakeWindow();
    const onNotBytes = vi.fn();
    const provider = createWindowProvider({ listen, peer: () => parent, origin: () => true, onNotBytes });
    const heard = vi.fn();
    provider.subscribe(heard);

    // When
    listen.dispatchEvent(messageFrom(parent, 'https://a.dot.li', { type: 'hello' }));
    listen.dispatchEvent(messageFrom(createFakeWindow(), 'https://a.dot.li', { type: 'stranger' }));

    // Then
    expect(onNotBytes).toHaveBeenCalledTimes(1);
    expect(heard).not.toHaveBeenCalled();
  });

  it('As the iframe, I do not count objects from an origin my predicate rejects', () => {
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

  it('As the iframe, I report bytes from any window at an origin I refuse, before or after my lock, and nothing else', () => {
    // Given
    const listen = createTarget();
    const parent = createFakeWindow();
    const onRefusedOrigin = vi.fn();
    const provider = createWindowProvider({
      listen,
      peer: () => parent,
      origin: origin => origin.endsWith('.dot.li'),
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
    listen.dispatchEvent(messageFrom(parent, 'https://a.dot.li', new ArrayBuffer(1)));
    listen.dispatchEvent(messageFrom(parent, 'https://b.dot.li', new ArrayBuffer(1)));

    // Then the second origin is refused as well, and only the locked one is heard
    expect(onRefusedOrigin).toHaveBeenLastCalledWith('https://b.dot.li');
    expect(onRefusedOrigin).toHaveBeenCalledTimes(3);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('As the iframe, I report nothing for a stranger window at an origin I admit', () => {
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
    listen.dispatchEvent(messageFrom(createFakeWindow(), 'https://a.dot.li', new ArrayBuffer(1)));

    // Then
    expect(onRefusedOrigin).not.toHaveBeenCalled();
    expect(heard).not.toHaveBeenCalled();
  });

  it('As the host, I cannot post to a frame whose window is gone', () => {
    // Given
    const provider = createWindowProvider({
      listen: createTarget(),
      peer: () => null,
      origin: 'https://p.dot.li',
    });

    // When / Then
    expect(() => {
      provider.post(new ArrayBuffer(1));
    }).toThrow();
  });

  it('As either side, I transfer what I post', () => {
    // Given
    const frame = createFakeWindow();
    const provider = createWindowProvider({
      listen: createTarget(),
      peer: () => frame,
      origin: 'https://p.dot.li',
    });
    const data = new ArrayBuffer(4);

    // When
    provider.post(data);

    // Then
    expect(frame.posted).toEqual([{ message: data, targetOrigin: 'https://p.dot.li', transfer: [data] }]);
  });

  it('As either side, I hear nothing after I dispose and cannot post', () => {
    // Given
    const listen = createTarget();
    const frame = createFakeWindow();
    const provider = createWindowProvider({ listen, peer: () => frame, origin: 'https://p.dot.li' });
    const heard = vi.fn();
    provider.subscribe(heard);

    // When
    provider.dispose();
    listen.dispatchEvent(messageFrom(frame, 'https://p.dot.li', new ArrayBuffer(1)));

    // Then
    expect(heard).not.toHaveBeenCalled();
    expect(() => {
      provider.post(new ArrayBuffer(1));
    }).toThrow();
  });

  it('As either side, a listener that disposes me stops the message reaching the others', () => {
    // Given
    const listen = createTarget();
    const frame = createFakeWindow();
    const provider = createWindowProvider({ listen, peer: () => frame, origin: 'https://p.dot.li' });
    const disposing = vi.fn(() => {
      provider.dispose();
    });
    const sibling = vi.fn();
    provider.subscribe(disposing);
    provider.subscribe(sibling);

    // When
    listen.dispatchEvent(messageFrom(frame, 'https://p.dot.li', new ArrayBuffer(1)));

    // Then
    expect(disposing).toHaveBeenCalledOnce();
    expect(sibling).not.toHaveBeenCalled();
  });

  it('As either side, a listener I add after I dispose hears nothing', () => {
    // Given
    const listen = createTarget();
    const frame = createFakeWindow();
    const provider = createWindowProvider({ listen, peer: () => frame, origin: 'https://p.dot.li' });
    provider.dispose();
    const heard = vi.fn();

    // When
    provider.subscribe(heard);
    listen.dispatchEvent(messageFrom(frame, 'https://p.dot.li', new ArrayBuffer(1)));

    // Then
    expect(heard).not.toHaveBeenCalled();
  });

  it('As either side, I stop hearing once I unsubscribe', () => {
    // Given
    const listen = createTarget();
    const frame = createFakeWindow();
    const provider = createWindowProvider({ listen, peer: () => frame, origin: 'https://p.dot.li' });
    const heard = vi.fn();
    const unsubscribe = provider.subscribe(heard);

    // When
    unsubscribe();
    listen.dispatchEvent(messageFrom(frame, 'https://p.dot.li', new ArrayBuffer(1)));

    // Then
    expect(heard).not.toHaveBeenCalled();
  });
});

describe('createPortProvider', () => {
  it('As a worker, I exchange bytes over a port and my peer origin is unknown', async () => {
    // Given
    const { port1, port2 } = new MessageChannel();
    const left = createPortProvider(port1);
    const right = createPortProvider(port2);
    const received = new Promise<ArrayBuffer>(resolve => right.subscribe(resolve));
    const data = new Uint8Array([1, 2, 3]).buffer;

    // When
    left.post(data);

    // Then
    expect([...new Uint8Array(await received)]).toEqual([1, 2, 3]);
    expect(data.byteLength).toBe(0);
    expect(left.peerOrigin()).toBeNull();

    left.dispose();
    right.dispose();
  });

  it('As a worker, a listener that disposes me stops the message reaching the others', async () => {
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
    sender.post(new ArrayBuffer(1));
    await disposed;

    // Then
    expect(sibling).not.toHaveBeenCalled();
    sender.dispose();
  });

  it('As a worker, I cannot post after I dispose', () => {
    // Given
    const { port1, port2 } = new MessageChannel();
    const provider = createPortProvider(port1);

    // When
    provider.dispose();
    port2.close();

    // Then
    expect(() => {
      provider.post(new ArrayBuffer(1));
    }).toThrow();
  });

  it('As a worker, I dispose a provider and keep its port open when I own the close', () => {
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
    const data = new ArrayBuffer(8);

    // When
    left.post(data);

    // Then
    expect(() => {
      left.post(data);
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
    left.post(new ArrayBuffer(1));
    await disposed;

    // Then
    expect(sibling).not.toHaveBeenCalled();
  });

  it('As a test, a message posted before its sender closes arrives, and nothing reaches a closed receiver', async () => {
    // Given
    const { left, right } = createProviderPair();
    const heard = vi.fn();
    const arrived = new Promise<ArrayBuffer>(resolve => right.subscribe(resolve));
    right.post(new ArrayBuffer(1));
    left.post(new ArrayBuffer(2));

    // When
    left.dispose();
    left.subscribe(heard);

    // Then left's message arriving means right's earlier one has already reached the closed left
    expect((await arrived).byteLength).toBe(2);
    expect(heard).not.toHaveBeenCalled();
  });

  it('As a test, I get bytes in order on a microtask', async () => {
    // Given
    const { left, right, delivered } = createProviderPair();
    const heard: number[] = [];
    right.subscribe(data => heard.push(data.byteLength));

    // When
    left.post(new ArrayBuffer(1));
    left.post(new ArrayBuffer(2));

    // Then
    expect(heard).toEqual([]);
    await Promise.resolve();
    expect(heard).toEqual([1, 2]);
    expect(delivered).toHaveLength(2);
  });
});
