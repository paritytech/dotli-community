// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host's prompts name the product frame as where their dialogs hand focus back, over the real overlays.

import { describe, expect, it, onTestFinished } from 'vitest';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { createComponent } from 'solid-js';
import { render } from '@solidjs/web';
import type { ModalView } from '@dotli/ui';
import { appears } from '@dotli/ui/testing';
import { Overlays } from '../../src/islands/Overlays.js';
import { createHostPrompts } from '../../src/createHostPrompts.js';
import { productFrameLayout } from '../../src/createProductFrameLayout.js';

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

describe('dialog focus', () => {
  it('As a dApp user, I answer a dialog whose opener left the page and focus goes to the product frame', async () => {
    // Given: a dialog asked from a button over the product, and the button then leaves the page.
    const frame = document.createElement('iframe');
    const opener = document.createElement('button');
    document.body.append(frame, opener);
    productFrameLayout.attach(frame);
    mountOverlays();
    opener.focus();
    const outcome = createHostPrompts().confirmReview({ dialog: REVIEW, signal: new AbortController().signal });
    const sign = await appears('[data-testid="host-prompt-btn-primary"]');
    opener.remove();
    const focused = new Promise(resolve => {
      frame.addEventListener('focus', resolve, { once: true });
    });

    // When
    sign.click();
    const answer = await outcome;
    await focused;

    // Then
    expect(answer).toBe('yes');
    expect(document.activeElement).toBe(frame);
  });
});

/** Renders the page's overlays into the body, torn down with the stores and the body when the case ends. */
function mountOverlays(): void {
  const root = document.createElement('div');
  document.body.append(root);
  const disposeOverlays = render(() => createComponent(Overlays, {}), root);
  onTestFinished(() => {
    disposeOverlays();
    resetAllStoresForTests();
    document.body.replaceChildren();
  });
}
