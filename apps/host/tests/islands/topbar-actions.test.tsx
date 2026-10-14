// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The TopbarActions island against the page's real stores: the topbar's layer tracker and the product frame as the
// focus fallback, which it provides the bar's popovers, menus and sheets. A missing provider would fail silently, so
// these pin the wiring. The views themselves are tested by the TopbarActions, More and ActionGroup story plays.

import { afterEach, describe, expect, it } from 'vitest';
import { flush } from 'solid-js';
import { render, type JSX } from '@solidjs/web';
import { resetAllStoresForTests, untilDom } from '@dotli/shared/testing';
import { TopbarActions } from '../../src/islands/TopbarActions.js';
import { createProductFrameView } from '../../src/product-frame-view.js';
import { anyTopbarSurfaceOpen, topbarSurfaceContains } from '../../src/state/topbar-surfaces.js';
import { byId } from '@dotli/ui/testing';
import { resetViewport, setPhoneViewport } from '../happy-dom.js';

let unmount: (() => void) | undefined;

function mount(island: () => JSX.Element): void {
  const slot = document.createElement('div');
  document.body.append(slot);
  unmount = render(island, slot);
  flush();
}

/** Resolves once the page shows the popover `id` open or closed. */
async function until(id: string, open: boolean): Promise<void> {
  await untilDom(() => (document.getElementById(id)?.hasAttribute('data-open') ?? false) === open);
}

afterEach(() => {
  resetViewport();
  unmount?.();
  unmount = undefined;
  resetAllStoresForTests();
  document.body.replaceChildren();
});

describe('TopbarActions island', () => {
  it('As a dApp user, an open popover of the bar keeps the auto-hiding bar up, and closing it lets the bar go', async () => {
    // Given
    mount(() => <TopbarActions />);

    // When
    byId('chains-button').click();
    await until('chains-popover', true);

    // Then
    expect(anyTopbarSurfaceOpen()).toBe(true);
    expect(topbarSurfaceContains(byId('chains-popover'))).toBe(true);

    // When
    byId('chains-popover').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await until('chains-popover', false);

    // Then
    expect(anyTopbarSurfaceOpen()).toBe(false);
  });

  it('As a phone user, closing a sheet of the bar whose trigger left the page hands focus to the product frame', async () => {
    // Given: the product's frame attached, and a phone-wide page with the bar's network sheet opened
    setPhoneViewport();
    const frame = document.createElement('iframe');
    document.body.append(frame);
    createProductFrameView({
      body: () => document.body,
      container: () => document.body,
      clearScreen: () => undefined,
      hideLoading: () => undefined,
    }).attachFrame(frame);
    mount(() => <TopbarActions />);
    const trigger = byId('chains-button');
    trigger.focus();
    trigger.click();
    await until('chains-popover', true);

    // When: the trigger leaves the page, and the sheet closes
    trigger.remove();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await until('chains-popover', false);

    // Then
    expect(document.activeElement).toBe(frame);
  });
});
