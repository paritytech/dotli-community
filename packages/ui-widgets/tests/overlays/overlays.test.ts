// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { createComponent } from 'solid-js';
import { render } from '@solidjs/web';
import { openModal, pushToast, type ModalView } from '@dotli/ui';
import { resetModalsForTests, resetToastsForTests, byTestId, settle } from '@dotli/ui/testing';
import { BellIcon } from '@dotli/ui/icons';
import { Overlays } from '../../src/overlays/Overlays.js';

const VIEW: ModalView<'no' | 'yes' | 'dismissed'> = {
  title: 'Question',
  fields: [],
  buttons: [
    { label: 'No', variant: 'cancel', result: 'no' },
    { label: 'Yes', variant: 'primary', result: 'yes' },
  ],
  dismissOnBackdrop: true,
  dismissResult: 'dismissed',
};

let dispose: (() => void) | undefined;

/** Mounts the overlays as an app does, once. */
async function mountOverlays(): Promise<void> {
  const root = document.createElement('div');
  document.body.append(root);
  dispose = render(() => createComponent(Overlays, {}), root);
  await settle();
}

afterEach(() => {
  dispose?.();
  dispose = undefined;
  resetModalsForTests();
  resetToastsForTests();
  document.body.replaceChildren();
});

describe('overlays', () => {
  it('As a dotli user, a toast and a dialog raised before the overlays mount show once they do, and the dialog settles', async () => {
    // Given
    pushToast({ text: 'Get the desktop app', label: 'Polkadot Desktop', icon: BellIcon, dismissMs: 0 });
    const outcome = openModal(VIEW);

    // When
    await mountOverlays();
    byTestId('signing-btn-sign').click();

    // Then
    expect(byTestId('notif-title').textContent).toBe('Polkadot Desktop');
    await expect(outcome).resolves.toEqual({ result: 'yes' });
  });

  it('As a dApp user, answering a dialog whose origin left the page hands focus to the fallback the dialog names', async () => {
    // Given: a dialog asked from a button over the product, naming the product frame as its fallback, and the button
    // then leaves the page.
    const frame = document.createElement('iframe');
    const opener = document.createElement('button');
    document.body.append(frame, opener);
    opener.focus();
    await mountOverlays();
    const outcome = openModal(VIEW, undefined, { focusFallback: () => frame });
    await settle();
    opener.remove();

    // When
    const focused = new Promise(resolve => {
      frame.addEventListener('focus', resolve, { once: true });
    });
    byTestId('signing-btn-sign').click();
    await expect(outcome).resolves.toEqual({ result: 'yes' });
    await focused;

    // Then
    expect(document.activeElement).toBe(frame);
  });
});
