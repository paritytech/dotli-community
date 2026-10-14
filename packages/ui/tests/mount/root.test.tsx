// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignal, flush, onCleanup } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { bindCaptureSink } from '@dotli/metrics';
import { untilDom } from '@dotli/shared/testing';
import { settle } from '../../src/testing/settle.js';
import { mountRoot } from '../../src/mount/root.js';

const failure = vi.fn();
bindCaptureSink({ exception: failure, expected: vi.fn() });

function container(id: string): HTMLElement {
  const el = document.createElement('div');
  el.id = id;
  document.body.appendChild(el);
  return el;
}

describe('mountRoot', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    failure.mockClear();
  });

  it('As a sub-project, a mounted root renders and its disposer empties the container', async () => {
    // Given
    const el = container('a');

    // When
    const dispose = mountRoot('a', el, () => <p data-testid="hello">hi</p>);
    await settle();

    // Then
    expect(el.querySelector('[data-testid="hello"]')?.textContent).toBe('hi');
    dispose();
    expect(el.childNodes.length).toBe(0);
  });

  it('As a user, a root whose view throws is reported and does not break sibling roots', async () => {
    // Given
    const good = container('good');
    const bad = container('bad');
    mountRoot('good', good, () => <span data-testid="ok">ok</span>);

    // When
    mountRoot('bad', bad, () => {
      throw new Error('boom');
    });
    await settle();

    // Then
    expect(good.querySelector('[data-testid="ok"]')?.textContent).toBe('ok');
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }), {
      flow: 'ui',
      step: 'root_render',
      tags: { root: 'bad' },
    });
    expect(document.body.contains(good)).toBe(true);
  });

  it('As a sub-project, a disposer runs once and removeContainer takes the container out', async () => {
    // Given
    const el = container('removable');
    const cleanups = vi.fn();
    const dispose = mountRoot(
      'removable',
      el,
      () => {
        onCleanup(cleanups);
        return <span>x</span>;
      },
      { removeContainer: true },
    );
    await settle();

    // When
    dispose();
    dispose();

    // Then
    expect(cleanups).toHaveBeenCalledTimes(1);
    expect(el.isConnected).toBe(false);
  });

  it('As a sub-project, a root that breaks after it mounted is reported once and disposed', async () => {
    // Given a view that throws a new error on every change
    const el = container('late');
    const order: string[] = [];
    let breakAgain = (): void => {};
    const view = (): JSX.Element => {
      const [breaks, setBreaks] = createSignal(0, { ownedWrite: true });
      breakAgain = () => setBreaks(n => n + 1);
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
    };
    mountRoot('late', el, view, { removeContainer: true });
    await settle();
    expect(el.querySelector('[data-testid="live"]')).not.toBeNull();

    // When it breaks twice, so Solid runs the fallback twice
    breakAgain();
    flush();
    breakAgain();
    flush();
    await untilDom(() => !el.isConnected);

    // Then the root is disposed and the break is reported once
    expect(order).toEqual(['disposed']);
    expect(failure).toHaveBeenCalledTimes(1);
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ message: 'broke 1' }), {
      flow: 'ui',
      step: 'root_render',
      tags: { root: 'late' },
    });
  });

  it('As a sub-project, a view that throws on its first render is reported once and its root disposed', async () => {
    // Given
    const el = container('broken-at-once');
    const Broken = (): JSX.Element => {
      throw new Error('render failed');
    };

    // When
    mountRoot('broken-at-once', el, () => <Broken />, { removeContainer: true });
    await untilDom(() => !el.isConnected);

    // Then
    expect(failure).toHaveBeenCalledTimes(1);
    expect(el.isConnected).toBe(false);
  });
});
