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
