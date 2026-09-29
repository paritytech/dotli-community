// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RendererNode } from '@parity/truapi';
import { CustomMessage } from '../../../src/components/chat/CustomMessage.js';
import { renderComponent, settle } from '../../helpers/solid.js';
import { nth } from '../../helpers/nth.js';

interface Sink {
  onUpdate: (node: RendererNode) => void;
  onError: (error: unknown) => void;
}

const service = vi.hoisted(() => ({
  sinks: [] as Sink[],
  stops: 0,
  actions: [] as unknown[],
  actionFails: false,
}));

vi.mock('../../../src/chat/service.js', () => ({
  renderCustomMessage: (_productId: string, _request: unknown, sink: Sink) => {
    service.sinks.push(sink);
    return () => {
      service.stops += 1;
    };
  },
  userTriggerRendererAction: (_productId: string, item: unknown) => {
    service.actions.push(item);
    return service.actionFails ? Promise.reject(new Error('unreachable')) : Promise.resolve();
  },
}));

/** A stand-in IntersectionObserver the test scrolls by hand. */
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

function renderMessage(): ReturnType<typeof renderComponent> {
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
    expect(container.textContent).toBe('Loading…');

    // When
    nth(service.sinks, 0).onUpdate(button('Vote'));
    await settle();

    // Then
    expect(container.querySelector('.chat-custom-placeholder')).toBeNull();
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
    expect(container.textContent).toBe('This message can’t be shown right now.');
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
    expect(container.textContent).toBe('The app could not be reached.');
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

  it('As a user, a message that failed shows again when the product sends a new tree', async () => {
    // Given
    const { container } = renderMessage();
    await settle();
    FakeObserver.last?.scroll(true);
    nth(service.sinks, 0).onError(new Error('render failed'));
    await settle();

    // When
    nth(service.sinks, 0).onUpdate(button('Retry'));
    await settle();

    // Then
    expect(container.querySelector('.chat-custom-placeholder')).toBeNull();
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
