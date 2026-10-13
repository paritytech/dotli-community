// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignal, flush, onCleanup, useContext } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { ReporterContext } from '../../src/components/reporter-context.js';
import { createRecordingReporter } from '@dotli/ui-core/testing';
import type { Reporter, ReportFailure } from '@dotli/ui-core';
import { settle } from '../../src/testing/settle.js';

const failure = vi.fn<ReportFailure>();
const report: Reporter = { ...createRecordingReporter(), failure };

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
    const { mountRoot } = await import('../../src/mount/root.js');
    const el = container('a');

    // When
    const dispose = mountRoot('a', el, () => <p class="hello">hi</p>, { report });
    await settle();

    // Then
    expect(el.querySelector('.hello')?.textContent).toBe('hi');
    dispose();
    expect(el.childNodes.length).toBe(0);
  });

  it('As a user, a root whose view throws is reported through its reporter and does not break sibling roots', async () => {
    // Given
    const { mountRoot } = await import('../../src/mount/root.js');
    const good = container('good');
    const bad = container('bad');
    mountRoot('good', good, () => <span class="ok">ok</span>, { report });

    // When
    mountRoot(
      'bad',
      bad,
      () => {
        throw new Error('boom');
      },
      { report },
    );
    await settle();

    // Then
    expect(good.querySelector('.ok')?.textContent).toBe('ok');
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }), {
      flow: 'ui',
      step: 'root_render',
      tags: { root: 'bad' },
    });
    expect(document.body.contains(good)).toBe(true);
  });

  it('As a surface inside a mounted root, I report through the reporter the mount was given', async () => {
    // Given
    const { mountRoot } = await import('../../src/mount/root.js');
    const el = container('reporting');
    let seen: Reporter | undefined;
    const Surface = (): JSX.Element => {
      seen = useContext(ReporterContext);
      return null;
    };

    // When
    mountRoot('reporting', el, () => <Surface />, { report });
    await settle();

    // Then
    expect(seen).toBe(report);
  });

  it('As a sub-project, a disposer runs once and removeContainer takes the container out', async () => {
    // Given
    const { mountRoot } = await import('../../src/mount/root.js');
    const { disposeAppRoot } = await import('@dotli/ui-core');
    const el = container('removable');
    const cleanups = vi.fn();
    const dispose = mountRoot(
      'removable',
      el,
      () => {
        onCleanup(cleanups);
        return <span>x</span>;
      },
      { report, removeContainer: true },
    );
    await settle();

    // When
    dispose();
    dispose();
    disposeAppRoot('removable');

    // Then
    expect(cleanups).toHaveBeenCalledTimes(1);
    expect(el.isConnected).toBe(false);
  });

  it('As a full-page screen, I take down a root mounted as page content and leave other roots alone', async () => {
    // Given
    const { mountRoot } = await import('../../src/mount/root.js');
    const { disposeContentRoots } = await import('@dotli/ui-core');
    const page = container('content');
    const chrome = container('chrome');
    mountRoot('content', page, () => <span class="page">page</span>, { report, content: true });
    mountRoot('chrome', chrome, () => <span class="chrome">chrome</span>, { report });
    await settle();

    // When
    disposeContentRoots();

    // Then
    expect(page.querySelector('.page')).toBeNull();
    expect(chrome.querySelector('.chrome')?.textContent).toBe('chrome');
  });

  it('As a sub-project, a root that breaks after it mounted is reported once, disposed, then hears onBroken once', async () => {
    // Given a view that throws a new error on every change
    const { mountRoot } = await import('../../src/mount/root.js');
    const el = container('late');
    const order: string[] = [];
    let breakAgain = (): void => {};
    const view = (): JSX.Element => {
      const [breaks, setBreaks] = createSignal(0, { ownedWrite: true });
      breakAgain = () => setBreaks(n => n + 1);
      onCleanup(() => order.push('disposed'));
      return [
        <span class="live">live</span>,
        // eslint-disable-next-line solid/reactivity -- a function child is tracked by the renderer, which is the point: it throws on change.
        (): null => {
          if (breaks() > 0) {
            throw new Error(`broke ${String(breaks())}`);
          }
          return null;
        },
      ];
    };
    const onError = vi.fn(() => {
      order.push(`onError:${String(el.querySelector('.live') !== null)}`);
    });
    const onBroken = vi.fn(() => order.push('onBroken'));
    mountRoot('late', el, view, { report, onError, onBroken });
    await settle();
    expect(el.querySelector('.live')).not.toBeNull();

    // When it breaks twice before the microtask, so Solid runs the fallback
    // twice
    breakAgain();
    flush();
    breakAgain();
    flush();

    // Then onError ran inside the boundary, with the nodes still there, and
    // the rest waits a microtask
    expect(order).toEqual(['onError:true']);
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['onError:true', 'disposed', 'onBroken']);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onBroken).toHaveBeenCalledTimes(1);
    expect(failure).toHaveBeenCalledTimes(1);
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ message: 'broke 1' }), {
      flow: 'ui',
      step: 'root_render',
      tags: { root: 'late' },
    });
  });

  it('As a sub-project, a view that throws on its first render is disposed and hears onBroken once', async () => {
    // Given
    const { mountRoot } = await import('../../src/mount/root.js');
    const { disposeAppRoot } = await import('@dotli/ui-core');
    const el = container('broken-at-once');
    const onBroken = vi.fn();
    const Broken = (): JSX.Element => {
      throw new Error('render failed');
    };

    // When
    mountRoot('broken-at-once', el, () => <Broken />, {
      report,
      onBroken,
      removeContainer: true,
    });
    expect(onBroken).not.toHaveBeenCalled();
    await settle();
    await Promise.resolve();

    // Then
    expect(onBroken).toHaveBeenCalledTimes(1);
    expect(el.isConnected).toBe(false);
    disposeAppRoot('broken-at-once');
    expect(onBroken).toHaveBeenCalledTimes(1);
  });
});
