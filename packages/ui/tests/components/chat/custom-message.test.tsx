// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageSource, RendererNode } from '@parity/truapi';
import { CustomMessage } from '../../../src/components/chat/CustomMessage.js';
import { renderComponent, settle } from '../../helpers/solid.js';
import { nth } from '../../helpers/nth.js';

interface Sink {
  onUpdate: (node: RendererNode) => void;
  onError: (error: unknown) => void;
  onComplete: () => void;
}

const service = vi.hoisted(() => ({
  sinks: [] as Sink[],
  stops: 0,
  actions: [] as unknown[],
  actionFails: false,
  renderFails: false,
  imageLoads: [] as { signal: AbortSignal; resolve: (blob: Blob) => void; reject: (error: Error) => void }[],
}));

vi.mock('../../../src/chat/service.js', () => ({
  render: (_productId: string, _request: unknown, sink: Sink) => {
    service.sinks.push(sink);
    if (service.renderFails) {
      sink.onError(new Error('unreachable'));
    }
    return () => {
      service.stops += 1;
    };
  },
  loadRendererImage: (_productId: string, _source: ImageSource, signal: AbortSignal) =>
    new Promise<Blob>((resolve, reject) => {
      service.imageLoads.push({ signal, resolve, reject });
    }),
  userTriggerRendererAction: (_productId: string, item: unknown) => {
    service.actions.push(item);
    return service.actionFails ? Promise.reject(new Error('unreachable')) : Promise.resolve();
  },
}));

