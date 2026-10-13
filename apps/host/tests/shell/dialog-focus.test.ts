// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host's prompts name the product frame as where their dialogs hand focus back, over the real overlays.

import { afterEach, describe, expect, it } from 'vitest';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { createComponent } from 'solid-js';
import { render } from '@solidjs/web';
import { Overlays } from '@dotli/ui';
import type { ModalView } from '@dotli/ui';
import { appears } from '@dotli/ui/testing';
import { createHostPrompts } from '../../src/page-prompts.js';
import { attachProductFrame } from '../../src/product-frame-layout.js';

const REVIEW: ModalView<'no' | 'yes' | 'dismissed'> = {
  title: 'Question',
  fields: [],
  buttons: [
    { label: 'No', variant: 'cancel', result: 'no' },
    { label: 'Yes', variant: 'primary', result: 'yes' },
  ],
  dismissOnBackdrop: true,
  dismissResult: 'dismissed',
};

let disposeOverlays: (() => void) | undefined;

afterEach(() => {
  disposeOverlays?.();
  disposeOverlays = undefined;
  resetAllStoresForTests();
  document.body.replaceChildren();
});

describe('dialog focus', () => {
  it('As a dApp user, answering a dialog whose origin left the page hands focus to the product frame', async () => {
    // Given: a dialog asked from a button over the product, and the button then leaves the page.
    const frame = document.createElement('iframe');
    const opener = document.createElement('button');
    document.body.append(frame, opener);
    attachProductFrame(frame, () => undefined);
    const root = document.createElement('div');
    document.body.append(root);
    disposeOverlays = render(() => createComponent(Overlays, {}), root);
    opener.focus();
    const outcome = createHostPrompts().confirmReview(REVIEW, new AbortController().signal);
    const sign = await appears('[data-testid="signing-btn-sign"]');
    opener.remove();

    // When
    const focused = new Promise(resolve => {
      frame.addEventListener('focus', resolve, { once: true });
    });
    sign.click();
    await expect(outcome).resolves.toBe('yes');
    await focused;

    // Then
    expect(document.activeElement).toBe(frame);
  });
});
