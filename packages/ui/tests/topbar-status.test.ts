// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindTopbarStatus, topbarActionRoom } from '../src/topbar-status.js';
import { resetStores } from './helpers/solid.js';
import { byId } from './support.js';
import { stubPhoneViewport } from './helpers/viewport.js';

const health = vi.hoisted(() => ({ value: 'idle', listeners: new Set<() => void>() }));
vi.mock('../src/state/network-health.js', () => ({
  initNetworkHealth: () => () => {},
  networkHealthStore: {
    get: () => health.value,
    initial: 'idle',
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
    expect(bar.dataset['tone']).toBe('idle');

    // When
    setHealth('err');

    // Then
    expect(bar.dataset['tone']).toBe('err');
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

  it('As a popover dropping from the pill, I read its box at rest, not a frame of a fold or reveal', () => {
    // Given
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1440);
    const bar = document.createElement('header');
    const rect = vi.spyOn(bar, 'getBoundingClientRect').mockReturnValue(new DOMRect(340, 12, 760, 60));
    // The bar's own transitions, running while it morphs.
    vi.spyOn(bar, 'getAnimations').mockImplementation(
      () => [{ transitionProperty: 'width' }] as unknown as Animation[],
    );
    unbind = bindTopbarStatus(bar);

    // When: the bar folds, a frame of its morph, then the capsule at rest
    bar.setAttribute('data-hidden', '');
    bar.dispatchEvent(new Event('transitionrun'));
    rect.mockReturnValue(new DOMRect(500, 8, 440, 30));
    window.dispatchEvent(new Event('resize'));
    rect.mockReturnValue(new DOMRect(660, 4, 120, 8));
    bar.dispatchEvent(new Event('transitionend'));

    // Then: the pill's box stays, the one it reveals to
    expect(document.documentElement.style.getPropertyValue('--topbar-inline-end')).toBe('340px');

    // When: it reveals wider
    bar.removeAttribute('data-hidden');
    bar.dispatchEvent(new Event('transitionrun'));
    rect.mockReturnValue(new DOMRect(400, 10, 600, 50));
    window.dispatchEvent(new Event('resize'));

    // Then
    expect(document.documentElement.style.getPropertyValue('--topbar-inline-end')).toBe('340px');

    // When: the reveal ends
    rect.mockReturnValue(new DOMRect(300, 12, 840, 60));
    bar.dispatchEvent(new Event('transitionend'));

    // Then
    expect(document.documentElement.style.getPropertyValue('--topbar-inline-end')).toBe('300px');
    expect(document.documentElement.style.getPropertyValue('--topbar-bottom')).toBe('72px');
  });

  it('As a popover dropping from the pill, I still read its box when a morph ended without its event', () => {
    // Given: a fold that started and was dropped without a transitionend or transitioncancel
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1440);
    const bar = document.createElement('header');
    const rect = vi.spyOn(bar, 'getBoundingClientRect').mockReturnValue(new DOMRect(340, 12, 760, 60));
    vi.spyOn(bar, 'getAnimations').mockReturnValue([]);
    unbind = bindTopbarStatus(bar);
    bar.dispatchEvent(new Event('transitionrun'));

    // When: the window resizes with the bar at rest
    rect.mockReturnValue(new DOMRect(300, 12, 840, 60));
    window.dispatchEvent(new Event('resize'));

    // Then
    expect(document.documentElement.style.getPropertyValue('--topbar-inline-end')).toBe('300px');
  });

  it('As a screen reader user, I hear when I go offline, and the line clears when I am back', () => {
    // Given
    const bar = document.createElement('header');
    bar.innerHTML = '<span id="topbar-offline" role="status"></span>';
    unbind = bindTopbarStatus(bar);
    const status = bar.querySelector('#topbar-offline');

    // When
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    window.dispatchEvent(new Event('offline'));

    // Then
    expect(status?.textContent).toBe('You are offline');

    // When
    onLine.mockReturnValue(true);
    window.dispatchEvent(new Event('online'));

    // Then
    expect(status?.textContent).toBe('');
  });

  it('As the page, an unchanged pill box leaves the root style alone', () => {
    // Given
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1440);
    const bar = document.createElement('header');
    vi.spyOn(bar, 'getBoundingClientRect').mockReturnValue(new DOMRect(340, 12, 760, 60.4));
    unbind = bindTopbarStatus(bar);
    const write = vi.spyOn(document.documentElement.style, 'setProperty');

    // When
    window.dispatchEvent(new Event('resize'));

    // Then
    expect(write).not.toHaveBeenCalled();
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

  it('As the action group, my room is the pill max width less the rest of its row, the address included', () => {
    // Given: a pill whose max width is 700, with a 600 px row of which the group takes 200
    document.body.innerHTML = `<header id="topbar" style="max-width: 700px"><div id="row"><div id="topbar-url"></div><div id="group"></div></div></header>`;
    const group = byId('group');
    vi.spyOn(group, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 44));
    vi.spyOn(byId('row'), 'scrollWidth', 'get').mockReturnValue(600);

    // When
    const room = topbarActionRoom(group);

    // Then
    expect(room).toBe(300);
    document.body.replaceChildren();
  });

  it('As the action group hydrated inside an island wrapper, my room is still measured against the pill row', () => {
    // Given: the island wraps the group in a box-less element, as Astro does
    document.body.innerHTML = `<header id="topbar" style="max-width: 700px"><div id="row"><div id="topbar-url"></div><astro-island style="display: contents"><div id="group"></div></astro-island></div></header>`;
    const group = byId('group');
    vi.spyOn(group, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 44));
    vi.spyOn(byId('row'), 'scrollWidth', 'get').mockReturnValue(600);

    // When
    const room = topbarActionRoom(group);

    // Then
    expect(room).toBe(300);
    document.body.replaceChildren();
  });

  it('As the action group on a phone, my room is my own width, as I fill the bar in place of the address', () => {
    // Given: a pill row with room to spare, on a phone-wide viewport
    stubPhoneViewport(true);
    document.body.innerHTML = `<header id="topbar" style="max-width: 700px"><div id="row"><div id="topbar-url"></div><div id="group"></div></div></header>`;
    vi.spyOn(byId('group'), 'clientWidth', 'get').mockReturnValue(310);

    // When
    const room = topbarActionRoom(byId('group'));

    // Then
    expect(room).toBe(310);
    document.body.replaceChildren();
  });
});
