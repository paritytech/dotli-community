// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The TopbarActions island against the page's real stores: the topbar's layer tracker and the product frame as the
// focus fallback, which it provides the bar's popovers, menus and sheets. A missing provider would fail silently, so
// these pin the wiring. The views themselves are tested by the TopbarActions, More and ActionGroup story plays.

import { afterEach, describe, expect, it } from 'vitest';
import { flush } from 'solid-js';
import { render, type JSX } from '@solidjs/web';
import { resetAllStoresForTests, waitForDom } from '@dotli/shared/testing';
import { TopbarActions } from '../../src/islands/TopbarActions.js';
import { createProductFrameView } from '../../src/createProductFrameView.js';
import { productFrameLayout } from '../../src/createProductFrameLayout.js';
import { topbarSurfaces } from '../../src/state/topbarSurfaces.js';
import { byId } from '@dotli/ui/testing';
import { resetViewport, setPhoneViewport } from '../happyDom.js';

type Params = {
  /** The island to render into a fresh slot. */
  island: () => JSX.Element;
};

let unmount: (() => void) | undefined;

function mount({ island }: Params): void {
  const slot = document.createElement('div');
  document.body.append(slot);
  unmount = render(island, slot);
  flush();
}

/** Resolves once the page shows the popover `id` open or closed. */
async function until(id: string, open: boolean): Promise<void> {
  await waitForDom(() => (document.getElementById(id)?.hasAttribute('data-open') ?? false) === open);
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
    mount({ island: () => <TopbarActions /> });

    // When
    byId('chains-button').click();
    await until('chains-popover', true);

    // Then
    expect(topbarSurfaces.isAnyOpen()).toBe(true);
    expect(topbarSurfaces.contains(byId('chains-popover'))).toBe(true);

    // When
    byId('chains-popover').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await until('chains-popover', false);

    // Then
    expect(topbarSurfaces.isAnyOpen()).toBe(false);
  });

  it('As a phone user, closing a sheet of the bar whose trigger left the page hands focus to the product frame', async () => {
    // Given: the product's frame attached, and a phone-wide page with the bar's network sheet opened
    setPhoneViewport();
    const frame = document.createElement('iframe');
    document.body.append(frame);
    createProductFrameView({
      layout: productFrameLayout,
      body: () => document.body,
      container: () => document.body,
      clearScreen: () => undefined,
      hideLoading: () => undefined,
      setTitle: () => undefined,
    }).attachFrame(frame);
    mount({ island: () => <TopbarActions /> });
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
