// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createFakePage } from '@dotli/shared/testing';

import { disposeOnPageHide } from './disposeOnPageHide.js';

describe('disposeOnPageHide', () => {
  it('As a frame whose page is hidden for good twice, I dispose what I hold once', () => {
    // Given a frame that disposes on its page's pagehide
    const page = createFakePage();
    let disposals = 0;
    disposeOnPageHide({
      target: page.window,
      dispose: () => {
        disposals += 1;
      },
    });

    // When its page is hidden for good twice
    page.hide(false);
    page.hide(false);

    // Then it disposed once
    expect(disposals).toBe(1);
  });

  it('As a frame whose page enters the back-forward cache, I stay up and dispose nothing', () => {
    // Given a frame that disposes on its page's pagehide
    const page = createFakePage();
    let disposals = 0;
    disposeOnPageHide({
      target: page.window,
      dispose: () => {
        disposals += 1;
      },
    });

    // When its page enters the back-forward cache
    page.hide(true);

    // Then it disposed nothing
    expect(disposals).toBe(0);
  });

  it('As a frame that stopped listening twice, I see my page hidden for good and dispose nothing', () => {
    // Given a frame that disposes on its page's pagehide
    const page = createFakePage();
    let disposals = 0;
    const stop = disposeOnPageHide({
      target: page.window,
      dispose: () => {
        disposals += 1;
      },
    });

    // When it stops listening twice, and its page is then hidden for good
    stop();
    stop();
    page.hide(false);

    // Then it disposed nothing
    expect(disposals).toBe(0);
  });
});
