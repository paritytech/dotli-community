// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { createComponent } from 'solid-js';
import { ToastStack } from '@dotli/ui';
import type { ModalView } from '@dotli/ui-core';
import { byId, byTestId, settle } from '@dotli/ui/testing';
import { createRecordingReporter } from '@dotli/ui-core/testing';
import { createOverlays } from '../../src/overlays/load.js';
import { overlays as pageOverlays, overlaysReady, resetOverlays } from '../helpers/overlays.js';

const { presentModal } = pageOverlays;

const VIEW: ModalView<'no' | 'yes' | 'dismissed'> = {
  title: 'Question',
  fields: [],
  buttons: [
    { label: 'No', variant: 'cancel', result: 'no' },
    { label: 'Yes', variant: 'primary', result: 'yes' },
  ],
  dismissOnBackdrop: true,
  dismissResult: 'dismissed',
  fallbackResult: 'dismissed',
};

afterEach(() => {
  resetOverlays();
  document.body.replaceChildren();
});

describe('overlays loader', () => {
  it('As a dotli user, a dialog renders from the overlays root and settles from its buttons', async () => {
    // Given
    const outcome = presentModal(VIEW);
    await overlaysReady();

    // When: the dialog is portalled into the body, for the top layer.
    byTestId('signing-btn-sign').click();

    // Then
    await expect(outcome).resolves.toEqual({ result: 'yes' });
  });

  it('As a dApp user, answering a dialog whose origin left the page hands focus to the fallback the dialog names', async () => {
    // Given: a dialog asked from a button over the product, naming the product frame as its fallback, and the button
    // then leaves the page.
    const frame = document.createElement('iframe');
    const opener = document.createElement('button');
    document.body.append(frame, opener);
    opener.focus();
    const outcome = presentModal(VIEW, undefined, { focusFallback: () => frame });
    await overlaysReady();
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

  it('As a dotli user, a render error settles the open dialog and lets the overlays recover for what comes next', async () => {
    // Given: overlays whose toast stack throws on its first render, a throw that no dialog's own subtree holds, so
    // nothing Solid recreates on its own would heal it.
    let thrown = false;
    const ThrowingOnce: typeof ToastStack = props => {
      if (!thrown) {
        thrown = true;
        throw new Error('boom');
      }
      return createComponent(ToastStack, props);
    };
    const reporter = createRecordingReporter();
    const overlays = createOverlays({
      load: onBroken =>
        import('../../src/overlays/mount.js').then(({ mountOverlays }) =>
          mountOverlays(onBroken, reporter, { toastStack: ThrowingOnce }),
        ),
      confirm: () => false,
      report: reporter.failure,
    });
    const broken = overlays.presentModal(VIEW);

    // When
    await overlays.ensure();
    await settle();

    // Then
    await expect(broken).resolves.toEqual({ result: 'dismissed' });
    const anError: unknown = expect.any(Error);
    expect(reporter.failures).toContainEqual({
      error: anError,
      context: { flow: 'ui', step: 'root_render', tags: { root: 'overlays' } },
    });

    // When: a dialog queued after the error still renders and settles from its own button, instead of hanging.
    const recovered = overlays.presentModal(VIEW);
    await overlays.ensure();
    await settle();
    byTestId('signing-btn-sign').click();

    // Then
    await expect(recovered).resolves.toEqual({ result: 'yes' });

    // When: a toast pushed after the recovery is shown too.
    overlays.presentToast({
      text: 'After the error',
      label: 'Recovered',
      icon: () => null,
      dismissMs: 0,
    });
    await overlays.ensure();
    await settle();

    // Then
    expect(byTestId('notif-title', byId('overlay-root')).textContent).toBe('Recovered');
    overlays.reset();
  });
});
