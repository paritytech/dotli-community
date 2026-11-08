// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignal, flush, onCleanup } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { bindCaptureSink } from '@dotli/metrics';
import { waitForDom } from '@dotli/shared/testing';
import { settle } from '../../src/testing/settle.js';
import { mountRoot } from '../../src/mount/root.js';

const failure = vi.fn();
bindCaptureSink({ exception: failure, expected: vi.fn() });

describe('mountRoot', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    failure.mockClear();
  });

  it('As a sub-project, I mount a root and it renders, and its disposer empties the container', async () => {
    // Given a root mounted in its container
    const element = createContainer('a');
    const dispose = mountRoot({ name: 'a', container: element, view: () => <p data-testid="hello">hi</p> });
    await settle();
    const rendered = element.querySelector('[data-testid="hello"]')?.textContent;

    // When
    dispose();

    // Then
    expect(rendered).toBe('hi');
    expect(element.childNodes.length).toBe(0);
  });

  it('As a user, I meet a root whose view throws and it is reported and does not break sibling roots', async () => {
    // Given
    const good = createContainer('good');
    const bad = createContainer('bad');
    mountRoot({ name: 'good', container: good, view: () => <span data-testid="ok">ok</span> });

    // When
    mountRoot({ name: 'bad', container: bad, view: throwBoom });
    await settle();

    // Then
    expect(good.querySelector('[data-testid="ok"]')?.textContent).toBe('ok');
    expect(failure).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'boom' }),
      expect.objectContaining({
        step: 'root_render',
        tags: { root: 'bad' },
      }),
    );
    expect(document.body.contains(good)).toBe(true);
  });

  it('As a sub-project, I dispose a root twice and it runs once, and removeContainer takes the container out', async () => {
    // Given
    const element = createContainer('removable');
    const cleanups = vi.fn();
    const dispose = mountRoot({
      name: 'removable',
      container: element,
      view: () => {
        onCleanup(cleanups);
        return <span>x</span>;
      },
      removeContainer: true,
    });
    await settle();

    // When
    dispose();
    dispose();

    // Then
    expect(cleanups).toHaveBeenCalledTimes(1);
    expect(element.isConnected).toBe(false);
  });

  it('As a sub-project, I mount a root that breaks after it mounted and it is reported once and disposed', async () => {
    // Given a view that throws a new error on every change
    const element = createContainer('late');
    const order: string[] = [];
    let breakAgain = (): void => {};
    function renderBreakable(): JSX.Element {
      const [breaks, setBreaks] = createSignal(0, { ownedWrite: true });
      breakAgain = () => setBreaks(count => count + 1);
      onCleanup(() => order.push('disposed'));
      return [
        <span data-testid="live">live</span>,
        // eslint-disable-next-line solid/reactivity -- a function child is tracked by the renderer, which is the point: it throws on change.
        (): null => {
          if (breaks() > 0) {
            throw new Error(`broke ${String(breaks())}`);
          }
          return null;
        },
      ];
    }
    mountRoot({ name: 'late', container: element, view: renderBreakable, removeContainer: true });
    await settle();
    const liveBeforeBreak = element.querySelector('[data-testid="live"]');

    // When it breaks twice, so Solid runs the fallback twice
    breakAgain();
    flush();
    breakAgain();
    flush();
    await waitForDom(() => !element.isConnected);

    // Then the root is disposed and the break is reported once
    expect(liveBeforeBreak).not.toBeNull();
    expect(order).toEqual(['disposed']);
    expect(failure).toHaveBeenCalledTimes(1);
    expect(failure).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'broke 1' }),
      expect.objectContaining({
        step: 'root_render',
        tags: { root: 'late' },
      }),
    );
  });

  it('As a sub-project, I mount a view that throws on its first render and it is reported once and its root disposed', async () => {
    // Given
    const element = createContainer('broken-at-once');

    // When
    mountRoot({ name: 'broken-at-once', container: element, view: () => <Broken />, removeContainer: true });
    await waitForDom(() => !element.isConnected);

    // Then
    expect(failure).toHaveBeenCalledTimes(1);
    expect(element.isConnected).toBe(false);
  });
});

function createContainer(id: string): HTMLElement {
  const element = document.createElement('div');
  element.id = id;
  document.body.appendChild(element);
  return element;
}

function throwBoom(): JSX.Element {
  throw new Error('boom');
}

function Broken(): JSX.Element {
  throw new Error('render failed');
}