class FakeObserver {
  static last: FakeObserver | undefined;
  disconnected = false;
  private readonly callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    FakeObserver.last = this;
  }
  observe(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
  scroll(isIntersecting: boolean): void {
    this.callback([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

function renderMessage(): { container: HTMLElement; unmount: () => void } {
  return renderComponent(() => (
    <CustomMessage productId="chatty.dot" roomId="main" messageId="m1" messageType="poll" payload="0x01" />
  ));
}

function button(text: string): RendererNode {
  return {
    tag: 'Button',
    value: {
      modifiers: [],
      props: { text, clickAction: 'vote' },
      children: [],
    },
  };
}

beforeEach(() => {
  service.sinks = [];
  service.stops = 0;
  service.actions = [];
  service.actionFails = false;
  service.renderFails = false;
  service.imageLoads = [];
  FakeObserver.last = undefined;
  vi.stubGlobal('IntersectionObserver', FakeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('chat custom message', () => {
  it('As a user, a message subscribes only while it is on screen', async () => {
    // Given
    renderMessage();
    await settle();
    expect(service.sinks).toHaveLength(0);

    // When: it scrolls in.
    FakeObserver.last?.scroll(true);

    // Then
    expect(service.sinks).toHaveLength(1);

    // When: it scrolls out, then in again.
    FakeObserver.last?.scroll(false);
    FakeObserver.last?.scroll(true);

    // Then: the first subscription stopped and a new one started.
    expect(service.stops).toBe(1);
    expect(service.sinks).toHaveLength(2);
  });

  it('As a user, a message shows Loading until the product sends its tree', async () => {
    // Given
    const { container } = renderMessage();
    await settle();
    FakeObserver.last?.scroll(true);
    expect(container.querySelector('[data-testid="chat-custom-placeholder"]')).not.toBeNull();

    // When
    nth(service.sinks, 0).onUpdate(button('Vote'));
    await settle();

    // Then
    expect(container.querySelector('[data-testid="chat-custom-placeholder"]')).toBeNull();
    expect(container.querySelector('button')?.textContent).toBe('Vote');
  });

  it('As a user, a failed render is replaced by a neutral message', async () => {
    // Given
    const { container } = renderMessage();
    await settle();
    FakeObserver.last?.scroll(true);
    nth(service.sinks, 0).onUpdate(button('Vote'));
    await settle();

    // When
    nth(service.sinks, 0).onError(new Error('render failed'));
    await settle();

    // Then
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('[data-testid="chat-custom-placeholder"]')).not.toBeNull();
  });

  it('As a user, a tap the product cannot receive says so', async () => {
    // Given
    service.actionFails = true;
    const { container } = renderMessage();
    await settle();
    FakeObserver.last?.scroll(true);
    nth(service.sinks, 0).onUpdate(button('Vote'));
    await settle();

    // When
    container.querySelector('button')?.click();
    await settle();
    await settle();

    // Then: the action carried the message context.
    expect(service.actions).toEqual([
      {
        context: {
          tag: 'ChatMessage',
          value: { roomId: 'main', messageId: 'm1', messageType: 'poll' },
        },
        actionId: 'vote',
        payload: '0x',
      },
    ]);
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('[data-testid="chat-custom-placeholder"]')).not.toBeNull();
  });

  it('As a user typing in a live message, a streamed update keeps my focus and text', async () => {
    // Given
    const field = (text: string): RendererNode => ({
      tag: 'TextField',
      value: { modifiers: [], props: { text, valueChangeAction: 'typed' } },
    });
    const { container } = renderMessage();
    await settle();
    FakeObserver.last?.scroll(true);
    nth(service.sinks, 0).onUpdate(field(''));
    await settle();
    const input = container.querySelector('input');
    if (input === null) {
      throw new Error('expected an input');
    }
    input.focus();
    input.value = 'hel';

    // When
    nth(service.sinks, 0).onUpdate(field(''));
    await settle();

    // Then
    expect(container.querySelector('input')).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('hel');
  });

  it('ignores callbacks after failure and starts a fresh render after returning onscreen', async () => {
    // Given
    const { container } = renderMessage();
    await settle();
    FakeObserver.last?.scroll(true);
    nth(service.sinks, 0).onError(new Error('render failed'));
    await settle();

    // When
    nth(service.sinks, 0).onUpdate(button('Stale'));
    await settle();
    expect(container.querySelector('button')).toBeNull();
    expect(service.stops).toBe(1);
    FakeObserver.last?.scroll(false);
    FakeObserver.last?.scroll(true);
    nth(service.sinks, 1).onUpdate(button('Retry'));
    await settle();

    // Then
    expect(container.querySelector('[data-testid="chat-custom-placeholder"]')).toBeNull();
    expect(container.querySelector('button')?.textContent).toBe('Retry');
  });

  it('As a user, a message that leaves the page stops its subscription', async () => {
    // Given
    const { unmount } = renderMessage();
    await settle();
    FakeObserver.last?.scroll(true);

    // When
    unmount();

    // Then
    expect(service.stops).toBe(1);
    expect(FakeObserver.last?.disconnected).toBe(true);
  });

  it('As a user, without IntersectionObserver a message subscribes at once', async () => {
    // Given
    vi.stubGlobal('IntersectionObserver', undefined);

    // When
    renderMessage();
    await settle();

    // Then
    expect(service.sinks).toHaveLength(1);
  });
});

describe('custom message resource lifetime', () => {
  const image: RendererNode = {
    tag: 'Image',
    value: { modifiers: [], props: { source: { tag: 'Archive', value: 'icon.png' } } },
  };

  it('rejects stale stream callbacks after scrolling away and retains a completed tree', async () => {
    const { container, unmount } = renderMessage();
    await settle();
    FakeObserver.last?.scroll(true);
    nth(service.sinks, 0).onUpdate(button('First'));
    await settle();
    const detached = container.querySelector('button');
    FakeObserver.last?.scroll(false);
    await settle();
    detached?.click();
    expect(service.actions).toEqual([]);
    FakeObserver.last?.scroll(true);
    nth(service.sinks, 1).onUpdate(button('Second'));
    nth(service.sinks, 0).onUpdate(button('Stale'));
    nth(service.sinks, 0).onError(new Error('old stream'));
    nth(service.sinks, 1).onComplete();
    nth(service.sinks, 1).onUpdate(button('After completion'));
    await settle();
    expect(container.querySelector('button')?.textContent).toBe('Second');
    container.querySelector('button')?.click();
    expect(service.actions).toHaveLength(1);
    unmount();
    FakeObserver.last?.scroll(true);
    expect(service.sinks).toHaveLength(2);
    expect(service.stops).toBe(2);
  });

  it('disposes a subscription that fails synchronously and does not restart while still visible', async () => {
    service.renderFails = true;
    const { container } = renderMessage();
    await settle();
    FakeObserver.last?.scroll(true);
    FakeObserver.last?.scroll(true);
    await settle();
    expect(service.stops).toBe(1);
    expect(service.sinks).toHaveLength(1);
    expect(container.querySelector('[data-testid="chat-custom-placeholder"]')).not.toBeNull();
  });

  it('releases image URLs on replacement, visibility loss and unmount, ignoring late image bytes', async () => {
    const createObjectURL = vi.fn(() => 'blob:message-image');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      'URL',
      class extends URL {
        static override createObjectURL = createObjectURL;
        static override revokeObjectURL = revokeObjectURL;
      },
    );
    const { container, unmount } = renderMessage();
    await settle();
    FakeObserver.last?.scroll(true);
    nth(service.sinks, 0).onUpdate(image);
    await settle();
    const first = nth(service.imageLoads, 0);
    first.resolve(new Blob(['first']));
    await settle();
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:message-image');
    nth(service.sinks, 0).onUpdate(image);
    await settle();
    expect(first.signal.aborted).toBe(true);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    const second = nth(service.imageLoads, 1);
    FakeObserver.last?.scroll(false);
    await settle();
    expect(second.signal.aborted).toBe(true);
    second.resolve(new Blob(['too late']));
    await settle();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(container.querySelector('img')).toBeNull();
    FakeObserver.last?.scroll(true);
    nth(service.sinks, 1).onUpdate(image);
    await settle();
    nth(service.imageLoads, 2).resolve(new Blob(['current']));
    await settle();
    unmount();
    expect(nth(service.imageLoads, 2).signal.aborted).toBe(true);
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it.each(['fetch', 'decode'])('replaces a tree on image %s failure', async failure => {
    const { container } = renderMessage();
    await settle();
    FakeObserver.last?.scroll(true);
    nth(service.sinks, 0).onUpdate(image);
    await settle();
    if (failure === 'fetch') {
      nth(service.imageLoads, 0).reject(new Error('missing'));
    } else {
      container.querySelector('img')?.dispatchEvent(new Event('error'));
    }
    await settle();
    await settle();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-testid="chat-custom-placeholder"]')).not.toBeNull();
    expect(nth(service.imageLoads, 0).signal.aborted).toBe(true);
    expect(service.stops).toBe(1);
  });
});

it('keeps the new tree when an action from its predecessor fails late', async () => {
  service.actionFails = true;
  const { container } = renderMessage();
  await settle();
  FakeObserver.last?.scroll(true);
  nth(service.sinks, 0).onUpdate(button('Before'));
  await settle();
  container.querySelector('button')?.click();
  nth(service.sinks, 0).onUpdate(button('After'));
  await settle();
  await settle();
  expect(container.querySelector('button')?.textContent).toBe('After');
  expect(container.querySelector('[data-testid="chat-custom-placeholder"]')).toBeNull();
  expect(service.stops).toBe(0);
});
