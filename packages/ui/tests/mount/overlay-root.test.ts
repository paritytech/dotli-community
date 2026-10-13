// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it } from 'vitest';
import { ensureOverlayRoot } from '../../src/mount/overlay-root.js';

describe('ensureOverlayRoot', () => {
  beforeEach(() => {
    document.body.innerHTML = '<main></main>';
  });

  it('As a dotli user, toasts and modals stack above the page from one container, made once as the last child of body', () => {
    // Given the page's app in the body

    // When the overlays ask for their container twice
    const first = ensureOverlayRoot();
    const second = ensureOverlayRoot();

    // Then
    expect(first).toBe(second);
    expect(first.id).toBe('overlay-root');
    expect(document.body.lastElementChild).toBe(first);
    expect(document.querySelectorAll('#overlay-root').length).toBe(1);
  });
});
