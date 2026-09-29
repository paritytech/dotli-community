// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { getActiveChainRoles } from '@dotli/config';
import { ChainsPopover } from '../src/components/shell/ChainsPopover.js';
import { resetNetworkMonitor, setBlockSource } from '../src/network-monitor.js';
import { startNetworkStore } from '../src/state/network.js';
import { renderComponent, resetStores, settle } from './helpers/solid.js';
import { query } from './support.js';
import { nth } from './helpers/nth.js';

const BAR = '.chains-bar[data-block]';

/**
 * happy-dom does no layout, so every box measures zero and the slide would be
 * skipped for having no distance to travel. Give the marks the width the
 * stylesheet gives them.
 */
function stubLayout(): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const isBar = this.classList.contains('chains-bar');
    return {
      width: isBar ? 4 : 200,
      height: isBar ? 22 : 22,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
  });
}

/** Push a block onto the one chain these tests drive. */
let emit: (blockNumber: number) => Promise<void>;
let stopStore: () => void = () => undefined;

/** Open the panel against a block source the test drives by hand. */
async function openPanel(): Promise<HTMLElement> {
  const relay = nth(getActiveChainRoles(), 0).genesis;
  const emitters = new Map<string, (n: number) => void>();
  emit = async n => {
    const push = emitters.get(relay);
    if (push === undefined) {
      throw new Error('nothing subscribed to the relay');
    }
    push(n);
    await settle();
  };
  setBlockSource({
    isReachable: () => true,
    subscribe: (genesis, onBlock) => {
      emitters.set(genesis, onBlock);
      return () => {
        emitters.delete(genesis);
      };
    },
  });
  stopStore = startNetworkStore();
  renderComponent(() => <ChainsPopover />);
  await settle();
  document.getElementById('chains-button')?.click();
  await settle();
  const strip = document.getElementById('chains-popover')?.querySelector<HTMLElement>('.chains-bars');
  if (strip === null || strip === undefined) {
    throw new Error('the panel rendered no bar strip');
  }
  return strip;
}

beforeEach(() => {
  localStorage.clear();
  stubLayout();
  resetNetworkMonitor();
});

afterEach(() => {
  stopStore();
  resetNetworkMonitor();
  resetStores();
  vi.restoreAllMocks();
});

describe('The network panel blocks arrive as motion', () => {
  it('As a user watching a chain, the newest block sits at the right-hand end', async () => {
    // Given
    const strip = await openPanel();

    // When
    await emit(100);
    await emit(101);
    await emit(102);

    // Then
    const marks = strip.querySelectorAll<HTMLElement>(BAR);
    expect([...marks].map(m => m.dataset['block'])).toEqual(['101', '102']);
    expect(getComputedStyle(strip).flexDirection).not.toBe('row-reverse');
  });

  it('As a user watching a chain, a block already on screen keeps its own bar', async () => {
    // Given
    const strip = await openPanel();
    await emit(100);
    await emit(101);
    await emit(102);
    const first = strip.querySelector<HTMLElement>('[data-block="101"]');

    // When
    await emit(103);

    // Then
    expect(strip.querySelector('[data-block="101"]')).toBe(first);
  });

  it('As a user watching a chain, the strip glides left as the new block appears', async () => {
    // Given
    const strip = await openPanel();
    await emit(100);
    await emit(101);
    await emit(102);

    // When
    await emit(103);

    // Then
    expect(strip.classList.contains('is-sliding')).toBe(true);
    expect(strip.style.transform).toBe('translateX(0)');
    const newest = strip.querySelector<HTMLElement>('[data-block="103"]');
    expect(newest?.classList.contains('is-new')).toBe(true);
  });

  it('As a user watching a chain, a new bar drops its landing mark once its animation ends', async () => {
    // Given
    const strip = await openPanel();
    await emit(100);
    await emit(101);
    await emit(102);
    await emit(103);
    const newest = query(strip, '[data-block="103"]');
    expect(newest.classList.contains('is-new')).toBe(true);

    // When
    newest.dispatchEvent(new Event('animationend'));

    // Then
    expect(newest.classList.contains('is-new')).toBe(false);
  });

  it('As a user opening the panel on a chain with history, nothing slides', async () => {
    // Given
    const strip = await openPanel();

    // When
    await emit(100);
    await emit(101);

    // Then
    expect(strip.classList.contains('is-sliding')).toBe(false);
  });

  it('As a user with a narrow panel, only the newest blocks that fit are shown', async () => {
    // Given: the strip fits (200 + 4) / (4 + 4) = 25 marks.
    const strip = await openPanel();

    // When
    for (let n = 100; n <= 130; n += 1) {
      await emit(n);
    }

    // Then
    const marks = [...strip.querySelectorAll<HTMLElement>(BAR)];
    expect(marks).toHaveLength(25);
    expect(marks.at(-1)?.dataset['block']).toBe('130');
  });
});
