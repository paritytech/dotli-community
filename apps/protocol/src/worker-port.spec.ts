// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { FakePage } from '@dotli/shared/testing';
import { disposeOnPageHide } from './worker-port.js';

function disposable(): { dispose: (reason: Error) => void; reasons: Error[] } {
  const reasons: Error[] = [];
  return {
    dispose: reason => {
      reasons.push(reason);
    },
    reasons,
  };
}

describe("the iframe's end of the worker port", () => {
  it("As a tab's protocol iframe the host removes, I let go of my worker transport so the worker frees my connections at once", () => {
    // Given
    const page = new FakePage();
    const transport = disposable();
    const gone = new Error('gone');
    disposeOnPageHide(page.window, transport, gone);

    // When
    page.hide(false);

    // Then
    expect(transport.reasons).toEqual([gone]);
  });

  it("As a tab's protocol iframe kept in the back-forward cache, I keep my worker transport so I am served when the page comes back", () => {
    // Given
    const page = new FakePage();
    const transport = disposable();
    disposeOnPageHide(page.window, transport, new Error('gone'));

    // When
    page.hide(true);

    // Then
    expect(transport.reasons).toEqual([]);
  });
});
