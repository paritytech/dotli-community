// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindTopbarStatus } from '../src/topbar-status.js';
import { resetStores } from './helpers/solid.js';

const health = vi.hoisted(() => ({ value: 'syncing', listeners: new Set<() => void>() }));
vi.mock('../src/state/network-health.js', () => ({
  networkHealthStore: {
    get: () => health.value,
    initial: 'syncing',
    subscribe: (listener: () => void) => {
      health.listeners.add(listener);
      return () => health.listeners.delete(listener);
    },
  },
}));

function setHealth(value: string): void {
  health.value = value;
  for (const listener of [...health.listeners]) {
    listener();
  }
}

let unbind: (() => void) | null = null;

afterEach(() => {
  unbind?.();
  unbind = null;
  resetStores();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty('--topbar-inline-end');
  document.documentElement.style.removeProperty('--topbar-bottom');
});

describe('bindTopbarStatus', () => {
  it('As a user glancing at the capsule, its colour follows the network health', () => {
    // Given
    const bar = document.createElement('header');
    unbind = bindTopbarStatus(bar);

    // Then
    expect(bar.dataset['health']).toBe('syncing');

    // When
    setHealth('offline');

    // Then
    expect(bar.dataset['health']).toBe('offline');
  });

  it('As a user with a prompt waiting, the capsule leads with the action dot', async () => {
    // Given
    const bar = document.createElement('header');
    unbind = bindTopbarStatus(bar);
    expect(bar.hasAttribute('data-action')).toBe(false);

    // When
    const { setBlockingModalsWaiting } = await import('../src/state/topbar.js');
    setBlockingModalsWaiting(1);

    // Then
    expect(bar.hasAttribute('data-action')).toBe(true);
  });

  it('As a popover dropping from the pill, I read where the pill ends', () => {
    // Given
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1440);
    const bar = document.createElement('header');
    vi.spyOn(bar, 'getBoundingClientRect').mockReturnValue(new DOMRect(340, 12, 760, 60));

    // When
    unbind = bindTopbarStatus(bar);

    // Then
    expect(document.documentElement.style.getPropertyValue('--topbar-inline-end')).toBe('340px');
    expect(document.documentElement.style.getPropertyValue('--topbar-bottom')).toBe('72px');
  });
});
