// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindTopbarStatus, topbarActionRoom } from '../src/topbar-status.js';
import { resetStores } from './helpers/solid.js';
import { byId } from './support.js';
import { stubPhoneViewport } from './helpers/viewport.js';

const health = vi.hoisted(() => ({ value: 'syncing', listeners: new Set<() => void>() }));
vi.mock('../src/state/network-health.js', () => ({
  initNetworkHealth: () => () => {},
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

  it('As a menu on the landing page, I keep my own place while the bar is hidden', () => {
    // Given: a hidden bar has no box
    document.documentElement.style.setProperty('--topbar-inline-end', '340px');
    document.documentElement.style.setProperty('--topbar-bottom', '72px');
    const bar = document.createElement('header');
    vi.spyOn(bar, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 0, 0));

    // When
    unbind = bindTopbarStatus(bar);

    // Then: the menus fall back to their own place
    expect(document.documentElement.style.getPropertyValue('--topbar-inline-end')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--topbar-bottom')).toBe('');
  });

  it('As the action group, my room is the same at rest and while the pill morphs', () => {
    // Given: a pill whose max width is 700, with a 300 px address that may shrink to 160
    document.body.innerHTML = `<header id="topbar" style="max-width: 700px"><div id="row"><div id="topbar-url" style="min-width: 160px"></div><div id="group"></div></div></header>`;
    const row = byId('row');
    const url = byId('topbar-url');
    const group = byId('group');
    vi.spyOn(group, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 44));
    const urlWidth = vi.spyOn(url, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 44));
    const scroll = vi.spyOn(row, 'scrollWidth', 'get').mockReturnValue(600);

    // Then: at rest
    expect(topbarActionRoom(group)).toBe(440);

    // When: mid-morph the address is squeezed to its minimum
    urlWidth.mockReturnValue(new DOMRect(0, 0, 160, 44));
    scroll.mockReturnValue(460);

    // Then
    expect(topbarActionRoom(group)).toBe(440);
    document.body.replaceChildren();
  });

  it('As the action group hydrated inside an island wrapper, my room is still measured against the pill row', () => {
    // Given: the island wraps the group in a box-less element, as Astro does
    document.body.innerHTML = `<header id="topbar" style="max-width: 700px"><div id="row"><div id="topbar-url" style="min-width: 160px"></div><astro-island style="display: contents"><div id="group"></div></astro-island></div></header>`;
    const row = byId('row');
    const url = byId('topbar-url');
    const group = byId('group');
    vi.spyOn(group, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 44));
    vi.spyOn(url, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 44));
    vi.spyOn(row, 'scrollWidth', 'get').mockReturnValue(600);

    // Then
    expect(topbarActionRoom(group)).toBe(440);
    document.body.replaceChildren();
  });

  it('As the action group on a phone, I get no room, so every action moves into More', () => {
    // Given: a pill row with room to spare, on a phone-wide viewport
    stubPhoneViewport(true);
    document.body.innerHTML = `<header id="topbar" style="max-width: 700px"><div id="row"><div id="topbar-url" style="min-width: 160px"></div><div id="group"></div></div></header>`;

    // When
    const room = topbarActionRoom(byId('group'));

    // Then
    expect(room).toBe(0);
    document.body.replaceChildren();
  });
});
