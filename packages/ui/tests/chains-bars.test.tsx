// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { getActiveChainRoles } from '@dotli/config';
import { ChainsPopover } from '../src/components/shell/ChainsPopover.js';
import { resetNetworkMonitor, setBlockSource } from '../src/network-monitor.js';
import { startNetworkStore } from '../src/state/network.js';
import { renderComponent, resetStores, settle, waitForContent } from './helpers/solid.js';
import { query } from './support.js';
import { nth } from './helpers/nth.js';

const BAR = '[data-block]';

/** happy-dom measures every box as zero, which would skip the slide, so give the marks their module width. */
function stubLayout(): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const isBar = this instanceof HTMLElement && this.dataset['block'] !== undefined;
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
  // The panel is the popover's body, its own chunk.
  const strip = (await waitForContent('chains-popover')).querySelector<HTMLElement>('[data-testid="chains-bars"]');
  if (strip === null) {
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
    expect(strip.hasAttribute('data-sliding')).toBe(true);
    expect(strip.style.transform).toBe('translateX(0)');
    const newest = strip.querySelector<HTMLElement>('[data-block="103"]');
    expect(newest?.hasAttribute('data-new')).toBe(true);
  });

  it('As a user watching a chain, a new bar drops its landing mark once its animation ends', async () => {
    // Given
    const strip = await openPanel();
    await emit(100);
    await emit(101);
    await emit(102);
    await emit(103);
    const newest = query(strip, '[data-block="103"]');
    expect(newest.hasAttribute('data-new')).toBe(true);

    // When
    newest.dispatchEvent(new Event('animationend'));

    // Then
    expect(newest.hasAttribute('data-new')).toBe(false);
  });

  it('As a user opening the panel on a chain with history, nothing slides', async () => {
    // Given
    const strip = await openPanel();

    // When
    await emit(100);
    await emit(101);

    // Then
    expect(strip.hasAttribute('data-sliding')).toBe(false);
  });

  it('As a user watching a chain, the strip always has 48 slots and stubs fill the empty ones', async () => {
    // Given
    const strip = await openPanel();

    // When
    for (let n = 100; n <= 105; n += 1) {
      await emit(n);
    }

    // Then: five bars (the first block only anchors the chain) and 43 stubs.
    expect(strip.children).toHaveLength(48);
    expect(strip.querySelectorAll(BAR)).toHaveLength(5);
    expect(strip.querySelectorAll('[data-testid="chains-bar-stub"]')).toHaveLength(43);
  });

  it('As a user watching a long history, only the newest 48 blocks are shown', async () => {
    // Given
    const strip = await openPanel();

    // When
    for (let n = 100; n <= 160; n += 1) {
      await emit(n);
    }

    // Then
    const marks = [...strip.querySelectorAll<HTMLElement>(BAR)];
    expect(marks).toHaveLength(48);
    expect(marks.at(-1)?.dataset['block']).toBe('160');
    expect(strip.querySelectorAll('[data-testid="chains-bar-stub"]')).toHaveLength(0);
  });
});
