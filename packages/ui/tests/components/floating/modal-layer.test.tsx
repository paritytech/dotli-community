// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal } from 'solid-js';
import { cleanup } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModalLayer } from '../../../src/components/floating/ModalLayer.js';
import { renderComponent, settle } from '../../helpers/solid.js';
import { byId, byTestId } from '../../support.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function renderLayers(): {
  setFirst: (open: boolean) => void;
  setSecond: (open: boolean) => void;
  dismiss: ReturnType<typeof vi.fn>;
} {
  const [first, setFirst] = createSignal(false);
  const [second, setSecond] = createSignal(false);
  const dismiss = vi.fn();
  const page = document.createElement('main');
  page.id = 'page';
  page.innerHTML = '<button id="behind" type="button">Behind</button>';
  const popover = document.createElement('div');
  popover.id = 'popover';
  popover.setAttribute('popover', 'auto');
  document.body.append(page, popover);
  renderComponent(() => (
    <>
      <ModalLayer open={first()} onDismiss={dismiss} testId="first" label="First" layout="sheet">
        <button id="first-inside" type="button">
          Inside
        </button>
      </ModalLayer>
      <ModalLayer open={second()} onDismiss={() => undefined} testId="second" label="Second" layout="center">
        <button id="second-inside" type="button">
          Inside
        </button>
      </ModalLayer>
    </>
  ));
  return { setFirst, setSecond, dismiss };
}

describe('ModalLayer', () => {
  it('As a user with a layer open, the page behind it is inert, popovers aside, and comes back when it closes', async () => {
    // Given
    const { setFirst } = renderLayers();
    byId('popover').showPopover();

    // When
    setFirst(true);
    await settle();

    // Then
    const frame = byTestId('first-backdrop');
    expect(frame.getAttribute('role')).toBe('dialog');
    expect(frame.getAttribute('aria-modal')).toBe('true');
    expect(frame.hasAttribute('inert')).toBe(false);
    expect(byId('page').hasAttribute('inert')).toBe(true);
    expect(byId('popover').hasAttribute('inert')).toBe(false);
    expect(byId('popover').hasAttribute('data-popover-open')).toBe(false);

    // When
    setFirst(false);
    await settle();

    // Then
    expect(byId('page').hasAttribute('inert')).toBe(false);
  });

  it('As a user with a second layer over the first, only the second answers, and the first does again once it closes', async () => {
    // Given
    const { setFirst, setSecond } = renderLayers();
    setFirst(true);
    await settle();

    // When
    setSecond(true);
    await settle();

    // Then
    expect(byTestId('first-backdrop').hasAttribute('inert')).toBe(true);
    expect(byTestId('second-backdrop').hasAttribute('inert')).toBe(false);
    expect(byTestId('second-backdrop').hasAttribute('data-follows')).toBe(true);

    // When
    setSecond(false);
    await settle();

    // Then
    expect(byTestId('first-backdrop').hasAttribute('inert')).toBe(false);
    expect(byId('page').hasAttribute('inert')).toBe(true);
  });

  it('As a user who clicked off the controls, Escape still dismisses the layer with focus on the body', async () => {
    // Given
    const { setFirst, dismiss } = renderLayers();
    setFirst(true);
    await settle();
    (document.activeElement as HTMLElement | null)?.blur();

    // When
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

    // Then
    expect(dismiss).toHaveBeenCalledTimes(1);
  });
});
