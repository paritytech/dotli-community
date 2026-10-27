// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { createComponent } from 'solid-js';
import { render } from '@solidjs/web';
import { modals, type ModalView } from '../../../src/page/state/createModals.js';
import { toasts } from '../../../src/page/state/createToasts.js';
import { byTestId, settle } from '../../../src/testing/index.js';
import { BellIcon } from '../../../src/icons.js';
import { Overlays } from '../../../src/widgets/overlays/Overlays.js';

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
  resetAllStoresForTests();
  document.body.replaceChildren();
});

describe('overlays', () => {
  it('As a dotli user, I get a toast and a dialog raised before the overlays mount and see both once they do, and the dialog settles', async () => {
    // Given a toast and a dialog raised before any overlays exist
    toasts.push({ text: 'Get the desktop app', label: 'Polkadot Desktop', icon: BellIcon, dismissMs: 0 });
    const outcome = modals.open(VIEW);

    // When the overlays mount and the dialog is answered
    await mountOverlays();
    byTestId('prompt-dialog-btn-primary').click();

    // Then
    expect(byTestId('notif-title').textContent).toBe('Polkadot Desktop');
    await expect(outcome).resolves.toEqual({ result: 'yes' });
  });
});
